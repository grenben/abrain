import type { Migration } from './types.ts';

/** Small embedding calls can cost less than 0.0001 cents. Keep their measured
 * cost in both reservations and rollups rather than rounding every call to zero.
 * Widening preserves existing values; it cannot reconstruct historical rounding. */
export const v270: Migration = {
  version: 270, name: 'precise_auxiliary_spend', idempotent: true,
  sql: `
    ALTER TABLE mcp_spend_reservations
      ALTER COLUMN estimated_cents TYPE NUMERIC(20, 12),
      ALTER COLUMN actual_cents TYPE NUMERIC(20, 12);
    ALTER TABLE mcp_spend_log ALTER COLUMN spend_cents TYPE NUMERIC(20, 12);
  `,
};
