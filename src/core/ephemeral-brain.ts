import type { BrainEngine } from './engine.ts';
import type { PGLiteEngine } from './pglite-engine.ts';
import { SubscriptionAdmissionError } from './ai/subscription-admission.ts';

interface EphemeralBrain { brainId: string; busy: boolean; closed: boolean }
const brains = new WeakMap<BrainEngine, EphemeralBrain>();
const conflict = () => new SubscriptionAdmissionError('subscription_identity_conflict');

/** Closed factory: callers cannot register an existing database as disposable. */
export async function createEphemeralBrain(): Promise<PGLiteEngine> {
  const { PGLiteEngine } = await import('./pglite-engine.ts');
  const engine = new PGLiteEngine();
  await engine.connect({});
  try {
    await engine.initSchema();
    const [row] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
    if (!row) throw conflict();
    const state: EphemeralBrain = { brainId: row.brain_id, busy: false, closed: false };
    const disconnect = engine.disconnect.bind(engine);
    // A factory brand must not survive reconnecting the object to a persistent DB.
    Object.defineProperty(engine, 'connect', { value: async () => { throw conflict(); } });
    Object.defineProperty(engine, 'disconnect', { value: async () => {
      if (state.busy) throw conflict();
      state.closed = true;
      await disconnect();
    } });
    brains.set(engine, state);
    return engine;
  } catch (error) { await engine.disconnect(); throw error; }
}

/** Check before any configuration, reset, or temporary publication. */
export async function assertEphemeralBrain(engine: BrainEngine): Promise<string> {
  const state = brains.get(engine);
  if (!state || state.closed) throw conflict();
  const [row] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  if (row?.brain_id !== state.brainId) throw conflict();
  return state.brainId;
}

/** Reset and question execution cannot overlap, including across async callers. */
export async function withEphemeralBrainUse<T>(engine: BrainEngine, run: () => Promise<T>): Promise<T> {
  const state = brains.get(engine);
  if (!state || state.closed || state.busy) throw conflict();
  state.busy = true;
  try { await assertEphemeralBrain(engine); return await run(); }
  finally { state.busy = false; }
}
