import { createHash } from 'node:crypto';
import { managedPostgresIdentity, normalizeEngineTarget } from '../core/engine-target.ts';

/**
 * The daemon's view of WHICH engine the file-plane config points at. Pure and
 * deliberately narrow: only the fields an engine migration flips participate,
 * so unrelated config edits (models, search knobs, spend gates) never trigger
 * a restart. Compared at boot vs every tick by the daemon loop.
 */
export function autopilotEngineIdentity(
  cfg: { engine?: string; database_url?: string; database_path?: string; managed_postgres?: unknown } | null,
): string {
  if (cfg?.managed_postgres !== undefined) {
    const target = normalizeEngineTarget(cfg as Parameters<typeof normalizeEngineTarget>[0]);
    if (target.kind === 'postgres-managed') {
      const digest = createHash('sha256').update(managedPostgresIdentity(target.managed_postgres)).digest('hex').slice(0, 24);
      return JSON.stringify({ engine: 'postgres', managed_sha256: digest });
    }
  }
  return JSON.stringify({
    engine: cfg?.engine ?? 'pglite',
    url: cfg?.database_url ?? null,
    path: cfg?.database_path ?? null,
  });
}
