/**
 * v0.28.1: LongMemEval benchmark harness — reset-in-place over one in-memory PGLite.
 *
 * The benchmark is sequential: 500 questions × independent haystacks. Instead
 * of building a fresh PGLite per question (snapshot fast-path complexity, env
 * mutation, unverified restore semantics), we connect ONE in-memory engine
 * for the whole run and TRUNCATE all public tables between questions.
 *
 * Tables are enumerated at runtime via pg_tables so a future schema migration
 * (a new takes/oauth/dream table) doesn't silently leak across questions.
 */

import type { PGLiteEngine } from '../../core/pglite-engine.ts';
import { createEphemeralBrain, assertEphemeralBrain, withEphemeralBrainUse } from '../../core/ephemeral-brain.ts';
import { withSubscriptionScratch } from '../../core/ai/subscription-target.ts';
import { SubscriptionAdmissionError } from '../../core/ai/subscription-admission.ts';
export { assertEphemeralBrain as assertBenchmarkBrain } from '../../core/ephemeral-brain.ts';

interface PgTablesRow {
  tablename: string;
}

/**
 * Tables that initSchema() seeds rows into and FK-depends on. TRUNCATEing
 * them between benchmark questions either nukes seeded rows (sources.'default'
 * which pages.source_id FK-points to) or coordination state that should
 * survive across the run. Everything else is content + can be cleared.
 */
const PRESERVE_TABLES: ReadonlySet<string> = new Set([
  // FK target for pages.source_id; seeded as 'default' by pglite-schema.ts.
  'sources',
  // Key-value config; empty in a benchmark run, but config is infrastructure.
  'config',
  // Identity survives corpus reset; subscription state must live elsewhere.
  'persistence_brain',
  // Coordination locks; not content.
  'gbrain_cycle_locks',
  'subagent_rate_leases',
  // System One eval arms insert calibrations once per brain (configureDecideBrain); empty otherwise.
  'decide_calibrations',
  // The brain's identity and persistence-mode singleton (#6482): a brain without exactly one row refuses every write.
  'persistence_brain',
]);

export const createBenchmarkBrain = createEphemeralBrain;

export async function resetTables(engine: PGLiteEngine): Promise<void> {
  await withEphemeralBrainUse(engine, () => engine.transaction(async tx => {
    // A disposable target must never own allowances. Refuse instead of wiping
    // admission, attempts, proposal cache, or an unresolved account-lane hold.
    const grants = await tx.executeRaw('SELECT run_id FROM codex_subscription_runs LIMIT 1');
    if (grants.length) throw new SubscriptionAdmissionError('subscription_identity_conflict');
    const rows = await tx.executeRaw<PgTablesRow>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const targets = rows.map(r => r.tablename).filter(t => !PRESERVE_TABLES.has(t));
    if (!targets.length) return;
    const list = targets.map(t => `"${t.replace(/"/g, '""')}"`).join(', ');
    await tx.executeRaw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  }));
  await assertEphemeralBrain(engine);
}

export async function runBenchmarkQuestion<T>(engine: PGLiteEngine, run: () => Promise<T>): Promise<T> {
  await resetTables(engine);
  return withSubscriptionScratch(engine, run);
}

export async function withBenchmarkBrain<T>(
  fn: (engine: PGLiteEngine) => Promise<T>,
): Promise<T> {
  const engine = await createBenchmarkBrain();
  try {
    return await fn(engine);
  } finally {
    await engine.disconnect();
  }
}

/** #5092: questions per harness-owned benchmark brain before it is replaced. */
export const LME_BRAIN_RECYCLE_EVERY = 40;

/**
 * #5092 — TRUNCATE between questions never returns PGLite's WASM memory,
 * which grows with every question's vectors (~30 MB per 500-chunk question)
 * until a long single-process run stalls at 100% CPU around question 90-120.
 * `next()` hands out the brain for the next question, replacing it with a
 * fresh, re-configured one every `every` questions (0 = never). `close()`
 * disconnects a replacement; the first brain stays its owner's to close.
 */
export function brainRecycler(
  first: PGLiteEngine,
  every: number,
  create: () => Promise<PGLiteEngine>,
  configure: (engine: PGLiteEngine) => Promise<void>,
): { next(): Promise<PGLiteEngine>; close(): Promise<void> } {
  let brain = first;
  let served = 0;
  return {
    async next() {
      if (every > 0 && served === every) {
        await brain.disconnect();
        brain = await create();
        await configure(brain);
        served = 0;
      }
      served++;
      return brain;
    },
    async close() {
      if (brain !== first) await brain.disconnect();
    },
  };
}
