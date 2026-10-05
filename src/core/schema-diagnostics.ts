/** Safe, fixed diagnostic events for schema initialization. */
export type SchemaDiagnosticEvent = 'schema_setup' | 'schema_migrations' | 'migration_started' | 'migration_completed' | 'schema_verified' | 'schema_self_heal_started' | 'schema_self_healed' | 'schema_lock_waiting' | 'zombie_probe_failed' | 'zombie_index_skipped' | 'zombie_index_dropped' | 'zombie_index_drop_failed' | 'zombie_indexes_removed' | 'migration_notice' | 'migration_warning';
export interface SchemaDiagnosticContext {
  /** Managed-safe sinks receive only fixed event identifiers, never data. */
  managedSafe?: boolean;
  emit?: (event: SchemaDiagnosticEvent) => void;
}
const messages: Record<SchemaDiagnosticEvent, string> = {
  schema_setup: 'Setting up brain schema...\n', schema_migrations: 'Applying schema migrations...\n',
  migration_started: 'Applying schema migration...\n', migration_completed: 'Schema migration applied.\n',
  schema_verified: 'Schema verified.\n', schema_self_heal_started: 'Schema self-heal started.\n', schema_self_healed: 'Schema self-heal completed.\n',
  schema_lock_waiting: 'Waiting for schema initialization lock.\n', zombie_indexes_removed: 'Schema cleanup completed.\n',
  zombie_probe_failed: 'Schema cleanup probe failed.\n', zombie_index_skipped: 'Schema cleanup skipped an active index build.\n',
  zombie_index_dropped: 'Invalid schema index removed.\n', zombie_index_drop_failed: 'Invalid schema index could not be removed.\n',
  migration_notice: 'Schema migration notice.\n', migration_warning: 'Schema migration warning.\n',
};
export function schemaDiagnostic(context: SchemaDiagnosticContext | undefined, event: SchemaDiagnosticEvent, ordinary?: () => void): void {
  if (!context?.managedSafe) { ordinary?.(); return; }
  context.emit?.(event);
}
export function managedSchemaDiagnosticSink(write: (text: string) => void): SchemaDiagnosticContext {
  return { managedSafe: true, emit: event => write(messages[event]) };
}
export function migrationTimeoutDiagnostic(
  context: SchemaDiagnosticContext | undefined,
  details: { version: number; name: string; exhausted: boolean; blocker?: { pid: number; query_start: string; query: string } },
): void {
  if (context?.managedSafe) { schemaDiagnostic(context, 'migration_warning'); return; }
  console.error(`\n❌ Migration ${details.version} (${details.name}) ${details.exhausted ? 'exhausted retries' : 'hit statement_timeout (SQLSTATE 57014)'}.`);
  const b = details.blocker;
  if (b) {
    console.error('');
    console.error(`   Likely blocker: PID ${b.pid}, idle since ${b.query_start}`);
    console.error(`   Query: ${b.query.slice(0, 120)}`);
    console.error('');
    console.error(`   Recovery: psql ... -c "SELECT pg_terminate_backend(${b.pid})"`);
    console.error('');
  } else {
    console.error('');
    console.error('   Cause: another connection holds a lock on the target table, or the');
    console.error('   server statement_timeout (~2 min on Supabase) is too short for this DDL.');
    console.error('');
    console.error('   Fix:');
    console.error('     1. gbrain doctor --locks    # find idle-in-transaction blockers');
    console.error('     2. Terminate blocker(s) shown by step 1 via pg_terminate_backend(<pid>)');
    console.error('     3. gbrain apply-migrations --yes  # re-run from the version that failed');
    console.error('');
  }
  console.error('   Verify:');
  console.error('     gbrain doctor              # schema_version should match latest');
  console.error('');
}
