import type { EngineConfig } from './types.ts';
import { ManagedPostgresPoolError } from './managed-postgres-pool.ts';

export type ManagedFailureKind = 'unavailable' | 'target_unverified';
export interface ManagedPoolCandidate<Pool> { readonly pool: Pool; readonly identity: string }
export interface ManagedPoolView<Pool> {
  readonly identity: string;
  read(): Pool;
  peek(): Pool | null;
}
export interface ManagedAcquisition<Pool> {
  readonly session: ManagedSession<Pool>;
  readonly owner: ManagedOwnerLease | null;
  readonly ready: Promise<void>;
}
export interface ManagedRetirement { finish(): Promise<void> }

export class ManagedOwnerLease {
  private readonly epoch: object;
  private constructor(epoch: object) { this.epoch = epoch; }
  static create(epoch: object): ManagedOwnerLease { return new ManagedOwnerLease(epoch); }
  belongsTo(epoch: object): boolean { return this.epoch === epoch; }
}

interface RecordEntry<Pool> { pool: Pool; closePromise: Promise<void> | null }

/** One immutable target and revocable, dynamically routed managed pool lifetime. */
export class ManagedPostgresBinding<Pool> {
  private readonly epoch = Object.freeze({});
  readonly owner = ManagedOwnerLease.create(this.epoch);
  isOwner(lease: ManagedOwnerLease): boolean { return lease.belongsTo(this.epoch) && lease === this.owner; }
  readonly identity: string;
  readonly config: Readonly<EngineConfig>;
  state: 'building' | 'ready' | 'refreshing' | 'revoked' = 'building';
  private revision = 0;
  private current: RecordEntry<Pool> | null = null;
  private pending: Promise<void> | null = null;
  private pendingWaiter: { promise: Promise<void>; resolve(): void; reject(error: unknown): void } | null = null;
  private readonly records = new Set<RecordEntry<Pool>>();
  private readonly sessions = new Set<ManagedSession<Pool>>();
  private retirement: ManagedRetirement | null = null;
  private ownerConsumed = false;
  readonly view: ManagedPoolView<Pool>;
  readonly ready: Promise<void>;
  private readyWaiter: { promise: Promise<void>; resolve(): void; reject(error: unknown): void };
  get poolRevision(): number { return this.revision; }

  constructor(
    identity: string,
    config: EngineConfig,
    private readonly build: (config: Readonly<EngineConfig>) => Promise<ManagedPoolCandidate<Pool>>,
    private readonly closePool: (pool: Pool) => Promise<void>,
    private readonly failure: (kind: ManagedFailureKind) => Error,
  ) {
    this.identity = identity;
    this.config = freezeCopy(config);
    this.view = Object.freeze({ identity, read: () => this.read(), peek: () => this.peek() });
    this.readyWaiter = deferred();
    this.ready = this.readyWaiter.promise;
    void this.runCandidate(false, this.readyWaiter);
  }

  attach(parent?: ManagedSession<Pool>): ManagedSession<Pool> {
    const session = new ManagedSession(this, parent);
    this.sessions.add(session);
    return session;
  }
  refusal(): Error { return this.failure('target_unverified'); }
  detachSession(session: ManagedSession<Pool>): void { this.sessions.delete(session); }
  checkSession(session: ManagedSession<Pool>): void {
    if (!session.isAttached() || this.state === 'revoked') throw this.failure('target_unverified');
    if (session.parent && !session.parent.isAttached()) throw this.failure('target_unverified');
  }
  readFor(session: ManagedSession<Pool>): Pool {
    this.checkSession(session);
    if ((this.state !== 'ready' && this.state !== 'refreshing') || !this.current) throw this.failure('target_unverified');
    return this.current.pool;
  }
  read(): Pool {
    if ((this.state !== 'ready' && this.state !== 'refreshing') || !this.current) throw this.failure('target_unverified');
    return this.current.pool;
  }
  peek(): Pool | null { return this.state === 'ready' || this.state === 'refreshing' ? this.current?.pool ?? null : null; }

