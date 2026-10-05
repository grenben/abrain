import { loadConfigFileOnly } from '../core/config.ts';
import { assertNoManagedPostgresTarget, type ManagedPostgresTargetLike } from '../core/managed-postgres-unsupported.ts';

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

/** Validate flag syntax first, then guard every target-changing init lane. */
export function validateInitFlags(
  args: string[],
  targetConfig?: ManagedPostgresTargetLike | null,
): void {
  if (args.includes('--help') || args.includes('-h')) return;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) continue;
    if (INIT_BOOLEAN_FLAGS.has(arg)) continue;
    if (INIT_VALUE_FLAGS.has(arg)) {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        failInitFlag(`gbrain init: ${arg} requires a value`, args.includes('--json'));
      }
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) failInitFlag(`gbrain init: unknown flag ${arg}`, args.includes('--json'));
  }

  // Schema-only migration uses the complete configured EngineConfig and does
  // not replace its target. It remains supported for managed references.
  if (!args.includes('--migrate-only')) {
    const config = targetConfig === undefined ? loadConfigFileOnly() ?? {} : targetConfig ?? {};
    assertNoManagedPostgresTarget(config, 'init-reinit');
  }
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
