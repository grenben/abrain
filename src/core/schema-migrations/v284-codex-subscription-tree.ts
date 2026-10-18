import type { Migration } from './types.ts';
import { SUBSCRIPTION_TREE_SCHEMA_SQL } from '../ai/subscription-tree-schema.ts';
export const v284: Migration = { version: 284, name: 'codex_subscription_tree', idempotent: true, sql: SUBSCRIPTION_TREE_SCHEMA_SQL };
