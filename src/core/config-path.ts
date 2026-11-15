import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

export function configDir(): string {
  // Allow override for tests, Docker, and multi-tenant deployments.
  // GBRAIN_HOME is a parent dir; we always append '.gbrain' ourselves so
  // setting GBRAIN_HOME=/tmp/x yields configDir() === '/tmp/x/.gbrain'.
  // Validates the override: must be absolute, no '..' segments.
  const override = process.env.GBRAIN_HOME;
  if (override && override.trim()) {
    const trimmed = override.trim();
    if (!isAbsolute(trimmed)) {
      throw new Error(`GBRAIN_HOME must be an absolute path; got: ${trimmed}`);
    }
    if (trimmed.split(/[\\/]/).includes('..')) {
      throw new Error(`GBRAIN_HOME must not contain '..' segments; got: ${trimmed}`);
    }
    return join(trimmed, '.gbrain');
  }
  return join(homedir(), '.gbrain');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

/**
 * Sugar for joining paths under the active gbrain home. Use this anywhere you
 * would otherwise write `join(homedir(), '.gbrain', ...rest)`. Honors
 * GBRAIN_HOME, validates input, and centralizes the convention so future
 * audits stay simple.
 */
export function gbrainPath(...segments: string[]): string {
  return join(configDir(), ...segments);
}
