import postgres from '#postgres';
import { configDir } from './config.ts';
import * as db from './db.ts';
import { normalizeEngineTarget, managedPostgresIdentity } from './engine-target.ts';
import { createManagedPostgresCandidate, ManagedPostgresPoolError, type ManagedPostgresCandidate } from './managed-postgres-pool.ts';
import { resolveManagedPostgresConnection } from './managed-postgres/connection.ts';
import { ConnectionManager, type ConnectionManagerOpts } from './connection-manager.ts';
import { ManagedPostgresBinding, type ManagedOwnerLease, type ManagedSession } from './managed-postgres-binding.ts';
import { ManagedPostgresSingleton } from './managed-postgres-singleton.ts';
import { GBrainError, type EngineConfig } from './types.ts';
import { logDbDisconnect } from './audit/db-disconnect-audit.ts';
import { logPoolRecovery } from './audit/pool-recovery-audit.ts';
import { drainBackgroundWorkBeforeDisconnect } from './background-work.ts';

export type EnginePool = ReturnType<typeof postgres>;
export type ManagedCandidate = Pick<ManagedPostgresCandidate, 'pool' | 'identity'>;
type EngineConfigEx = EngineConfig & { poolSize?: number; parentConnectionManager?: ConnectionManager };
export interface ManagedAttachmentSignature {
  readonly identity: string;
  readonly style: 'instance' | 'module' | 'parent';
  readonly parent: ConnectionManager | null;
  readonly poolSize: number | null;
}

export interface ManagedEngineRuntime {
  identity: string | null;
  generation: number;
  session: ManagedSession<EnginePool> | null;
  lease: ManagedOwnerLease | null;
  binding: ManagedPostgresBinding<EnginePool> | null;
  lifecycle: 'connecting' | 'attached' | 'closing' | 'disconnected';
  work: Promise<void> | null;
  reconnectWork: Promise<void> | null;
  style: 'instance' | 'module' | 'parent' | null;
  parent: ConnectionManager | null;
  signature: ManagedAttachmentSignature | null;
  revokedIdentity: string | null;
  routingMode: 'url' | 'managed';
  managedResetAllowed: boolean;
}
export function createManagedEngineRuntime(): ManagedEngineRuntime {
  return { identity: null, generation: 0, session: null, lease: null, binding: null, lifecycle: 'disconnected', work: null, reconnectWork: null, style: null, parent: null, signature: null, revokedIdentity: null, routingMode: 'url', managedResetAllowed: false };
}

export interface ManagedEngineHost {
  readonly deps: ManagedEngineDependencies;
  readonly runtime: ManagedEngineRuntime;
  sql: EnginePool | null;
  manager: ConnectionManager | null;
  stops: ReadonlySet<() => Promise<void>>;
  saveConfig(config: EngineConfigEx): void;
  ownsModuleSingleton: boolean;
  connectionStyle: 'instance' | 'module' | null;
  createUrlPool(url: string, config: EngineConfigEx): EnginePool;
}

export function createManagedEngineHost(
  deps: ManagedEngineDependencies,
  runtime: ManagedEngineRuntime,
  stops: ReadonlySet<() => Promise<void>>,
  access: { readSql(): EnginePool | null; writeSql(value: EnginePool | null): void; readManager(): ConnectionManager | null; writeManager(value: ConnectionManager | null): void; saveConfig(config: EngineConfigEx): void; readOwnsModuleSingleton(): boolean; writeOwnsModuleSingleton(value: boolean): void; readConnectionStyle(): 'instance' | 'module' | null; writeConnectionStyle(value: 'instance' | 'module' | null): void; createUrlPool(url: string, config: EngineConfigEx): EnginePool },
): ManagedEngineHost {
  return {
    deps,
    runtime,
    stops,
    get sql() { return access.readSql(); },
    set sql(value) { access.writeSql(value); },
    get manager() { return access.readManager(); },
    set manager(value) { access.writeManager(value); },
    saveConfig: config => access.saveConfig(config),
    get ownsModuleSingleton() { return access.readOwnsModuleSingleton(); },
    set ownsModuleSingleton(value) { access.writeOwnsModuleSingleton(value); },
    get connectionStyle() { return access.readConnectionStyle(); },
    set connectionStyle(value) { access.writeConnectionStyle(value); },
    createUrlPool: (url, config) => access.createUrlPool(url, config),
  };
}

