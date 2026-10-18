import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { SkillOptOpts } from './types.ts';
import { CODEX_READ_PROTOCOL, validateCodexReadJob } from '../minions/codex-action-contract.ts';
import { OperationError } from '../ops/contract.ts';
export interface CodexCycleConfig {
  sourceId: string; skillsDir: string; codex: NonNullable<SkillOptOpts['codex']>;
  maxSkillsPerCycle: number; staleDays: number;
  perSkill: { maxAttempts: number; maxTurns: number };
}
const invalid = (): never => { throw new OperationError('invalid_params', 'Private scheduled skill optimization needs bounded trusted configuration.', 'Configure cycle.skillopt.codex with an explicit source, absolute skills directory, read scope and per-skill subscription limits.'); };
/** Trusted configuration only; job payloads and model output cannot choose read authority. */
export async function readCodexCycleConfig(engine: BrainEngine, sourceId?: string): Promise<CodexCycleConfig> {
  const raw = await engine.getConfig('cycle.skillopt.codex');
  if (!raw || raw.length > 65536) invalid();
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw!); } catch { return invalid(); }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k => !['sourceId', 'skillsDir', 'allowedTools', 'allowedSlugPrefixes', 'readRegistry', 'maxSkillsPerCycle', 'maxAttemptsPerSkill', 'maxTurnsPerSkill'].includes(k))) invalid();
  if (typeof value.sourceId !== 'string' || typeof value.skillsDir !== 'string' || !isAbsolute(value.skillsDir) ||
      sourceId !== undefined && sourceId !== value.sourceId) invalid();
  validateCodexReadJob({ action_protocol: CODEX_READ_PROTOCOL, prompt: 'scheduled optimizer scope', source_id: value.sourceId,
    allowed_tools: value.allowedTools, allowed_slug_prefixes: value.allowedSlugPrefixes, no_self_fix: true, max_turns: 16,
    ...(value.readRegistry !== undefined ? { read_registry: value.readRegistry } : {}) });
  const count = value.maxSkillsPerCycle ?? 1, attempts = value.maxAttemptsPerSkill, turns = value.maxTurnsPerSkill;
  if (![count, attempts, turns].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1) ||
      Number(count) > 20 || Number(attempts) > 1000 || Number(turns) > Number(attempts)) invalid();
  const stale = await engine.getConfig('cycle.skillopt.stale_days'), staleDays = stale == null ? 7 : Number(stale);
  if (stale?.trim() === '' || !Number.isFinite(staleDays) || staleDays < 0 || staleDays > 3650) invalid();
  const skillsDir = realpathSync(value.skillsDir as string);
  if (!statSync(skillsDir).isDirectory()) invalid();
  return { sourceId: value.sourceId as string, skillsDir, maxSkillsPerCycle: Number(count), staleDays,
    perSkill: { maxAttempts: Number(attempts), maxTurns: Number(turns) },
    codex: { allowedTools: value.allowedTools as string[], allowedSlugPrefixes: value.allowedSlugPrefixes as string[],
      ...(value.readRegistry !== undefined ? { readRegistry: value.readRegistry as NonNullable<SkillOptOpts['codex']>['readRegistry'] } : {}) } };
}
