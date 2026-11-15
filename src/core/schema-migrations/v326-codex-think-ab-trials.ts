import type { Migration } from './types.ts';
import { THINK_AB_SCHEMA_SQL } from '../calibration/think-ab-schema.ts';
export const v326: Migration = { version: 326, name:'codex_think_ab_trials', idempotent:true, sql:THINK_AB_SCHEMA_SQL };