export interface ManagedEngineDependencies {
  readonly createCandidate: (config: EngineConfig, options: Record<string, unknown>) => Promise<ManagedCandidate>;
  readonly closePool: (pool: EnginePool) => Promise<void>;
  readonly createManager: (options: ConnectionManagerOpts) => ConnectionManager;
  readonly acquireManaged?: typeof db.acquireManaged;
  readonly beginManagedRelease?: typeof db.beginManagedRelease;
  readonly teardownTimeoutMs?: number;
  readonly createUrlPool?: (url: string, options: Record<string, unknown>) => EnginePool;
}
export const DEFAULT_MANAGED_ENGINE_DEPENDENCIES: ManagedEngineDependencies = Object.freeze({
  createCandidate: (config: EngineConfig, options: Record<string, unknown>) => createManagedPostgresCandidate(config, options, {
    resolve: resolveManagedPostgresConnection, create: postgres, end: db.endPoolBounded, configDir,
  }),
  closePool: db.endPoolBounded,
  createManager: (options: ConnectionManagerOpts) => new ConnectionManager(options),
  acquireManaged: db.acquireManaged,
  beginManagedRelease: db.beginManagedRelease,
  createUrlPool: (url: string, options: Record<string, unknown>) => postgres(url, options as never),
});

const coordinators = new WeakMap<Function, ManagedPostgresSingleton<EnginePool>>();
function coordinator(host: ManagedEngineHost): ManagedPostgresSingleton<EnginePool> {
  const key = host.deps.createCandidate as Function;
  let value = coordinators.get(key);
  if (!value) { value = new ManagedPostgresSingleton(kind => new ManagedPostgresPoolError(kind), host.deps.closePool); coordinators.set(key, value); }
  return value;
}
const configForBinding = (config: EngineConfig): EngineConfig => ({ engine: 'postgres', managed_postgres: config.managed_postgres });

export async function connectManagedIfTarget(host: ManagedEngineHost, config: EngineConfigEx): Promise<boolean> {
  let target;
  try { target = normalizeEngineTarget(config); }
  catch (error) { if (config.managed_postgres !== undefined) throw new ManagedPostgresPoolError('target_unverified'); throw error; }
  if (target.kind !== 'postgres-managed') return false;
  host.runtime.routingMode = 'managed';
  const signature = managedAttachmentSignature(config, managedPostgresIdentity(target.managed_postgres));
  if (host.runtime.revokedIdentity !== null) throw new ManagedPostgresPoolError('target_unverified');
  if (host.runtime.lifecycle === 'connecting' && host.runtime.work) {
    if (!sameAttachment(host.runtime.signature, signature)) throw new ManagedPostgresPoolError('target_unverified');
    await host.runtime.work;
    return true;
  }
  const work = connectManaged(host, config, target.managed_postgres);
  host.runtime.work = work;
  try { await work; } finally { if (host.runtime.work === work) host.runtime.work = null; }
  return true;
}

