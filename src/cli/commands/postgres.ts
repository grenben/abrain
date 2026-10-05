/** Engine-free, local-only managed PostgreSQL lifecycle CLI. */
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';
import type { ManagedClassification, ManagedContext, ManagedStatus, ManagedTarget, ProvisionPlan } from '../../core/managed-postgres.ts';

export const POSTGRES_HELP = `Usage: gbrain postgres <plan|provision|status|start|stop> [options]

Manage GBrain's isolated local PostgreSQL 17 + pgvector cluster on supported macOS.
This command is pre-connect and never opens a GBrain engine or changes init/default behavior.

Commands:
  plan [--json]                         Inspect impact; never installs formulae, starts a service/database,
                                        or creates the cluster. Homebrew may fetch metadata/manifests and cache them.
  provision --yes [--install-packages --package-plan-fingerprint <sha256>] [--json]
                                        Create the dedicated cluster. --yes consents only to cluster creation.
                                        Package install additionally requires both package flags and the exact
                                        fingerprint printed by the current plan. Shared dependency changes are
                                        included in that fingerprint. No Homebrew bootstrap/services/sudo.
  status [--probe] [--json]             Read status; --probe verifies live identity and capabilities.
  start [--json]                        Start only an identity-verified owned cluster.
  stop [--json]                         Stop only an identity-verified owned cluster.

Safety: reports never include credentials; stopping preserves data and no purge command is provided. Planning sets
HOMEBREW_NO_AUTO_UPDATE=1 but may populate Homebrew's cache; it does not clean that cache. Provisioning does not
change GBrain engine configuration, migrate data, or alter init's defaults. Ambiguous ownership fails closed.`;

export interface ManagedPostgresCliDependencies {
  planProvision(context?: ManagedContext): Promise<ProvisionPlan>;
  provision(context?: ManagedContext, consent?: { installPackages?: boolean; packagePlanFingerprint?: string }): Promise<ManagedTarget>;
  status(context?: ManagedContext, options?: { probe?: boolean }): Promise<ManagedStatus>;
  start(context?: ManagedContext): Promise<ManagedStatus>;
  stop(context?: ManagedContext): Promise<ManagedStatus>;
}
const liveDependencies = async (): Promise<ManagedPostgresCliDependencies> => import('../../core/managed-postgres.ts');
type Action = 'plan' | 'provision' | 'status' | 'start' | 'stop';
interface Parsed { action: Action; json: boolean; probe: boolean; yes: boolean; installPackages: boolean; fingerprint?: string; }
type ManagedContextWithSignal = ManagedContext & { signal?: AbortSignal };
type Invocation<T> = { cancelled: true } | { cancelled: false; value: T };
class PostgresCliInputError extends Error {
  readonly kind: 'help' | 'invalid_request';
  constructor(kind: 'help' | 'invalid_request', message = '') { super(message); this.kind = kind; }
}
const inputError = (message: string): never => { throw new PostgresCliInputError('invalid_request', message); };
const HELP_REQUEST = new PostgresCliInputError('help');
const OPERATION_FAILURE = 'Managed PostgreSQL operation failed; sensitive diagnostics were suppressed.';
const CANCELLED_MESSAGE = 'Managed PostgreSQL operation cancelled.';

