import { join } from 'node:path';
import type { ManagedInitFlagSelection } from './init-flags.ts';
import type { ManagedInitCommandEligibility, InspectManagedInitPreflightInput } from '../core/managed-postgres/init-preflight-observer.ts';
import type { ManagedInitPreflightResult } from '../core/managed-postgres/init-preflight.ts';
import type { ManagedPostgresReference } from '../core/types.ts';
import type { ProvisionPlan, ManagedContext } from '../core/managed-postgres.ts';
import {
  ConfigPublicationCommittedCleanupError, ConfigPublicationUncertainError,
} from '../core/config-publication.ts';
import { publishManagedInitConfigForInitFile } from '../core/config-managed-publication.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { managedSchemaDiagnosticSink, type SchemaDiagnosticContext } from '../core/schema-diagnostics.ts';
import { registerShutdownSettlement } from '../core/process-cleanup.ts';
import { ProcessTerminationUnconfirmedError } from '../core/managed-postgres/process.ts';

export type ManagedInitStage =
  | 'preflight' | 'cluster_consent' | 'plan' | 'package_consent' | 'locked_recheck'
  | 'provision' | 'engine_create' | 'connect' | 'schema_profile' | 'schema' | 'publish' | 'disconnect';
export type ManagedInitReason =
  | 'managed_init_completed' | 'preflight_refused' | 'cancelled' | 'cluster_consent_required'
  | 'plan_refused' | 'package_consent_required' | 'package_plan_changed' | 'state_changed'
  | 'provision_failed' | 'connect_failed' | 'schema_failed' | 'publication_failed'
  | 'publication_uncertain' | 'publication_committed_cleanup' | 'disconnect_failed' | 'cleanup_failed_uncommitted';
export interface ManagedInitOutcome {
  status: 'ok' | 'error';
  reason: ManagedInitReason;
  stage: ManagedInitStage;
  message: string;
}

export interface ManagedInitEngine {
  connect(config: { engine: 'postgres'; managed_postgres: ManagedPostgresReference; poolSize: 1 }): Promise<void>;
  initSchema(context?: SchemaDiagnosticContext): Promise<void>;
  disconnect(): Promise<void>;
}
export function adaptManagedInitEngine(engine: import('../core/engine.ts').BrainEngine): ManagedInitEngine {
  return {
    connect: config => engine.connect(config),
    initSchema: context => engine.initSchema(context),
    disconnect: () => engine.disconnect(),
  };
}
export interface ManagedInitCancellationScope { signal: AbortSignal; dispose(): void; }
export interface ManagedInitCoordinatorDependencies {
  context: Readonly<Required<Pick<ManagedContext, 'configDir' | 'root' | 'uid' | 'platform' | 'arch'>> & ManagedContext>;
  acceptedEnvironmentUrl(): boolean;
  directDatabaseOverride(): boolean;
  canonicalPgliteArtifactPaths: readonly string[];
  inspectFull(input: InspectManagedInitPreflightInput): ManagedInitPreflightResult;
  inspectCommand(input: { configDir: string; uid: number; acceptedEnvironmentUrl: boolean; canonicalPgliteArtifactPaths: readonly string[] }): ManagedInitCommandEligibility;
  confirm(message: string, signal: AbortSignal): Promise<boolean>;
  plan(context: ManagedContext & { signal: AbortSignal }): Promise<ProvisionPlan>;
  withProvisioned<T>(
    context: ManagedContext,
    callback: (reference: Readonly<ManagedPostgresReference>) => Promise<T>,
    consent: { installPackages?: boolean; packagePlanFingerprint?: string },
    options: { beforeMutation(state: Readonly<{ kind: 'fresh' | 'owned-resume'; reference: Readonly<ManagedPostgresReference> }>): Promise<void> },
  ): Promise<T>;
  createEngine(config: { engine: 'postgres'; managed_postgres: ManagedPostgresReference }): Promise<ManagedInitEngine>;
  configureFixedSchemaProfile(): Promise<void> | void;
  publish(reference: ManagedPostgresReference, configDir: string): void;
  cancellationScope(): ManagedInitCancellationScope;
  writeStdout(line: string): void;
  writeStderr(line: string): void;
}

