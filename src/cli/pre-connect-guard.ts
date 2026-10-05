import { loadConfigFileOnly, toEngineConfig } from '../core/config.ts';
import { assertNoManagedPostgresTarget } from '../core/managed-postgres-unsupported.ts';
import type { CliPreConnectGuard } from './command-table.ts';

/** Apply a command's synchronous safety guard before config routing or connect. */
export function runPreConnectGuard(guard: CliPreConnectGuard | undefined, args: readonly string[]): void {
  if (guard !== 'migrate-source' || args[0] === 'embeddings') return;
  const fileConfig = loadConfigFileOnly();
  if (fileConfig) assertNoManagedPostgresTarget(toEngineConfig(fileConfig), 'migration-source');
}
