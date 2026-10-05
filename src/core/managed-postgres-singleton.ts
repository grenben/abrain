export interface ManagedPoolCandidate<Pool> {
  readonly pool: Pool;
  readonly identity: string;
}

interface Committed<Pool> extends ManagedPoolCandidate<Pool> {}
interface Pending {
  readonly identity: string;
  readonly generation: number;
  readonly promise: Promise<boolean>;
}

/** Owns only the managed singleton state; URL singleton behavior stays separate. */
export class ManagedPostgresSingleton<Pool> {
  private committed: Committed<Pool> | null = null;
  private pending: Pending | null = null;
  private generation = 0;

  constructor(
    private readonly createError: () => Error,
    private readonly closePool: (pool: Pool) => Promise<void>,
  ) {}

  getPool(): Pool | null { return this.committed?.pool ?? null; }
  hasCommitted(): boolean { return this.committed !== null; }
  isBusy(): boolean { return this.pending !== null || this.committed !== null; }
  matches(identity: string): boolean { return this.committed?.identity === identity; }

  connect(identity: string, buildCandidate: () => Promise<ManagedPoolCandidate<Pool>>): Promise<boolean> {
    if (this.committed) {
      return this.committed.identity === identity ? Promise.resolve(false) : Promise.reject(this.createError());
    }
    if (this.pending) {
      return this.pending.identity === identity
        ? this.pending.promise.then(() => false)
        : Promise.reject(this.createError());
    }

    const generation = this.generation;
    const record: { identity: string; generation: number; promise: Promise<boolean> } = {
      identity, generation, promise: Promise.resolve(false),
    };
    const promise = (async (): Promise<boolean> => {
      let candidate: ManagedPoolCandidate<Pool> | null = null;
      try {
        candidate = await buildCandidate();
        if (candidate.identity !== identity || this.generation !== generation || this.pending !== record) {
          await this.close(candidate.pool);
          candidate = null;
          throw this.createError();
        }
        this.committed = candidate;
        this.pending = null;
        return true;
      } catch {
        if (candidate) await this.close(candidate.pool);
        if (this.pending === record) this.pending = null;
        throw this.createError();
      }
    })();
    record.promise = promise;
    this.pending = record;
    return promise;
  }

  /** Detach pending construction and synchronously clear committed state. */
  async disconnect(): Promise<void> {
    this.generation++;
    const pool = this.committed?.pool ?? null;
    this.committed = null;
    this.pending = null;
    if (pool !== null) await this.close(pool);
  }

  private async close(pool: Pool): Promise<void> {
    try { await this.closePool(pool); } catch { /* close is best-effort */ }
  }
}
