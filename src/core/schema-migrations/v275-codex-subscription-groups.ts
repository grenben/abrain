import type { Migration } from './types.ts';
import { SUBSCRIPTION_GROUP_SCHEMA_SQL } from '../ai/subscription-group-schema.ts';
export const v275: Migration = { version: 275, name: 'codex_subscription_groups', idempotent: true, sql: SUBSCRIPTION_GROUP_SCHEMA_SQL };
