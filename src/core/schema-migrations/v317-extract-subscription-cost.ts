import type { Migration } from './types.ts';

/** cost_usd remains the known API subtotal; subscription totals are unknown. */
export const v317: Migration = {
  version: 317, name: 'extract_subscription_cost', idempotent: true,
  sql: `ALTER TABLE extract_rollup_7d
    ADD COLUMN IF NOT EXISTS subscription_run_count INTEGER NOT NULL DEFAULT 0 CHECK (subscription_run_count >= 0);`,
};
