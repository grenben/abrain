import { expect, spyOn } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { __registerCodexFixtureForTests } from '../../src/core/ai/providers/codex-qualification.ts';
import { submitCodexSkillOpt } from '../../src/core/skillopt/codex-job.ts';
import { runSkillOptJob, type SkillOptJobInput } from '../../src/core/skillopt/job.ts';
import { resolveSkillOptModels } from '../../src/core/skillopt/models-plan.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { buildJobContext } from '../../src/core/minions/job-context.ts';
import { runWithJobSpend } from '../../src/core/minions/spend-authorization.ts';
import { makeAutopilotGlobalMaintenanceHandler, readGlobalMaintenanceProgress } from '../../src/core/minions/handlers/autopilot-global-maintenance.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../../src/core/persistence/skill-activation.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { getSharedSkill } from '../../src/core/shared-skills/catalog.ts';
import { setSharedSkillPolicy } from '../../src/core/shared-skills/policy.ts';
import { submitSharedSkillMutation } from '../../src/core/shared-skills/publication.ts';
import * as shared from '../../src/core/shared-skills/codex-optimizer-store.ts';
import * as publication from '../../src/core/shared-skills/codex-optimizer-publication.ts';
import * as cycles from '../../src/core/skillopt/codex-cycle-store.ts';
import * as files from '../../src/core/skillopt/codex-run-files.ts';
import * as drafts from '../../src/core/skillopt/codex-bootstrap-files.ts';
import { assertSafeE2eDatabaseUrl } from './db-guard.ts';
import { HOLDER_TAKEOVER_GRACE_MS, inspectLock } from '../../src/core/db-lock.ts';

const [mode, point, root, digest] = process.argv.slice(2);
if (!['seed', 'crash', 'recover'].includes(mode) || !['shared-result', 'shared-committed', 'cycle-file', 'cycle-complete'].includes(point)) throw new Error('Invalid fixture phase');
const isShared = point.startsWith('shared-'), sourceId = isShared ? 'managed-recovery' : 'default';
const config = JSON.parse(readFileSync(join(root, 'home', '.gbrain', 'config.json'), 'utf8'));
const unregister = __registerCodexFixtureForTests(config.private_codex.bin, digest);
globalThis.fetch = (() => { throw new Error('forbidden network'); }) as unknown as typeof fetch;
const databaseUrl = process.env.CODEX_OPTIMIZER_CRASH_DATABASE_URL;
if (databaseUrl) assertSafeE2eDatabaseUrl(databaseUrl);
const engine = databaseUrl ? new PostgresEngine() : new PGLiteEngine();
if (databaseUrl) await (engine as PostgresEngine).connect({ database_url: databaseUrl, poolSize: 2 });
else await (engine as PGLiteEngine).connect({ database_path: join(root, 'database') });
const queue = new MinionQueue(engine), worktree = join(root, 'canonical'), skillsDir = join(isShared ? worktree : root, 'skills');
const initialText = '---\nname: synthetic-skill\ndescription: Synthetic benchmark skill.\n---\n# Response\n\nPrefer brevity.\n';
const finalText = initialText.replace('Prefer brevity.', 'Always cite evidence.');
const context = () => ({ engine, sourceId, remote: false, config: { engine: engine.kind }, dryRun: false, logger: { info() {}, warn() {}, error() {} } });
const scope = () => ({ operationContext: context(), codex: { allowedTools: ['get_page'], allowedSlugPrefixes: ['notes/*'] } });
const calls = () => readFileSync(join(root, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).length;
const benchmark = (count: number) => Array.from({ length: count }, (_, i) => JSON.stringify({ task_id: `task-${i}`, task: `Synthetic task ${i}.`,
  judge: { kind: 'rule', checks: [{ op: 'contains', arg: 'evidence' }] } })).join('\n');
function addSkill(name: string): void {
  mkdirSync(join(skillsDir, name), { recursive: true });
  writeFileSync(join(skillsDir, name, 'SKILL.md'), initialText);
  writeFileSync(join(skillsDir, name, 'skillopt-benchmark.jsonl'), benchmark(50));
}

async function seedShared() {
  mkdirSync(worktree);
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, worktree]);
  await claimWorktree(engine, sourceId, worktree); await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
  await engine.setConfig('mcp.publish_skills', 'true');
  await setSharedSkillPolicy(context(), sourceId, { version: 1, enabled: true, classes: ['prose', 'reference'], audiences: ['readers'], requirements: [], allow_follow: true }, null);
  await submitSharedSkillMutation(context(), 'put_skill', { name: 'synthetic-skill', pack_id: 'example-pack', expected_revision: null, files: [
    { path: 'skills/synthetic-skill/SKILL.md', content: initialText, file_class: 'prose', depends_on: ['skills/synthetic-skill/benchmark.jsonl', 'skills/synthetic-skill/reference.md'] },
    { path: 'skills/synthetic-skill/benchmark.jsonl', content: benchmark(15), file_class: 'reference' },
    { path: 'skills/synthetic-skill/reference.md', content: 'Immutable approved reference.', file_class: 'reference' },
  ] });
  const detail = await getSharedSkill(context(), { name: 'synthetic-skill' });
  const grant = { requestId: '123e4567-e89b-42d3-a456-426614174000', maxAttempts: 150, maxTurns: 150, deadline: new Date(Date.now() + 3600000) };
  const input: SkillOptJobInput = { skillsDir, skillName: 'synthetic-skill', benchmarkPath: join(skillsDir, 'synthetic-skill/benchmark.jsonl'),
    sharedSkill: { source_id: sourceId, source_incarnation: detail.source_incarnation, pack_id: 'example-pack', expected_revision: detail.revision, request_id: grant.requestId },
    epochs: 1, batchSize: 5, lr: 1, lrSchedule: 'constant', split: [1, 1, 1], models: await resolveSkillOptModels(engine), modelFlags: {}, modelsStrict: false,
     reflectMaxTokens: 2048, mode: 'patch', optimizerMode: 'reflect', dryRun: false, noMutate: false, allowMutateBundled: false, bootstrapReviewed: false,
    maxCostUsd: 1, maxCostSource: 'user', maxRuntimeMin: 20, force: true };
  const job = await submitCodexSkillOpt(engine, input, scope(), grant);
  return { jobId: job.id, input, grant, initialRevision: detail.revision };
}