export async function connectManaged(host: ManagedEngineHost, config: EngineConfigEx, reference: { manager_id: 'gbrain-managed-postgres'; cluster_id: string }): Promise<void> {
  host.runtime.routingMode = 'managed';
  const identity = managedPostgresIdentity(reference);
  const signature = managedAttachmentSignature(config, identity);
  const parent = signature.parent;
  const style = signature.style;
  if (host.runtime.lifecycle === 'closing') throw new ManagedPostgresPoolError('target_unverified');
  if (host.runtime.revokedIdentity !== null) throw new ManagedPostgresPoolError('target_unverified');
  if (host.runtime.lifecycle === 'attached') {
    const { session } = host.runtime;
    if (sameAttachment(host.runtime.signature, signature) && session?.isAttached()) {
      try { session.read(); return; } catch { /* revoked/unusable; refuse */ }
    }
    throw new ManagedPostgresPoolError('target_unverified');
  }
  if (host.runtime.lifecycle !== 'disconnected') throw new ManagedPostgresPoolError('target_unverified');
  const generation = ++host.runtime.generation;
  host.runtime.lifecycle = 'connecting';
  host.runtime.identity = identity;
  host.runtime.signature = signature;
  let session: ManagedSession<EnginePool> | null = null;
  let lease: ManagedOwnerLease | null = null;
  let binding: ManagedPostgresBinding<EnginePool> | null = null;
  try {
    let ready: Promise<void>;
    if (parent) {
      if (!parent.isManagedMode || parent.managedIdentity !== identity) throw new ManagedPostgresPoolError('target_unverified');
      session = parent.borrowManagedSession();
      ready = Promise.resolve();
    } else if (config.poolSize) {
      const deps = host.deps;
      binding = new ManagedPostgresBinding(identity, configForBinding(config), immutable =>
      deps.createCandidate(immutable, managedInstanceOptions(config)), deps.closePool, kind => new ManagedPostgresPoolError(kind));
      session = binding.attach(); lease = binding.owner; ready = binding.ready;
    } else {
      const build = (immutable: Readonly<EngineConfig>) => host.deps.createCandidate(immutable, managedModuleOptions());
      const acquisition = host.deps.acquireManaged
        ? host.deps.acquireManaged(identity, configForBinding(config), build)
        : coordinator(host).acquire(identity, configForBinding(config), build);
      session = acquisition.session; lease = acquisition.owner; ready = acquisition.ready;
    }
    host.runtime.session = session; host.runtime.lease = lease; host.runtime.binding = binding; host.runtime.parent = parent;
    await ready;
    if (host.runtime.generation !== generation || host.runtime.lifecycle !== 'connecting' || !session.isAttached()) throw new ManagedPostgresPoolError('target_unverified');
    const manager = managedManager(identity, session, host.deps);
    if (host.runtime.generation !== generation || host.runtime.lifecycle !== 'connecting' || !session.isAttached()) {
      manager.disconnect(); throw new ManagedPostgresPoolError('target_unverified');
    }
    host.manager = manager;
    host.sql = config.poolSize && !parent ? session.read() : null;
    host.runtime.style = style;
    host.runtime.lifecycle = 'attached';
    host.runtime.revokedIdentity = null;
    host.runtime.managedResetAllowed = false;
  } catch (error) {
    session?.detach();
    if (lease) {
      const retirement = binding?.beginRelease(lease) ?? (host.deps.beginManagedRelease?.(lease) ?? coordinator(host).beginRelease(lease));
      if (retirement) await retirement.finish();
    }
    if (host.runtime.generation === generation) {
      host.manager?.disconnect(); host.manager = null; host.sql = null;
      host.runtime.session = null; host.runtime.lease = null; host.runtime.binding = null; host.runtime.identity = null; host.runtime.parent = null; host.runtime.style = null; host.runtime.signature = null; host.runtime.lifecycle = 'disconnected';
    }
    throw classifyManagedError(error);
  }
}

function managedAttachmentSignature(config: EngineConfigEx, identity: string): ManagedAttachmentSignature {
  const parent = config.parentConnectionManager ?? null;
  if (parent && config.poolSize !== undefined) throw new ManagedPostgresPoolError('target_unverified');
  const style = parent ? 'parent' : config.poolSize ? 'instance' : 'module';
  return Object.freeze({ identity, style, parent, poolSize: style === 'instance' ? config.poolSize! : null });
}
function sameAttachment(left: ManagedAttachmentSignature | null, right: ManagedAttachmentSignature): boolean {
  return left !== null && left.identity === right.identity && left.style === right.style && left.parent === right.parent && left.poolSize === right.poolSize;
}

