import { privateRoleTier, type PrivateRole } from '../../src/core/ai/private-roles.ts';
import { configPath } from '../../src/core/config-path.ts';
import { afterEach, beforeEach, describe } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Run existing real-caller contracts under an explicit, minimal role allowlist.
 * Legacy single-model fixtures cannot catch missing or mislabeled role identities.
 * No production seam is introduced; only the synthetic operator config changes. */
export function withCodexRoleFixture(root: string, roles: readonly PrivateRole[], register: () => void): void {
  describe(`explicit roles: ${roles.join(', ')}`, () => {
    const path = join(root, '.gbrain', 'config.json');
    let saved: string;
    beforeEach(() => {
      saved = readFileSync(path, 'utf8');
      const config = JSON.parse(saved), policy = config.private_codex;
      const selectedTiers = new Set(roles.map(privateRoleTier));
      config.private_codex = { mode: 'strict', bin: policy.bin,
        models: Object.fromEntries(['utility', 'reasoning', 'deep', 'subagent'].map(tier => [tier, selectedTiers.has(tier as ReturnType<typeof privateRoleTier>) ? 'codex-cli:gpt-test' : `codex-cli:unused-${tier}`])),
        enabled_roles: [...new Set(roles)], ...(policy.scheduled_jobs ? { scheduled_jobs: policy.scheduled_jobs } : {}) };
      writeFileSync(path, JSON.stringify(config));
    });
    afterEach(() => { if (saved !== undefined) writeFileSync(path, saved); });
    register();
  });
}

/** Exercise actual multi-stage callers with four distinct executable model arguments. */
export async function withDistinctCodexModels<T>(run: (models: Record<'utility' | 'reasoning' | 'deep' | 'subagent', string>) => Promise<T>): Promise<T> {
  const path = configPath(), saved = readFileSync(path, 'utf8'), value = JSON.parse(saved);
  const models = { utility: 'codex-cli:utility-fixture', reasoning: 'codex-cli:reasoning-fixture', deep: 'codex-cli:deep-fixture', subagent: 'codex-cli:subagent-fixture' };
  value.private_codex.models = models;
  try { writeFileSync(path, JSON.stringify(value)); return await run(models); }
  finally { writeFileSync(path, saved); }
}