async function seedCycle() {
  addSkill('alpha'); addSkill('beta');
  await engine.setConfig('cycle.skillopt.enabled', 'true'); await engine.setConfig('skillopt.reflect_max_tokens', '2048');
  await engine.setConfig('cycle.skillopt.codex', JSON.stringify({ sourceId, skillsDir, allowedTools: ['get_page'], allowedSlugPrefixes: ['notes/*'],
    maxSkillsPerCycle: 2, maxAttemptsPerSkill: 300, maxTurnsPerSkill: 300 }));
  const job = await queue.add('autopilot-global-maintenance', { phases: ['skillopt'] }, { max_attempts: 1, max_stalled: 3, lock_duration_ms: 900000 },
    { allowProtectedSubmit: true, codexSubscription: { maxAttempts: 600, maxTurns: 600, deadline: new Date(Date.now() + 3600000) } });
  return { jobId: job.id };
}

async function pause(): Promise<never> {
  console.log('OPTIMIZER_RETAINED');
  await new Promise<void>(() => { setInterval(() => {}, 1000); });
  throw new Error('unreachable');
}
function injectCrash(): void {
  if (point === 'shared-result') {
    spyOn(publication, 'withSharedOptimizerPublication').mockImplementation(async () => pause());
  } else if (point === 'shared-committed') {
    const original = shared.saveSharedOptimizerResult;
    spyOn(shared, 'saveSharedOptimizerResult').mockImplementation(async (...args) => { if (args[3]) await pause(); return original(...args); });
  } else if (point === 'cycle-file') {
    const original = files.publishOptimizerFile;
    spyOn(files, 'publishOptimizerFile').mockImplementationOnce(async (...args) => { await original(...args); await pause(); });
  } else {
    const original = cycles.finishOptimizerCycle;
    spyOn(cycles, 'finishOptimizerCycle').mockImplementationOnce(async (...args) => { await original(...args); await pause(); });
  }
}

