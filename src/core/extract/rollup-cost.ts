/** Compatible with pre-v225 rows, which could not record subscription runs. */
export const ROLLUP_COST_SELECT = `SUM(cost_usd) AS cost_7d_usd,
  SUM(COALESCE((to_jsonb(extract_rollup_7d)->>'subscription_run_count')::integer, 0)) AS subscription_run_count`;

export interface RollupCostRow {
  cost_7d_usd: number | string | null;
  subscription_run_count?: number | string | null;
}

/** Never turn a known subscription attempt into a zero-dollar total. */
export function rollupCost(row: RollupCostRow) {
  const subtotal = row.cost_7d_usd === null ? null : Number(row.cost_7d_usd);
  const count = Number(row.subscription_run_count ?? 0);
  return count > 0 ? { cost_7d_usd: null, api_metered_cost_7d_usd: subtotal, subscription_run_count: count }
    : { cost_7d_usd: subtotal };
}
