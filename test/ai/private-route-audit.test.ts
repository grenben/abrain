import { test, expect } from 'bun:test';
import { auditPrivateRoutes } from '../../src/core/ai/private-route-audit.ts';
import { DB_GENERATIVE_PINS, makePinPlan } from '../../src/core/ai/private-pin-plan.ts';
test('no-call audit cannot be green when workers/jobs/feature coverage are unknown',async()=>{
  const result=await auditPrivateRoutes();
  expect(result.status).toBe('incomplete');expect(result.coverage.complete).toBe(false);
  expect(result.planes.database).toBe('uninspected');expect(result.planes.workers).toBe('uninspected');
  expect(result.roles.map(r=>r.role)).toContain('atoms');expect(result.roles.map(r=>r.role)).toContain('iterative-minions');
  expect(result.budgets.monetary_cost_usd).toBeNull();expect(result.budgets.remaining_quota).toBeNull();
  for (const role of ['longmemeval-reader','longmemeval-extractor','longmemeval-judge','longmemeval-synopsis','longmemeval-fact-keys-paper','longmemeval-fact-keys-production'] as const) expect(result.roles.map(r=>r.role)).toContain(role);
  expect(DB_GENERATIVE_PINS).toContain('models.eval.longmemeval_judge');
});

test('eval contradiction probe and dream edge closure have distinct callers and migration pins', async () => {
  const roles = (await auditPrivateRoutes()).roles;
  expect(roles.find(r => r.role === 'contradiction-probe')).toMatchObject({
    implementation: 'src/core/eval-contradictions/judge.ts',
  });
  expect(roles.find(r => r.role === 'edge-contradictions')).toMatchObject({
    implementation: 'src/core/cycle/edge-contradictions.ts',
  });
  expect(DB_GENERATIVE_PINS).toContain('models.eval.contradictions_judge');
  expect(DB_GENERATIVE_PINS).toContain('models.dream.edge_contradictions');
  const plan = makePinPlan('database', 'synthetic', 'fixture', 'codex-cli:gpt-test', {
    'models.dream.edge_contradictions': 'anthropic:claude-haiku-4-5-20251001',
  });
  expect(plan.changes).toEqual([{
    key: 'models.dream.edge_contradictions',
    before: 'anthropic:claude-haiku-4-5-20251001',
    after: 'codex-cli:gpt-test',
  }]);
});

test('route inventory separates agent-authored reports from GBrain model dispatch', async () => {
  const audit = await auditPrivateRoutes(), roles = audit.roles;
  expect(roles.find(r => r.role === 'enrichment')?.implementation).toBe('src/commands/enrich.ts');
  expect(roles.find(r => r.role === 'nightly-probes')?.implementation).toBe('src/commands/autopilot-probes.ts');
  expect(roles.map(r => r.role)).not.toContain('generated-reports');
  expect(audit.non_dispatch_surfaces).toContainEqual({ surface:'report-authoring',
    author:'calling_agent_or_operator', save_entrypoint:'src/commands/report.ts',
    model_call:'outside_gbrain', note:'The report CLI saves supplied text. GBrain-owned model-judged drift reports are the drift role.' });
  expect(roles.find(r => r.role === 'drift')?.implementation).toBe('src/core/cycle/drift.ts');
  expect(roles.find(r => r.role === 'longmemeval-reader')?.implementation).toBe('src/eval/longmemeval/reader.ts');
});
