import type { EngineConfig } from './types.ts';
import { ManagedPostgresPoolError } from './managed-postgres-pool.ts';
import { ManagedPostgresBinding, type ManagedAcquisition, type ManagedPoolCandidate, type ManagedRetirement } from './managed-postgres-binding.ts';

export interface ManagedCandidate<Pool> extends ManagedPoolCandidate<Pool> {}
const EMPTY_RETIREMENT: ManagedRetirement = Object.freeze({ finish: async () => {} });

/** Managed-only singleton slot. Its synchronous acquire reserves before proof starts. */
export class ManagedPostgresSingleton<Pool> {
  private binding: ManagedPostgresBinding<Pool> | null = null;
  private readonly releaseByLease = new WeakMap<object, ManagedRetirement>();
  private generation = 0;
  constructor(private readonly createError: (kind?: 'unavailable' | 'target_unverified') => Error, private readonly closePool: (pool: Pool) => Promise<void>) {}

  acquire(identity: string, config: EngineConfig, build: (config: Readonly<EngineConfig>) => Promise<ManagedCandidate<Pool>>): ManagedAcquisition<Pool> {
    if (this.binding?.state === 'revoked') this.binding = null;
    if (this.binding) {
      if (this.binding.identity !== identity || this.binding.state === 'revoked') throw this.createError();
      return { session: this.binding.attach(), owner: null, ready: this.binding.ready };
    }
    const binding = new ManagedPostgresBinding(identity, config, build, this.closePool, kind => this.createError(kind));
    this.binding = binding;
    const generation = ++this.generation;
    const ready = binding.ready.catch(error => {
      if (this.binding === binding && this.generation === generation && binding.state === 'revoked') this.binding = null;
      throw error;
    });
    return { session: binding.attach(), owner: binding.owner, ready };
  }

  beginRelease(owner: import('./managed-postgres-binding.ts').ManagedOwnerLease): ManagedRetirement {
    const binding = this.binding;
    const existing = this.releaseByLease.get(owner);
    if (existing) return existing;
    if (!binding || !binding.isOwner(owner)) {
      this.releaseByLease.set(owner, EMPTY_RETIREMENT);
      return EMPTY_RETIREMENT;
    }
    this.binding = null;
    this.generation++;
    const retirement = binding.beginRelease(owner);
    this.releaseByLease.set(owner, retirement);
    return retirement;
  }

  getPool(): Pool | null { return this.binding?.peek() ?? null; }
  hasCommitted(): boolean { return this.binding?.state === 'ready' || this.binding?.state === 'refreshing'; }
  isBusy(): boolean { return this.binding !== null && this.binding.state !== 'revoked'; }
  matches(identity: string): boolean { return this.binding?.identity === identity && this.binding.state !== 'revoked'; }

  /** Compatibility shim for legacy callers; engine authority must use acquire/beginRelease. */
  connect(identity: string, buildCandidate: () => Promise<ManagedCandidate<Pool>>): Promise<boolean> {
    if (this.binding?.state === 'revoked') this.binding = null;
    const config = Object.freeze({ engine: 'postgres' }) as EngineConfig;
    let acquisition: ManagedAcquisition<Pool>;
    try { acquisition = this.acquire(identity, config, async () => buildCandidate()); }
    catch (error) { return Promise.reject(error); }
    return acquisition.ready.then(
      () => acquisition.owner !== null,
      error => { const kind = knownFailureKind(error); throw this.createError(kind ?? undefined); },
    );
  }

  /** Global shutdown snapshot/revoke; no post-await singleton lookup. */
  beginGlobalRelease(): ManagedRetirement {
    this.generation++;
    const binding = this.binding;
    this.binding = null;
    return binding ? binding.revoke() : { finish: async () => {} };
  }
  async disconnect(): Promise<void> { await this.beginGlobalRelease().finish(); }
}

function knownFailureKind(error: unknown): 'unavailable' | 'target_unverified' | null {
  if (!(error instanceof ManagedPostgresPoolError)) return null;
  const kind = error.kind;
  return kind === 'unavailable' || kind === 'target_unverified' ? kind : null;
}