const MESSAGE: Record<ManagedInitReason, string> = {
  managed_init_completed: 'Managed PostgreSQL database is ready. It is local, manually controlled, database-only. No login-start was configured.',
  preflight_refused: 'Managed PostgreSQL init preflight refused; no changes were made.',
  cancelled: 'Managed PostgreSQL init was cancelled; no configuration was published.',
  cluster_consent_required: 'Managed PostgreSQL cluster/schema setup was not authorized; no changes were made.',
  plan_refused: 'Managed PostgreSQL package planning was refused; no cluster changes were made.',
  package_consent_required: 'Package installation requires separate consent. Review the exact fingerprint and rerun with --install-packages --package-plan-fingerprint <fingerprint>.',
  package_plan_changed: 'The package plan changed or could not be verified; no package installation was authorized.',
  state_changed: 'Managed init state changed during setup; no further changes were authorized.',
  provision_failed: 'Managed PostgreSQL provisioning failed; retained state was not removed or repaired.',
  connect_failed: 'The isolated managed database connection failed; configuration was not published.',
  schema_failed: 'Managed database schema initialization failed; configuration was not published.',
  publication_failed: 'Managed config publication failed before commit; the managed cluster was retained.',
  publication_uncertain: 'Managed config publication outcome is uncertain. Inspect the config before retrying.',
  publication_committed_cleanup: 'Managed config was committed, but publication cleanup needs attention. Do not rerun to compensate.',
  disconnect_failed: 'Managed config was committed, but engine cleanup failed. Do not rerun to compensate.',
  cleanup_failed_uncommitted: 'Engine cleanup failed before config publication. Config was not published; retained cluster state was not removed.',
};

function outcome(reason: ManagedInitReason, stage: ManagedInitStage, status: ManagedInitOutcome['status'] = 'error'): ManagedInitOutcome {
  return { status, reason, stage, message: MESSAGE[reason] };
}
function checkCancelled(signal: AbortSignal): void { if (signal.aborted) throw new InitCancelled(); }
class InitCancelled extends Error {}
function inputFor(deps: ManagedInitCoordinatorDependencies, acceptedEnvironmentUrl: boolean): InspectManagedInitPreflightInput {
  return {
    configDir: deps.context.configDir, root: deps.context.root, uid: deps.context.uid,
    acceptedEnvironmentUrl, canonicalPgliteArtifactPaths: deps.canonicalPgliteArtifactPaths,
  };
}
function actionName(result: ManagedInitPreflightResult): string {
  switch (result.kind) {
    case 'fresh': return 'create a fresh local managed database';
    case 'owned-resume': return 'resume the structurally owned local database';
    case 'published-resume': return 'validate the published managed database and schema';
  }
}
function sameReference(a: ManagedPostgresReference | undefined, b: ManagedPostgresReference): boolean {
  return !!a && a.manager_id === b.manager_id && a.cluster_id === b.cluster_id;
}
function safePackageSummary(plan: ProvisionPlan): string {
  const installCount = plan.packageImpact?.formulaInstalls.length ?? 0;
  const dependencyCount = plan.packageImpact?.dependencyInstalls.length ?? 0;
  const upgradeCount = plan.packageImpact?.upgrades.length ?? 0;
  return `Package impact: ${plan.packages.ready ? 'already ready' : `${installCount} formula install(s), ${dependencyCount} dependency install(s), ${upgradeCount} upgrade(s)`}.` +
    (plan.installPackages && plan.packagePlanFingerprint ? ` Package-plan fingerprint: ${plan.packagePlanFingerprint}.` : '');
}
function validPlan(plan: ProvisionPlan): boolean {
  const fingerprint = plan.packagePlanFingerprint;
  const impactFingerprint = plan.packageImpact?.fingerprint;
  if ((fingerprint !== undefined && !/^[a-f0-9]{64}$/.test(fingerprint)) ||
      (impactFingerprint !== undefined && (typeof impactFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(impactFingerprint)))) return false;
  return !plan.refusal && plan.ready === plan.packages.ready && plan.packages.incompatible.length === 0 &&
    !plan.packages.missing.includes('homebrew') &&
    (plan.packages.ready
      ? !plan.installPackages && plan.packages.missing.length === 0 && !plan.packageImpact && !fingerprint
      : plan.installPackages && plan.packages.missing.length > 0 && !!plan.packageImpact?.known &&
        !!fingerprint && /^[a-f0-9]{64}$/.test(fingerprint) && impactFingerprint === fingerprint);
}

