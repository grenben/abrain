import { loadConfigFileOnly } from '../core/config.ts';
import { assertNoManagedPostgresTarget, type ManagedPostgresTargetLike } from '../core/managed-postgres-unsupported.ts';
export { classifyManagedInitPreflight } from '../core/managed-postgres/init-preflight.ts';
export { inspectManagedInitCommandEligibility, inspectManagedInitPreflight } from '../core/managed-postgres/init-preflight-observer.ts';
export type {
  InspectManagedInitCommandEligibilityInput, InspectManagedInitPreflightInput, ManagedInitCommandEligibility,
  ManagedInitObserverTestHooks,
} from '../core/managed-postgres/init-preflight-observer.ts';
export type {
  ManagedInitPreflightInput, ManagedInitPreflightResult,
} from '../core/managed-postgres/init-preflight.ts';

const INIT_BOOLEAN_FLAGS = new Set([
  '--pglite',
  '--supabase',
  '--mcp-only',
  '--force',
  '--non-interactive',
  '--migrate-only',
  '--json',
  '--no-embedding',
  '--skip-embed-check',
  '--db-only',
  '--git',
  '--no-git',
  // db-availability loop (5a): Postgres-first ladder for harness installs.
  '--prefer-postgres',
  '--allow-docker',
  '--allow-create-db',
  '--local-postgres',
]);

const INIT_VALUE_FLAGS = new Set([
  '--url',
  '--key',
  '--path',
  '--content-root',
  '--schema-pack',
  '--embedding-model',
  '--model',
  '--embedding-dimensions',
  '--expansion-model',
  '--chat-model',
  '--mcp-url',
  '--issuer-url',
  '--oauth-client-id',
  '--oauth-client-secret',
]);

const MANAGED_INIT_FLAGS = new Set([
  '--managed-postgres', '--yes', '--non-interactive', '--json', '--no-embedding', '--db-only', '--install-packages',
]);
const MANAGED_INIT_VALUE_FLAGS = new Set(['--package-plan-fingerprint']);
const MANAGED_INIT_ERROR = 'gbrain init: invalid managed PostgreSQL init flags';

export interface ManagedInitFlagSelection {
  lane: 'managed-postgres';
  yes: boolean;
  nonInteractive: boolean;
  json: boolean;
  noEmbedding: boolean;
  dbOnly: boolean;
  consent: { installPackages: boolean; packagePlanFingerprint?: string };
}

export type InitFlagValidationResult = 'migrate-only' | 'regular' | ManagedInitFlagSelection;

// A schema-only run may optionally request JSON output, and nothing else.
// This includes force and remote/thin-client credentials: --force must never
// widen the managed-target exemption.
const MIGRATE_ONLY_FLAGS = new Set(['--migrate-only', '--json']);

/** Validate flag syntax first, then guard every target-changing init lane. */
export function validateInitFlags(
  args: string[],
  targetConfig?: ManagedPostgresTargetLike | null,
): InitFlagValidationResult {
  if (args.includes('--help') || args.includes('-h')) return 'regular';
  const managedSelectorCount = args.filter((arg) => arg === '--managed-postgres').length;
  if (managedSelectorCount > 0) return parseManagedInitFlags(args);

  const seenValues = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) continue;
    if (INIT_BOOLEAN_FLAGS.has(arg)) continue;
    if (INIT_VALUE_FLAGS.has(arg)) {
      if (seenValues.has(arg)) failInitFlag(`gbrain init: ${arg} may be specified only once`, args.includes('--json'));
      seenValues.add(arg);
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        failInitFlag(`gbrain init: ${arg} requires a value`, args.includes('--json'));
      }
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) failInitFlag(`gbrain init: unknown flag ${arg}`, args.includes('--json'));
  }

  const migrateOnly = args.includes('--migrate-only');
  if (migrateOnly) {
    if (args.some((arg) => !MIGRATE_ONLY_FLAGS.has(arg))) {
      failInitFlag('gbrain init: --migrate-only must be used alone (optionally with --json)', args.includes('--json'));
    }
  }

  // Schema-only migration uses the complete configured EngineConfig and does
  // not replace its target. It remains supported for managed references.
  const lane = migrateOnly ? 'migrate-only' : 'regular';
  if (lane !== 'migrate-only') {
    const config = targetConfig === undefined ? loadConfigFileOnly() ?? {} : targetConfig ?? {};
    assertNoManagedPostgresTarget(config, 'init-reinit');
  }
  return lane;
}

function parseManagedInitFlags(args: string[]): ManagedInitFlagSelection {
  const json = args.includes('--json');
  const seen = new Set<string>();
  let installPackages = false;
  let packagePlanFingerprint: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (seen.has(arg)) failInitFlag(MANAGED_INIT_ERROR, json);
    seen.add(arg);
    if (MANAGED_INIT_FLAGS.has(arg)) continue;
    if (MANAGED_INIT_VALUE_FLAGS.has(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith('-') || seen.has(value)) failInitFlag(MANAGED_INIT_ERROR, json);
      index++;
      if (args.slice(index + 1).includes(value)) failInitFlag(MANAGED_INIT_ERROR, json);
      packagePlanFingerprint = value;
      continue;
    }
    failInitFlag(MANAGED_INIT_ERROR, json);
  }

  installPackages = seen.has('--install-packages');
  if (installPackages !== (packagePlanFingerprint !== undefined) ||
      packagePlanFingerprint !== undefined && !/^[0-9a-f]{64}$/.test(packagePlanFingerprint)) {
    failInitFlag(MANAGED_INIT_ERROR, json);
  }
  if ((json || seen.has('--non-interactive')) && !seen.has('--yes')) failInitFlag(MANAGED_INIT_ERROR, json);
  return {
    lane: 'managed-postgres',
    yes: seen.has('--yes'),
    nonInteractive: seen.has('--non-interactive'),
    json,
    noEmbedding: seen.has('--no-embedding'),
    dbOnly: seen.has('--db-only'),
    consent: { installPackages, ...(packagePlanFingerprint ? { packagePlanFingerprint } : {}) },
  };
}

export function failInitFlag(message: string, jsonOutput: boolean): never {
  if (jsonOutput) {
    console.log(JSON.stringify({ status: 'error', reason: 'invalid_flag', message }));
  } else {
    console.error(message);
    console.error('Run `gbrain init --help` for supported flags.');
  }
  process.exit(1);
}
