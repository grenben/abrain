import { test, expect } from 'bun:test';
import { auditPrivateRoutes } from '../../src/core/ai/private-route-audit.ts';
import { DB_GENERATIVE_PINS } from '../../src/core/ai/private-pin-plan.ts';
test('no-call audit cannot be green when workers/jobs/feature coverage are unknown',async()=>{
  const result=await auditPrivateRoutes();
  expect(result.status).toBe('incomplete');expect(result.coverage.complete).toBe(false);
  expect(result.planes.database).toBe('uninspected');expect(result.planes.workers).toBe('uninspected');
  expect(result.roles.map(r=>r.role)).toContain('atoms');expect(result.roles.map(r=>r.role)).toContain('iterative-minions');
  expect(result.budgets.monetary_cost_usd).toBeNull();expect(result.budgets.remaining_quota).toBeNull();
  for (const role of ['longmemeval-reader','longmemeval-extractor','longmemeval-judge'] as const) expect(result.roles.map(r=>r.role)).toContain(role);
  expect(DB_GENERATIVE_PINS).toContain('models.eval.longmemeval_judge');
});