function assertFinalEligibility(
  deps: ManagedInitCoordinatorDependencies,
  initial: ManagedInitPreflightResult,
  initialReference: ManagedPostgresReference | undefined,
  state: Readonly<{ kind: 'fresh' | 'owned-resume'; reference: Readonly<ManagedPostgresReference> }>,
): void {
  try {
    if (deps.directDatabaseOverride() || deps.acceptedEnvironmentUrl()) throw new StateChanged();
    const latest = deps.inspectCommand({ configDir: deps.context.configDir, uid: deps.context.uid, acceptedEnvironmentUrl: false,
      canonicalPgliteArtifactPaths: deps.canonicalPgliteArtifactPaths });
    const agrees = initial.kind === 'fresh'
      ? state.kind === 'fresh' && latest.kind === 'unpublished'
      : state.kind === 'owned-resume' && (initial.kind === 'owned-resume'
        ? latest.kind === 'unpublished' && sameReference(initialReference, state.reference)
        : latest.kind === 'published' && sameReference(initialReference, latest.reference) && sameReference(latest.reference, state.reference));
    if (!agrees) throw new StateChanged();
  } catch { throw new StateChanged(); }
}

/** Complete-capability coordinator seam. Every operation is injected; test callers never fall through to production defaults. */
export async function runManagedInitCoordinator(
  selection: ManagedInitFlagSelection,
  deps: ManagedInitCoordinatorDependencies,
): Promise<ManagedInitOutcome> {
  const cancellation = deps.cancellationScope();
  let stage: ManagedInitStage = 'preflight';
  const currentStage = (): ManagedInitStage => stage;
  let publicationState: 'uncommitted' | 'uncertain' | 'committed' = 'uncommitted';
  const currentPublicationState = (): typeof publicationState => publicationState;
  try {
    checkCancelled(cancellation.signal);
    if ((selection.json || selection.nonInteractive) && !selection.yes) return outcome('cluster_consent_required', stage);
    if (deps.directDatabaseOverride() || deps.acceptedEnvironmentUrl()) return outcome('preflight_refused', stage);
    const initial = deps.inspectFull(inputFor(deps, false));
    let initialReference: ManagedPostgresReference | undefined;
    if (initial.kind !== 'fresh') initialReference = initial.reference;
    if (initial.kind === 'published-resume') {
      const published = deps.inspectCommand({ configDir: deps.context.configDir, uid: deps.context.uid, acceptedEnvironmentUrl: false,
        canonicalPgliteArtifactPaths: deps.canonicalPgliteArtifactPaths });
      if (published.kind !== 'published' || !sameReference(initialReference, published.reference)) return outcome('preflight_refused', stage);
    }

    stage = 'cluster_consent';
    if (!selection.yes) {
      deps.writeStderr(`Managed PostgreSQL will ${actionName(initial)}. This is local, manual-controller, database-only setup; no login-start, provider setup, or content import will run.`);
      checkCancelled(cancellation.signal);
      let accepted = false;
      try { accepted = await deps.confirm('Create/resume the managed database and initialize its schema? [y/N] ', cancellation.signal); }
      catch { if (cancellation.signal.aborted) throw new InitCancelled(); return outcome('cluster_consent_required', stage); }
      checkCancelled(cancellation.signal);
      if (!accepted) { if (cancellation.signal.aborted) throw new InitCancelled(); return outcome('cluster_consent_required', stage); }
    }

    stage = 'plan';
    checkCancelled(cancellation.signal);
    if (deps.directDatabaseOverride() || deps.acceptedEnvironmentUrl()) return outcome('preflight_refused', stage);
    let plan: ProvisionPlan;
    try { plan = await deps.plan({ ...deps.context, signal: cancellation.signal }); }
    catch { if (cancellation.signal.aborted) throw new InitCancelled(); return outcome('plan_refused', stage); }
    checkCancelled(cancellation.signal);
    if (!validPlan(plan)) return outcome(plan.packageImpact && !plan.packageImpact.known ? 'package_plan_changed' : 'plan_refused', stage);
    deps.writeStderr(safePackageSummary(plan));

    let packageConsent: { installPackages?: boolean; packagePlanFingerprint?: string } = {};
    if (plan.installPackages) {
      const fingerprint = plan.packagePlanFingerprint;
      if (!fingerprint || !/^[a-f0-9]{64}$/.test(fingerprint)) return outcome('package_plan_changed', stage);
      stage = 'package_consent';
      if (selection.consent.installPackages) {
        if (selection.consent.packagePlanFingerprint !== fingerprint) return outcome('package_plan_changed', stage);
        packageConsent = { installPackages: true, packagePlanFingerprint: fingerprint };
      } else if (selection.json || selection.nonInteractive) {
        return { ...outcome('package_consent_required', stage), message: `Package installation requires separate consent. Rerun with --install-packages --package-plan-fingerprint ${fingerprint}.` };
      } else {
        deps.writeStderr(`A separate package-install approval is required for fingerprint ${fingerprint}.`);
        checkCancelled(cancellation.signal);
        let accepted = false;
        try { accepted = await deps.confirm(`Install packages for this exact plan (${fingerprint})? [y/N] `, cancellation.signal); }
        catch { if (cancellation.signal.aborted) throw new InitCancelled(); return outcome('package_consent_required', stage); }
        checkCancelled(cancellation.signal);
        if (!accepted) { if (cancellation.signal.aborted) throw new InitCancelled(); return outcome('package_consent_required', stage); }
        packageConsent = { installPackages: true, packagePlanFingerprint: fingerprint };
      }
    } else if (selection.consent.installPackages) {
      return outcome('package_plan_changed', 'package_consent');
    }

    stage = 'provision';
    checkCancelled(cancellation.signal);
    let nestedFailure: ManagedInitOutcome | undefined;
    await deps.withProvisioned({ ...deps.context, signal: cancellation.signal }, async (reference) => {
      stage = 'engine_create';
      checkCancelled(cancellation.signal);
      if (initialReference && !sameReference(initialReference, reference)) {
        nestedFailure = outcome('state_changed', 'locked_recheck');
        return;
      }
      let engine: ManagedInitEngine | undefined;
      let connected = false;
      let callbackPublicationState: 'uncommitted' | 'uncertain' | 'committed' = 'uncommitted';
      let operationFailure: ManagedInitOutcome | undefined;
      let disconnectFailure = false;
      let cancelledBeforeCleanup = false;
      try {
        engine = await deps.createEngine({ engine: 'postgres', managed_postgres: reference });
        checkCancelled(cancellation.signal);
        stage = 'connect';
        await engine.connect({ engine: 'postgres', managed_postgres: reference, poolSize: 1 });
        connected = true;
        checkCancelled(cancellation.signal);
        stage = 'schema_profile';
        await deps.configureFixedSchemaProfile();
        checkCancelled(cancellation.signal);
        stage = 'schema';
        await engine.initSchema(managedSchemaDiagnosticSink(deps.writeStderr));
        assertFinalEligibility(deps, initial, initialReference, { kind: initial.kind === 'fresh' ? 'fresh' : 'owned-resume', reference });
        checkCancelled(cancellation.signal);
        stage = 'publish';
        checkCancelled(cancellation.signal);
        deps.publish(reference, deps.context.configDir);
        publicationState = 'committed';
        callbackPublicationState = 'committed';
      } catch (error) {
        if (error instanceof ProcessTerminationUnconfirmedError) {
          throw error;
        } else if (error instanceof StateChanged) {
          operationFailure = outcome('state_changed', 'locked_recheck');
        } else if (error instanceof ConfigPublicationUncertainError) {
          publicationState = callbackPublicationState = 'uncertain';
          operationFailure = outcome('publication_uncertain', 'publish');
        } else if (error instanceof ConfigPublicationCommittedCleanupError) {
          publicationState = callbackPublicationState = 'committed';
          operationFailure = outcome('publication_committed_cleanup', 'publish');
        } else if (error instanceof InitCancelled || cancellation.signal.aborted) {
          operationFailure = outcome(publicationState === 'committed' ? 'publication_committed_cleanup' : 'cancelled', stage);
        } else if (stage === 'engine_create' || stage === 'connect') operationFailure = outcome('connect_failed', stage);
        else if (stage === 'schema' || stage === 'schema_profile') operationFailure = outcome('schema_failed', stage);
        else if (stage === 'publish') operationFailure = outcome('publication_failed', stage);
        else operationFailure = outcome('provision_failed', stage);
      } finally {
        if (engine) {
          cancelledBeforeCleanup = cancellation.signal.aborted;
          stage = 'disconnect';
          try { await engine.disconnect(); }
          catch (error) {
            if (error instanceof ProcessTerminationUnconfirmedError) throw error;
            else disconnectFailure = true;
          }
        }
      }
      if (!operationFailure && (cancelledBeforeCleanup || cancellation.signal.aborted)) {
        operationFailure = outcome(publicationState === 'committed' ? 'publication_committed_cleanup' : 'cancelled', stage);
      }
      if (disconnectFailure) {
        if (publicationState === 'committed' && operationFailure?.reason !== 'publication_committed_cleanup') operationFailure = outcome('disconnect_failed', 'disconnect');
        else if (publicationState === 'uncommitted' && operationFailure?.reason !== 'publication_uncertain') operationFailure = outcome('cleanup_failed_uncommitted', 'disconnect');
      }
      if (operationFailure) nestedFailure = operationFailure;
      else if (!connected || callbackPublicationState !== 'committed') nestedFailure = outcome('publication_failed', stage);
    }, packageConsent, { beforeMutation: async (state) => {
      stage = 'locked_recheck';
      checkCancelled(cancellation.signal);
      let latest: ManagedInitCommandEligibility;
      try {
        if (deps.directDatabaseOverride() || deps.acceptedEnvironmentUrl()) throw new StateChanged();
        latest = deps.inspectCommand({ configDir: deps.context.configDir, uid: deps.context.uid, acceptedEnvironmentUrl: false,
          canonicalPgliteArtifactPaths: deps.canonicalPgliteArtifactPaths });
      } catch { throw new StateChanged(); }
      const agrees = initial.kind === 'fresh'
        ? state.kind === 'fresh' && latest.kind === 'unpublished'
        : state.kind === 'owned-resume' && (initial.kind === 'owned-resume'
          ? latest.kind === 'unpublished' && sameReference(initialReference, state.reference)
          : latest.kind === 'published' && sameReference(initialReference, latest.reference) && sameReference(latest.reference, state.reference));
      if (!agrees) throw new StateChanged();
      checkCancelled(cancellation.signal);
      stage = 'provision';
    } });
    if (nestedFailure) return nestedFailure;
    if (cancellation.signal.aborted) return outcome(currentPublicationState() === 'committed' ? 'publication_committed_cleanup' : 'cancelled', currentStage());
    return { ...outcome('managed_init_completed', 'publish', 'ok'), message: initial.kind === 'published-resume'
      ? 'Managed PostgreSQL database and schema are ready. Existing embedding settings were preserved. No login-start was configured.'
      : `${MESSAGE.managed_init_completed} Embeddings are deferred.` };
  } catch (error) {
    if (error instanceof ProcessTerminationUnconfirmedError) {
      if (currentPublicationState() === 'uncertain') return outcome('publication_uncertain', 'publish');
      if (currentPublicationState() === 'committed') return outcome('publication_committed_cleanup', currentStage());
      return outcome('provision_failed', stage);
    }
    if (error instanceof StateChanged) return outcome('state_changed', 'locked_recheck');
    if (error instanceof ConfigPublicationUncertainError) { publicationState = 'uncertain'; return outcome('publication_uncertain', stage); }
    if (error instanceof ConfigPublicationCommittedCleanupError) { publicationState = 'committed'; return outcome('publication_committed_cleanup', stage); }
    if (currentPublicationState() === 'uncertain') return outcome('publication_uncertain', 'publish');
    if (currentPublicationState() === 'committed' && cancellation.signal.aborted) return outcome('publication_committed_cleanup', currentStage());
    if (cancellation.signal.aborted || error instanceof InitCancelled) return outcome(currentPublicationState() === 'committed' ? 'publication_committed_cleanup' : 'cancelled', currentStage());
    if (currentPublicationState() === 'committed' && currentStage() === 'disconnect') return outcome('disconnect_failed', currentStage());
    if (currentPublicationState() === 'committed') return outcome('publication_committed_cleanup', currentStage());
    if (stage === 'preflight') return outcome('preflight_refused', stage);
    if (stage === 'provision') return outcome('provision_failed', stage);
    return outcome(currentPublicationState() === 'committed' ? 'publication_committed_cleanup' : 'provision_failed', currentStage());
  } finally {
    cancellation.dispose();
  }
}