function parseArgs(args: string[]): Parsed {
  if (!args.length || args[0] === '--help' || args[0] === '-h') throw HELP_REQUEST;
  const action = args[0] as Action;
  if (!['plan', 'provision', 'status', 'start', 'stop'].includes(action)) inputError('Unknown postgres subcommand. Choose plan, provision, status, start, or stop.');
  const parsed: Parsed = { action, json: false, probe: false, yes: false, installPackages: false };
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') throw HELP_REQUEST;
    if (arg === '--json') parsed.json = true;
    else if (arg === '--probe') parsed.probe = true;
    else if (arg === '--yes') parsed.yes = true;
    else if (arg === '--install-packages') parsed.installPackages = true;
    else if (arg === '--package-plan-fingerprint') {
      const value = args[++i];
      if (!value || value.startsWith('--')) inputError('--package-plan-fingerprint requires a 64-character lowercase SHA-256 value.');
      if (!/^[0-9a-f]{64}$/.test(value)) inputError('--package-plan-fingerprint must be exactly 64 lowercase hexadecimal characters.');
      parsed.fingerprint = value;
    } else inputError(`Unknown flag for 'gbrain postgres ${action}'.`);
  }
  if (parsed.probe && action !== 'status') inputError('--probe is only valid with postgres status.');
  if (parsed.yes && action !== 'provision') inputError('--yes is only valid with postgres provision.');
  if ((parsed.installPackages || parsed.fingerprint !== undefined) && action !== 'provision') inputError('Package consent flags are only valid with postgres provision.');
  if (parsed.installPackages !== (parsed.fingerprint !== undefined)) inputError('Package installation consent requires both --install-packages and --package-plan-fingerprint <sha256>.');
  if (action === 'provision' && !parsed.yes) inputError('Cluster creation requires --yes after reviewing `gbrain postgres plan`.');
  return parsed;
}

function safePlan(plan: ProvisionPlan) {
  const impact = plan.packageImpact;
  return {
    ready: plan.ready, root: plan.root, installPackages: plan.installPackages,
    packages: { missing: plan.packages.missing, incompatible: plan.packages.incompatible, ready: plan.packages.ready },
    ...(impact ? { packageImpact: { known: impact.known, formulaInstalls: impact.formulaInstalls, dependencyInstalls: impact.dependencyInstalls, upgrades: impact.upgrades, reinstalls: impact.reinstalls, lines: impact.lines } } : {}),
    ...(plan.packagePlanFingerprint ? { packagePlanFingerprint: plan.packagePlanFingerprint } : {}),
    ...(plan.refusal ? { refusal: plan.refusal } : {}),
  };
}
function humanPlan(plan: ReturnType<typeof safePlan>): string {
  const lines = [`Managed PostgreSQL plan: ${plan.ready ? 'ready' : 'not ready'}`, `Root: ${plan.root}`, `Packages: ${plan.packages.ready ? 'ready' : `missing ${plan.packages.missing.join(', ') || 'none'}${plan.packages.incompatible.length ? `; incompatible ${plan.packages.incompatible.join(', ')}` : ''}`}`];
  if (plan.packageImpact) lines.push('Package impact:', ...(plan.packageImpact.lines.length ? plan.packageImpact.lines.map(line => `  ${line}`) : ['  No package changes.']));
  if (plan.packagePlanFingerprint) lines.push(`Package-plan fingerprint: ${plan.packagePlanFingerprint}`);
  if (plan.refusal) lines.push(`Refusal: ${plan.refusal}`);
  lines.push('No formula was installed, no service/database was started, and no managed cluster was created.');
  lines.push('Homebrew may have fetched metadata/manifests and populated its cache (auto-update disabled; no cleanup performed).');
  return lines.join('\n');
}
function statusCode(action: Action, result: ManagedStatus, probe: boolean): number {
  if (action === 'status') return probe && result.classification !== 'ready' ? 1 : 0;
  return action === 'start' ? (result.classification === 'ready' ? 0 : 1) : action === 'stop' ? (result.classification === 'stopped' ? 0 : 1) : 0;
}
function emit(value: unknown, json: boolean, human: string): void {
  if (json) console.log(JSON.stringify(value)); else console.log(human);
}
function safeTarget(target: ManagedTarget) { return { host: target.host, port: target.port, database: target.database, role: target.role, socketPath: target.socketPath, controller: target.controller }; }
function classificationMessage(action: Action, result: ManagedStatus): string {
  return `Managed PostgreSQL ${action}: ${result.classification}${result.phase ? ` (${result.phase})` : ''}${result.target ? ` at ${result.target.host}:${result.target.port}/${result.target.database}` : ''}`;
}

function isProcessCancelledError(error: unknown): boolean {
  return error instanceof Error && error.name === 'ProcessCancelledError';
}

