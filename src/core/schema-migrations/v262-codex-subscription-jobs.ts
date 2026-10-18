import type { Migration } from './types.ts';
import { SUBSCRIPTION_JOB_SCHEMA_SQL } from '../minions/subscription-job-schema.ts';

export const v262: Migration = {
  version: 262, name: 'codex_subscription_jobs', idempotent: true,
  sql: SUBSCRIPTION_JOB_SCHEMA_SQL,
};