class StateChanged extends Error {}

export async function runManagedPostgresInit(selection: ManagedInitFlagSelection): Promise<void> {
  try {
    const dependencies = await productionDependencies();
    const result = await runManagedInitWithShutdownSettlement(selection, dependencies);
    if (selection.json) dependencies.writeStdout(JSON.stringify({ status: result.status, reason: result.reason, stage: result.stage, message: result.message }));
    else if (result.status === 'ok') dependencies.writeStdout(result.message);
    else dependencies.writeStderr(result.message);
    if (result.status !== 'ok') setCliExitVerdict(1);
  } catch {
    const result = outcome('preflight_refused', 'preflight');
    if (selection.json) console.log(JSON.stringify({ status: result.status, reason: result.reason, stage: result.stage, message: result.message }));
    else console.error(result.message);
    setCliExitVerdict(1);
  }
}

/** Dependency-injected production entry seam; registers the exact active coordinator promise. */
export async function runManagedInitWithShutdownSettlement(
  selection: ManagedInitFlagSelection,
  dependencies: ManagedInitCoordinatorDependencies,
): Promise<ManagedInitOutcome> {
  const coordinator = runManagedInitCoordinator(selection, dependencies);
  const deregister = registerShutdownSettlement(coordinator);
  try { return await coordinator; }
  finally { deregister(); }
}

