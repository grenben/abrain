import type { Migration } from './types.ts';
import { SUBSCRIPTION_SCHEMA_SQL } from '../ai/subscription-schema.ts';

// Applied only by the normal authorized migration runner. Identical SQL on PGLite/Postgres.
export const v258: Migration = {
  version: 258, name: 'codex_subscription_admission', idempotent: true,
  sql: SUBSCRIPTION_SCHEMA_SQL,
};
