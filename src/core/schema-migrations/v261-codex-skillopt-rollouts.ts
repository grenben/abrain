import type { Migration } from './types.ts';
import { CODEX_SKILLOPT_ROLLOUT_SCHEMA_SQL } from '../skillopt/codex-rollout-schema.ts';
export const v261: Migration = { version: 261, name: 'codex_skillopt_rollouts', idempotent: true, sql: CODEX_SKILLOPT_ROLLOUT_SCHEMA_SQL };