  refresh(): Promise<void> {
    if (this.state === 'revoked') return Promise.reject(this.failure('target_unverified'));
    if (this.state === 'building') return this.ready;
    if (this.pending) return this.pending;
    this.state = 'refreshing';
    const waiter = deferred();
    this.pendingWaiter = waiter;
    this.pending = waiter.promise;
    void this.runCandidate(true, waiter).finally(() => {
      if (this.pending === waiter.promise) this.pending = null;
      if (this.pendingWaiter === waiter) this.pendingWaiter = null;
    }).catch(() => {});
    return waiter.promise;
  }

  revoke(): ManagedRetirement {
    if (this.retirement) return this.retirement;
    this.state = 'revoked';
    const refusal = this.failure('target_unverified');
    this.readyWaiter.reject(refusal);
    this.pendingWaiter?.reject(refusal);
    for (const session of this.sessions) session.invalidate();
    const captured = [...this.records];
    this.current = null;
    let finished: Promise<void> | null = null;
    this.retirement = { finish: () => finished ??= Promise.all(captured.map(record => this.closeRecord(record))).then(() => {}) };
    return this.retirement;
  }

  beginRelease(owner: ManagedOwnerLease): ManagedRetirement {
    if (!this.isOwner(owner)) return { finish: async () => {} };
    if (this.ownerConsumed) return this.retirement ?? { finish: async () => {} };
    this.ownerConsumed = true;
    return this.revoke();
  }

  private async runCandidate(refresh: boolean, waiter: { resolve(): void; reject(error: unknown): void }): Promise<void> {
    let candidate: ManagedPoolCandidate<Pool>;
    try { candidate = await this.build(this.config); }
    catch (error) {
      const kind = classify(error);
      if (this.state === 'revoked') return;
      waiter.reject(this.failure(kind));
      if (refresh && kind === 'unavailable') this.state = 'ready';
      else await this.revoke().finish();
      return;
    }
    const record: RecordEntry<Pool> = { pool: candidate.pool, closePromise: null };
    this.records.add(record);
    if (candidate.identity !== this.identity || this.state === 'revoked') {
      await this.closeRecord(record);
      waiter.reject(this.failure('target_unverified'));
      if (candidate.identity !== this.identity) await this.revoke().finish();
      return;
    }
    const old = this.current;
    this.current = record;
    this.revision++;
    this.state = 'ready';
    waiter.resolve();
    if (old) await this.closeRecord(old);
  }
  private async closeRecord(record: RecordEntry<Pool>): Promise<void> {
    if (record.closePromise) return record.closePromise;
    let timer: ReturnType<typeof setTimeout> | undefined;
    record.closePromise = Promise.race([
        Promise.resolve().then(() => this.closePool(record.pool)).catch(() => {}),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 2500); timer.unref?.(); }),
      ]).finally(() => { if (timer) clearTimeout(timer); this.records.delete(record); });
    await record.closePromise;
  }
}

export class ManagedSession<Pool> {
  private attached = true;
  constructor(private readonly binding: ManagedPostgresBinding<Pool>, readonly parent?: ManagedSession<Pool>) {}
  isAttached(): boolean { return this.attached && (!this.parent || this.parent.isAttached()); }
  read(): Pool { return this.binding.readFor(this); }
  peek(): Pool | null { try { return this.binding.readFor(this); } catch { return null; } }
  matches(identity: string): boolean { return this.binding.identity === identity && this.isAttached(); }
  refresh(): Promise<void> { if (!this.isAttached()) return Promise.reject(this.binding.refusal()); return this.binding.refresh(); }
  borrow(): ManagedSession<Pool> { if (!this.isAttached()) throw this.binding.refusal(); return this.binding.attach(this); }
  detach(): void { if (!this.attached) return; this.attached = false; this.binding.detachSession(this); }
  invalidate(): void { this.attached = false; }
}

function classify(error: unknown): ManagedFailureKind {
  if (!(error instanceof ManagedPostgresPoolError)) return 'target_unverified';
  return error.kind === 'unavailable' ? 'unavailable' : 'target_unverified';
}
function deferred(): { promise: Promise<void>; resolve(): void; reject(error: unknown): void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
function freezeCopy<T>(value: T): Readonly<T> {
  if (!value || typeof value !== 'object') return value as Readonly<T>;
  const copy = Array.isArray(value) ? value.map(item => freezeCopy(item)) : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, freezeCopy(v)]));
  return Object.freeze(copy) as Readonly<T>;
}