export async function connectUrl(host: ManagedEngineHost, config: EngineConfigEx): Promise<void> {
  const switchingFromManaged = host.runtime.routingMode === 'managed';
  if (switchingFromManaged && (!host.runtime.managedResetAllowed || host.runtime.lifecycle !== 'disconnected')) {
    throw new ManagedPostgresPoolError('target_unverified');
  }
  if (!switchingFromManaged) host.saveConfig(config);
  try {
    const url = config.database_url;
    if (config.poolSize) {
      if (!url) throw new GBrainError('No database URL', 'database_url is missing', 'Provide --url');
      host.sql = host.createUrlPool(url, config);
      await host.sql`SELECT 1`;
      await db.setSessionDefaults(host.sql);
      host.connectionStyle = 'instance';
      host.manager = new ConnectionManager({ url, parent: config.parentConnectionManager, readPoolOwnedExternally: true });
      host.manager.setReadPool(host.sql);
    } else {
      host.ownsModuleSingleton = await db.connect(config);
      host.connectionStyle = 'module';
      if (url) {
        host.manager = new ConnectionManager({ url, parent: config.parentConnectionManager, readPoolOwnedExternally: true });
        host.manager.setReadPool(db.getConnection());
      }
    }
    host.saveConfig(config);
    if (switchingFromManaged) {
      host.runtime.identity = null;
      host.runtime.signature = null;
      host.runtime.revokedIdentity = null;
      host.runtime.routingMode = 'url';
      host.runtime.managedResetAllowed = false;
    }
  } catch (error) {
    if (!switchingFromManaged) throw error;
    await host.manager?.disconnect().catch(() => {});
    host.manager = null;
    if (host.sql) { await db.endPoolBounded(host.sql); host.sql = null; }
    if (host.ownsModuleSingleton) { await db.disconnect(); host.ownsModuleSingleton = false; }
    host.connectionStyle = null;
    throw error;
  }
}

export function managedInstanceOptions(config: EngineConfigEx): Record<string, unknown> {
  const timeouts = db.resolveSessionTimeouts();
  const options: Record<string, unknown> = {
    max: Math.min(config.poolSize!, db.resolvePoolSize(config.poolSize)), idle_timeout: 20, connect_timeout: 10,
    max_lifetime: db.resolveMaxLifetimeSeconds(), types: { bigint: postgres.BigInt }, onnotice: db.resolvePoolNoticeHandler(true),
  };
  if (Object.keys(timeouts).length) options.connection = timeouts;
  return options;
}
export function managedModuleOptions(): Record<string, unknown> {
  const options = { max: db.resolvePoolSize(), idle_timeout: 20, connect_timeout: 10, max_lifetime: db.resolveMaxLifetimeSeconds(), types: { bigint: postgres.BigInt }, onnotice: db.resolvePoolNoticeHandler(true) };
  const timeouts = db.resolveSessionTimeouts(); if (Object.keys(timeouts).length) Object.assign(options, { connection: timeouts });
  return options;
}

export function managedManager(identity: string, session: ManagedSession<EnginePool>, deps: ManagedEngineDependencies): ConnectionManager {
  try { return deps.createManager({ managedIdentity: identity, managedSession: session }); }
  catch { throw new ManagedPostgresPoolError('target_unverified'); }
}
export function classifyManagedError(error: unknown): ManagedPostgresPoolError {
  return error instanceof ManagedPostgresPoolError ? error : new ManagedPostgresPoolError('target_unverified');
}
export function managedEnginePool(identity: string | null, manager: ConnectionManager | null): EnginePool {
  if (!identity || !manager?.isManagedMode || manager.managedIdentity !== identity) throw new ManagedPostgresPoolError('target_unverified');
  try { return manager.read() as EnginePool; } catch (error) { throw classifyManagedError(error); }
}