async function inspectRecovery(jobId: number) {
  expect(await queue.getJob(jobId)).toMatchObject({ status: 'active', lock_token: 'killed-group-worker' });
  const name = isShared ? 'skillopt' : 'autopilot-global-maintenance';
  expect(await queue.claim('premature-worker', 900000, 'default', [name])).toBeNull();
  const [grant] = await engine.executeRaw<{ run_id: string; max_attempts: number; max_turns: number; deadline: Date | string }>(
    'SELECT run_id,max_attempts,max_turns,deadline FROM codex_subscription_runs WHERE parent_run_id IS NULL');
  expect(grant).toBeDefined();
  expect(await engine.executeRaw("SELECT attempt_id FROM codex_subscription_attempts WHERE state IN ('active','unresolved')")).toHaveLength(0);
  let identity: unknown;
  if (isShared) {
    const plan = await shared.readSharedOptimizer(engine, grant!.run_id);
    expect(plan?.result?.outcome).toBe('accepted'); expect(plan?.response).toBeNull();
    expect(calls()).toBe(66);
    expect(readFileSync(join(skillsDir, 'synthetic-skill/SKILL.md'), 'utf8')).toBe(point === 'shared-committed' ? finalText : initialText);
    expect(plan?.admission !== null).toBe(point === 'shared-committed');
    identity = { request_id: plan!.request_id, input_hash: plan!.input_hash, stageRoot: plan!.input.stageRoot };
  } else {
    const cycle = await cycles.readOptimizerCycle(engine, grant!.run_id);
    expect(cycle?.selection).toEqual(['alpha', 'beta']);
    expect(cycle?.state).toBe(point === 'cycle-complete' ? 'complete' : 'pending');
    expect(calls()).toBe(point === 'cycle-complete' ? 410 : 205);
    expect(await engine.getConfig('autopilot.last_global_at')).toBeNull();
    expect(existsSync(join(skillsDir, 'beta/skillopt-proposed.md'))).toBe(point === 'cycle-complete');
    const [saved] = await engine.executeRaw('SELECT input_hash,selection_hash,settled_at FROM codex_skillopt_cycles'); identity = saved;
    addSkill('gamma'); // A new candidate must not alter the retained selection on restart.
  }
  await engine.executeRaw("UPDATE minion_jobs SET lock_until=now()-interval '1 second' WHERE id=$1 AND lock_token='killed-group-worker'", [jobId]);
  for (const table of ['codex_skillopt_runs', 'codex_shared_skill_optimizations', 'codex_skillopt_batches']) {
    // Every row is synthetic and belongs to this one job's retained tree. Only time advances.
    await engine.executeRaw(`UPDATE ${table} SET lease_until=now()-interval '1 second' WHERE owner_token IS NOT NULL`);
  }
  if (!isShared) {
    const locks = await engine.executeRaw<{ id: string }>('SELECT id FROM gbrain_cycle_locks');
    expect(locks.length).toBeGreaterThan(0);
    for (const lock of locks) {
      const snapshot = (await inspectLock(engine, lock.id))!;
      let dead = false;
      try { process.kill(snapshot.holder_pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      expect(dead).toBe(true);
      // Exercise the real same-host dead-holder grace instead of deleting or aging the lock row.
      await new Promise(resolve => setTimeout(resolve, Math.max(0, HOLDER_TAKEOVER_GRACE_MS - snapshot.age_ms + 100)));
    }
  }
  const stalled = await queue.handleStalled(0);
  expect(stalled.requeued.map(row => row.id)).toEqual([jobId]); expect(stalled.dead).toHaveLength(0);
  return { grant: grant!, identity, calls: calls() };
}

async function verifyShared(saved: any, runId: string, identity: unknown, result: Record<string, unknown>): Promise<void> {
  expect(result).toMatchObject({ outcome: 'accepted', mutated_skill_file: true, shared_optimization: { publication: { state: 'committed' } } });
  const plan = (await shared.readSharedOptimizer(engine, runId))!;
  expect(identity).toEqual({ request_id: plan.request_id, input_hash: plan.input_hash, stageRoot: plan.input.stageRoot });
  expect(plan.response?.sharedOptimization?.publication?.state).toBe('committed');
  const detail = await getSharedSkill(context(), { name: 'synthetic-skill' });
  expect(detail.body).toBe(finalText); expect(detail.revision).not.toBe(saved.initialRevision);
  expect(readFileSync(join(skillsDir, 'synthetic-skill/SKILL.md'), 'utf8')).toBe(finalText);
  expect(readFileSync(join(skillsDir, 'synthetic-skill/benchmark.jsonl'), 'utf8')).toBe(benchmark(15));
  expect(readFileSync(join(skillsDir, 'synthetic-skill/reference.md'), 'utf8')).toBe('Immutable approved reference.');
  expect(await engine.executeRaw('SELECT state,protocol_version FROM persistence_requests WHERE request_id=$1::uuid', [saved.grant.requestId])).toEqual([{ state: 'committed', protocol_version: 6 }]);
  expect(await engine.executeRaw('SELECT revision FROM shared_skill_revisions WHERE source_id=$1 AND name=$2', [sourceId, 'synthetic-skill'])).toHaveLength(2);
  expect((await submitCodexSkillOpt(engine, saved.input, scope(), { ...saved.grant, deadline: new Date(saved.grant.deadline) })).id).toBe(saved.jobId);
}

async function verifyCycle(runId: string, identity: any, result: Record<string, unknown>): Promise<void> {
  expect(result).toMatchObject({ report: { phases: [expect.objectContaining({ phase: 'skillopt', status: 'ok', details: expect.objectContaining({ skills_run: 2, accepted: 2 }) })] } });
  const cycle = await cycles.readOptimizerCycle(engine, runId);
  expect(cycle).toMatchObject({ selection: ['alpha', 'beta'], state: 'complete', input_hash: identity.input_hash, selection_hash: identity.selection_hash });
  expect(await engine.executeRaw('SELECT state FROM codex_skillopt_batches')).toEqual([{ state: 'complete' }]);
  expect(await engine.executeRaw('SELECT state FROM codex_skillopt_runs ORDER BY run_id')).toEqual([{ state: 'complete' }, { state: 'complete' }]);
  for (const name of ['alpha', 'beta']) {
    expect(readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8')).toBe(initialText);
    expect(readFileSync(join(skillsDir, name, 'skillopt-proposed.md'), 'utf8')).toBe(finalText);
  }
  expect(existsSync(join(skillsDir, 'gamma/skillopt-proposed.md'))).toBe(false);
  if (point === 'cycle-complete') expect(await engine.executeRaw('SELECT settled_at FROM codex_skillopt_cycles')).toEqual([{ settled_at: identity.settled_at }]);
  expect(await engine.getConfig('autopilot.last_global_at')).not.toBeNull();
  expect((await readGlobalMaintenanceProgress(engine)).running_phase).toBeUndefined();
}

async function execute(): Promise<void> {
  const saved = JSON.parse(readFileSync(join(root, 'submission.json'), 'utf8'));
  const before = mode === 'recover' ? await inspectRecovery(saved.jobId) : undefined;
  const name = isShared ? 'skillopt' : 'autopilot-global-maintenance';
  const job = await queue.claim(mode === 'crash' ? 'killed-group-worker' : 'recovery-group-worker', 900000, 'default', [name]);
  expect(job?.id).toBe(saved.jobId);
  const ctx = buildJobContext(engine, queue, job!, job!.lock_token!, new AbortController().signal, new AbortController().signal);
  const original = drafts.writeBootstrapDraft;
  spyOn(drafts, 'writeBootstrapDraft').mockImplementation((...args) => { original(...args); appendFileSync(join(root, 'writes.jsonl'), JSON.stringify({ path: args[0].outputPath }) + '\n'); });
  if (mode === 'crash') injectCrash();
  const handle = async (): Promise<Record<string, unknown>> => {
    const value = isShared ? await runSkillOptJob(engine, job!.data, ctx) : await makeAutopilotGlobalMaintenanceHandler(engine)(ctx);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object workflow result');
    return value as Record<string, unknown>;
  };
  const result = await runWithJobSpend(engine, job!, ctx, handle);
  expect(mode).toBe('recover');
  if (isShared) await verifyShared(saved, before!.grant.run_id, before!.identity, result);
  else await verifyCycle(before!.grant.run_id, before!.identity, result);
  const total = isShared ? 66 : 410;
  expect(calls()).toBe(total); expect(await engine.executeRaw('SELECT attempt_id FROM codex_subscription_attempts')).toHaveLength(total);
  expect(await engine.executeRaw('SELECT run_id,max_attempts,max_turns,deadline FROM codex_subscription_runs WHERE parent_run_id IS NULL')).toEqual([before!.grant]);
  const [usage] = await engine.executeRaw<{ attempts: number; accepted_turns: number }>('SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE parent_run_id IS NULL');
  expect(Number(usage!.attempts)).toBe(total); expect(Number(usage!.accepted_turns)).toBe(total);
  const again = await runWithJobSpend(engine, job!, ctx, handle);
  expect(calls()).toBe(total);
  if (isShared) expect(again).toEqual(result);
  else await verifyCycle(before!.grant.run_id, before!.identity, again);
  expect((await queue.completeJob(job!.id, job!.lock_token!, { ...result }))?.status).toBe('completed');
  console.log('OPTIMIZER_RECOVERED');
}

try {
  if (mode === 'seed') { await engine.initSchema(); writeFileSync(join(root, 'submission.json'), JSON.stringify(isShared ? await seedShared() : await seedCycle())); }
  else await execute();
} finally { await disposePersistenceConsumer(engine); unregister(); await engine.disconnect(); }
