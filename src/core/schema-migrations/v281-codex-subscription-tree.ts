import type { Migration } from './types.ts';
import { SUBSCRIPTION_TREE_SCHEMA_SQL } from '../ai/subscription-tree-schema.ts';
export const v281: Migration = { version: 281, name: 'codex_subscription_tree', idempotent: true, sql: SUBSCRIPTION_TREE_SCHEMA_SQL };