async function productionDependencies(): Promise<ManagedInitCoordinatorDependencies> {
  const [config, observer, managed, engineFactory, defaults] = await Promise.all([
    import('../core/config.ts'), import('../core/managed-postgres/init-preflight-observer.ts'),
    import('../core/managed-postgres.ts'), import('../core/engine-factory.ts'), import('../core/ai/defaults.ts'),
  ]);
  const directory = config.configDir();
  const root = join(directory, 'postgres', '17');
  const uid = process.getuid?.() ?? -1;
  const context = { configDir: directory, root, uid, platform: process.platform, arch: process.arch } as const;
  return {
    context,
    acceptedEnvironmentUrl: () => Boolean(config.effectiveEnvDatabaseUrl()),
    directDatabaseOverride: () => Boolean(process.env.GBRAIN_DIRECT_DATABASE_URL),
    canonicalPgliteArtifactPaths: [join(directory, 'brain.pglite'), join(directory, 'pglite')],
    inspectFull: observer.inspectManagedInitPreflight,
    inspectCommand: observer.inspectManagedInitCommandEligibility,
    confirm: async (message, signal) => (await import('../core/confirm-prompt.ts')).promptYesNo(message, { output: process.stderr, signal }),
    plan: (ctx) => managed.planProvision(ctx),
    withProvisioned: (ctx, callback, consent, options) => managed.withProvisionedManagedCluster(ctx, callback, consent, options),
    createEngine: async (target) => {
      const engine = await engineFactory.createEngine(target);
      return adaptManagedInitEngine(engine);
    },
    configureFixedSchemaProfile: async () => {
      const { configureGateway } = await import('../core/ai/gateway.ts');
      configureGateway({ embedding_dimensions: defaults.NEW_INSTALL_DEFAULT_EMBEDDING_DIMENSIONS, env: {} });
    },
    publish: (reference, configPath) => publishManagedInitConfigForInitFile(reference, configPath, join(configPath, 'config.json'), { embedding_disabled: true }),
    cancellationScope: createManagedInitCancellationScope,
    writeStdout: (line) => console.log(line),
    writeStderr: (line) => console.error(line),
  };
}

export function createManagedInitCancellationScope(): ManagedInitCancellationScope {
  const controller = new AbortController();
  const sigint = () => controller.abort();
  const sigterm = () => controller.abort();
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);
  let disposed = false;
  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      process.off('SIGINT', sigint);
      process.off('SIGTERM', sigterm);
    },
  };
}