async function invokeWithCancellation<T>(context: ManagedContextWithSignal, action: (context: ManagedContextWithSignal) => Promise<T>): Promise<Invocation<T>> {
  if (context.signal?.aborted) return { cancelled: true };
  const controller = new AbortController();
  const abort = () => { if (!controller.signal.aborted) controller.abort(); };
  const onSigint = () => abort();
  const externalSignal = context.signal;
  process.on('SIGINT', onSigint);
  externalSignal?.addEventListener('abort', abort, { once: true });
  try {
    if (externalSignal?.aborted) abort();
    if (controller.signal.aborted) return { cancelled: true };
    const result = await action({ ...context, signal: controller.signal });
    return controller.signal.aborted ? { cancelled: true } : { cancelled: false, value: result };
  } catch (error) {
    if (controller.signal.aborted || isProcessCancelledError(error)) return { cancelled: true };
    throw error;
  } finally {
    process.off('SIGINT', onSigint);
    externalSignal?.removeEventListener('abort', abort);
  }
}

function emitCancelled(json: boolean): number {
  if (json) console.log(JSON.stringify({ status: 'error', reason: 'cancelled', message: CANCELLED_MESSAGE }));
  console.error(`[postgres] ${CANCELLED_MESSAGE}`);
  return 1;
}

export async function runManagedPostgresCli(args: string[], dependencies?: ManagedPostgresCliDependencies, context: ManagedContextWithSignal = {}): Promise<number> {
  const jsonRequested = args.includes('--json');
  try {
    const parsed = parseArgs(args);
    const deps = dependencies ?? await liveDependencies();
    const invocation = await invokeWithCancellation(context, async actionContext => {
      if (parsed.action === 'plan') return { kind: 'plan' as const, value: await deps.planProvision(actionContext) };
      if (parsed.action === 'provision') return { kind: 'target' as const, value: await deps.provision(actionContext, { ...(parsed.installPackages ? { installPackages: true, packagePlanFingerprint: parsed.fingerprint } : {}) }) };
      const result = parsed.action === 'status' ? await deps.status(actionContext, { probe: parsed.probe }) : await deps[parsed.action](actionContext);
      return { kind: 'status' as const, value: result };
    });
    if (invocation.cancelled) return emitCancelled(parsed.json);
    const operation = invocation.value;
    if (operation.kind === 'plan') {
      const plan = safePlan(operation.value);
      emit({ status: 'ok', action: 'plan', plan }, parsed.json, humanPlan(plan));
      return 0;
    }
    if (operation.kind === 'target') {
      const target = safeTarget(operation.value);
      emit({ status: 'ok', action: 'provision', target }, parsed.json, `Managed PostgreSQL provisioned at ${target.host}:${target.port}/${target.database} (role ${target.role}).`);
      return 0;
    }
    const result = operation.value;
    const code = statusCode(parsed.action, result, parsed.probe);
    const payload = { status: code === 0 ? 'ok' : 'error', action: parsed.action, classification: result.classification, ...(result.phase ? { phase: result.phase } : {}), ...(result.target ? { target: safeTarget(result.target) } : {}), ...(result.detail ? { detail: 'Details are suppressed.' } : {}) };
    emit(payload, parsed.json, classificationMessage(parsed.action, result));
    return code;
  } catch (error) {
    if (error instanceof PostgresCliInputError && error.kind === 'help') { console.log(POSTGRES_HELP); return 0; }
    const inputMessage = error instanceof PostgresCliInputError && error.kind === 'invalid_request' ? error.message : undefined;
    const report = { status: 'error', reason: inputMessage ? 'invalid_request' : 'operation_failed', message: inputMessage ?? OPERATION_FAILURE };
    if (jsonRequested) console.log(JSON.stringify(report));
    console.error(`[postgres] ${report.message}`);
    return 1;
  }
}

export async function run(args: string[]): Promise<void> {
  const exitCode = await runManagedPostgresCli(args);
  if (exitCode !== 0) setCliExitVerdict(exitCode);
}

export type { ManagedClassification };