export async function disconnectManaged(host: ManagedEngineHost): Promise<void> {
  if (host.runtime.lifecycle === 'closing') return;
  if (host.runtime.lifecycle === 'disconnected') {
    host.runtime.revokedIdentity = null;
    host.runtime.identity = null;
    host.runtime.signature = null;
    host.runtime.routingMode = 'managed';
    host.runtime.managedResetAllowed = true;
    return;
  }
  const style = host.runtime.style === 'parent' ? 'instance' : host.runtime.style;
  const manager = host.manager, lease = host.runtime.lease, binding = host.runtime.binding;
  host.runtime.lifecycle = 'closing'; host.runtime.generation++;
  host.runtime.reconnectWork = null;
  host.runtime.session?.detach(); host.runtime.session = null;
  host.manager = null; host.sql = null; host.runtime.lease = null; host.runtime.binding = null;
  host.runtime.style = null;
  host.runtime.parent = null;
  host.runtime.identity = null;
  host.runtime.signature = null;
  host.runtime.revokedIdentity = null;
  host.runtime.routingMode = 'managed';
  host.runtime.managedResetAllowed = true;
  let retirement = lease ? (binding ? binding.beginRelease(lease) : (host.deps.beginManagedRelease?.(lease) ?? coordinator(host).beginRelease(lease))) : null;
  try { logDbDisconnect('postgres', style ?? 'unknown'); } catch { /* best effort */ }
  const timeout = host.deps.teardownTimeoutMs ?? 2000;
  const hooks = [...host.stops].map(stop => bounded(Promise.resolve().then(stop), timeout));
  const work = manager || lease ? bounded(drainBackgroundWorkBeforeDisconnect().catch(() => {}), timeout) : Promise.resolve();
  try {
    await Promise.all([...hooks, work]);
  } finally {
    if (manager) await manager.disconnect().catch(() => {});
    if (retirement) await retirement.finish();
    host.runtime.lifecycle = 'disconnected';
  }
}
function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<void> {
  return new Promise(resolve => { const timer = setTimeout(resolve, timeoutMs); timer.unref?.(); promise.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); }); });
}

export async function reconnectManaged(host: ManagedEngineHost, config: EngineConfigEx): Promise<void> {
  if (host.runtime.lifecycle !== 'attached' || !host.runtime.session) throw new ManagedPostgresPoolError('target_unverified');
  if (host.runtime.reconnectWork) return host.runtime.reconnectWork;
  const work = reconnectManagedWork(host, config);
  host.runtime.reconnectWork = work;
  try { await work; } finally { if (host.runtime.reconnectWork === work) host.runtime.reconnectWork = null; }
}

async function reconnectManagedWork(host: ManagedEngineHost, config: EngineConfigEx): Promise<void> {
  const generation = host.runtime.generation;
  const session = host.runtime.session;
  if (!session) throw new ManagedPostgresPoolError('target_unverified');
  try {
    await session.refresh();
    if (host.runtime.lifecycle !== 'attached' || !session.isAttached()) throw new ManagedPostgresPoolError('target_unverified');
    host.sql = config.poolSize && !config.parentConnectionManager ? session.read() : null;
    try { logPoolRecovery('reconnect_succeeded'); } catch { /* audit */ }
  } catch (error) {
    const classified = classifyManagedError(error);
    if (classified.kind === 'target_unverified' && host.runtime.generation === generation) {
      const lease = host.runtime.lease;
      const binding = host.runtime.binding;
      host.runtime.revokedIdentity = host.runtime.identity;
      const retirement = lease
        ? binding?.beginRelease(lease) ?? (host.deps.beginManagedRelease?.(lease) ?? coordinator(host).beginRelease(lease))
        : null;
      session.detach(); host.runtime.session = null; host.manager?.disconnect(); host.manager = null;
      host.sql = null; host.runtime.lease = null; host.runtime.binding = null; host.runtime.signature = null; host.runtime.parent = null; host.runtime.style = null; host.runtime.lifecycle = 'disconnected';
      if (retirement) await retirement.finish();
    }
    try { logPoolRecovery('reconnect_failed', classified); } catch { /* audit */ }
    throw classified;
  }
}
