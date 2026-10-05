import { EngineTargetError, normalizeEngineTarget, type EngineTargetInput, type NormalizedEngineTarget } from './engine-target.ts';

/** Strict validation for direct engine entry points, before constructors or IO. */
export function validateDirectEngineTarget(config: EngineTargetInput): NormalizedEngineTarget {
  const fields = config as EngineTargetInput & Record<string, unknown>;
  const hasUrl = fields.database_url !== undefined;
  const hasPath = fields.database_path !== undefined;

  if (hasUrl && (typeof fields.database_url !== 'string' || fields.database_url.length === 0)) {
    throw new EngineTargetError('database_url must be a non-empty string');
  }
  if (hasPath && (typeof fields.database_path !== 'string' || fields.database_path.length === 0)) {
    throw new EngineTargetError('database_path must be a non-empty string');
  }
  if (hasUrl && hasPath) {
    throw new EngineTargetError('database_url and database_path cannot be combined');
  }
  if (config.engine === 'pglite' && hasUrl) {
    throw new EngineTargetError('pglite cannot be combined with database_url');
  }
  if (config.engine === 'postgres' && hasPath) {
    throw new EngineTargetError('postgres cannot be combined with database_path');
  }

  return normalizeEngineTarget(config);
}

/** PGLite accepts its legacy empty config as an in-memory target, but never a Postgres target. */
export function validateDirectPgliteTarget(config: EngineTargetInput): void {
  const target = validateDirectEngineTarget(config);
  if (target.kind !== 'pglite' && (config.engine !== undefined || config.database_url !== undefined || config.managed_postgres !== undefined)) {
    throw new EngineTargetError('PGLite engine requires a PGLite target');
  }
}
