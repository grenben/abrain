import type { Migration } from './types.ts';
import { SUBSCRIPTION_GROUP_SCHEMA_SQL } from '../ai/subscription-group-schema.ts';
export const v260: Migration = { version: 260, name: 'codex_subscription_groups', idempotent: true, sql: SUBSCRIPTION_GROUP_SCHEMA_SQL };
