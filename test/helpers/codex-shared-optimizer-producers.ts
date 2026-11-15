import { describe, expect, spyOn, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SkillOptOpts } from '../../src/core/skillopt/types.ts';
import type { MinionJob } from '../../src/core/minions/types.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { buildJobContext } from '../../src/core/minions/job-context.ts';
import { runWithJobSpend } from '../../src/core/minions/spend-authorization.ts';
import { resolveSkillOptModels } from '../../src/core/skillopt/models-plan.ts';
import { submitCodexSkillOpt } from '../../src/core/skillopt/codex-job.ts';
import { runSkillOptJob, type SkillOptJobInput } from '../../src/core/skillopt/job.ts';
import { runSkillOptCommand } from '../../src/commands/skillopt.ts';
import * as progress from '../../src/core/skillopt/codex-run-store.ts';
import * as publication from '../../src/core/shared-skills/codex-optimizer-store.ts';
interface Fixture { engine(): BrainEngine; opts(): SkillOptOpts; skill(): string; text: string; calls(): any[] }
export function codexSharedOptimizerProducers(f: Fixture) {
  describe('shared optimizer producers', () => {
    const grant = () => ({ requestId: f.opts().sharedSkill!.request_id, maxAttempts: 150, maxTurns: 150, deadline: new Date(Date.now() + 3600000) });
    const queue = () => new MinionQueue(f.engine());
    const input = async (): Promise<SkillOptJobInput> => {
      const { engine, operationContext, ...values } = f.opts();
      const benchmarkPath = values.benchmarkPath;
      if (!benchmarkPath) throw new Error('shared optimizer fixture requires an explicit benchmark path');
      return { ...values, benchmarkPath, optimizerMode: 'reflect', models: await resolveSkillOptModels(f.engine()), modelFlags: {}, modelsStrict: false };
    };
    const submit = async (g = grant(), extra: Partial<SkillOptJobInput> = {}) => submitCodexSkillOpt(f.engine(), { ...await input(), ...extra },
      { operationContext: f.opts().operationContext, codex: f.opts().codex }, g);
    const claim = async () => { const job = await queue().claim('shared-optimizer-worker', 900000, 'default', ['skillopt']); if (!job) throw new Error('fixture claim missing'); return job; };
    const execute = (job: MinionJob) => {
      const context = buildJobContext(f.engine(), queue(), job, job.lock_token!, new AbortController().signal, new AbortController().signal);
      return runWithJobSpend(f.engine(), job, context, () => runSkillOptJob(f.engine(), job.data, context));
    };
    test('the actual worker publishes the bound shared revision and repeated submission returns its job', async () => {
      const g = grant(), submitted = await submit(g); expect((await submit(g)).id).toBe(submitted.id); expect(f.calls()).toHaveLength(0);
      const worker = new MinionWorker(f.engine(), { concurrency: 1, pollInterval: 25, healthCheckInterval: 0, maxRssMb: 0 });
      worker.register('skillopt', ctx => runSkillOptJob(f.engine(), ctx.data, ctx)); const running = worker.start();
      try {
        const until = Date.now() + 60000; let row = await queue().getJob(submitted.id);
        while (Date.now() < until && !['completed', 'dead', 'failed'].includes(row!.status)) { await new Promise(r => setTimeout(r, 25)); row = await queue().getJob(submitted.id); }
        expect(row?.status).toBe('completed'); expect(row?.result).toMatchObject({ outcome: 'accepted', cost_usd: null,
          mutated_skill_file: true, shared_optimization: { publication: { state: 'committed' } } });
        expect(f.skill()).toContain('Always cite evidence.'); expect((await submit(g)).id).toBe(submitted.id); expect(f.calls()).toHaveLength(66);
      } finally { await worker.stop(); await running; }
    });
    test('discovery-enabled shared optimizer retains child scope through canonical publication', async () => {
      const g = grant(), base = f.opts(), scope = { operationContext: base.operationContext,
        codex: { ...base.codex!, allowedTools: ['get_page', 'list_pages'], readRegistry: 'codex-discovery-v1' as const } };
      const options = await input(), submitted = await submitCodexSkillOpt(f.engine(), options, scope, g);
      expect(submitted.data.read_registry).toBe('codex-discovery-v1');
      expect(await execute(await claim())).toMatchObject({ outcome: 'accepted', shared_optimization: { publication: { state: 'committed' } } });
      const children = await f.engine().executeRaw<{ registry: string }>("SELECT data->>'read_registry' AS registry FROM minion_jobs WHERE name='subagent'");
      expect(children.length).toBeGreaterThan(0); expect(children.every(r => r.registry === 'codex-discovery-v1')).toBe(true);
      expect(f.skill()).toContain('Always cite evidence.');
      expect((await submitCodexSkillOpt(f.engine(), options, scope, g)).id).toBe(submitted.id); expect(f.calls()).toHaveLength(66);
    });
    test('queued target, input and allowance changes cannot become new work', async () => {
      const g = grant(); await submit(g);
      await expect(submit({ ...g, maxAttempts: 151 })).rejects.toThrow();
      await expect(submit(g, { epochs: 2 })).rejects.toThrow();
      writeFileSync(join(f.opts().skillsDir, f.opts().skillName, 'SKILL.md'), f.text + '\nConcurrent edit.\n');
      await expect(execute(await claim())).rejects.toThrow();
      expect(await f.engine().executeRaw('SELECT run_id FROM codex_shared_skill_optimizations')).toHaveLength(0);
      expect(await f.engine().executeRaw('SELECT id FROM minion_jobs')).toHaveLength(1); expect(f.calls()).toHaveLength(0);
    });
    test('changed effective output limits refuse the queued shared identity before inference', async () => {
      const key = 'skillopt.reflect_max_tokens', original = await f.engine().getConfig(key);
      try {
        await f.engine().setConfig(key, '2048'); await submit(grant(), { reflectMaxTokens: undefined });
        await f.engine().setConfig(key, '3072');
        await expect(execute(await claim())).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
        expect(f.calls()).toHaveLength(0); expect(f.skill()).toBe(f.text);
        expect(await f.engine().executeRaw('SELECT run_id FROM codex_shared_skill_optimizations')).toHaveLength(0);
      } finally {
        if (original === null) await f.engine().executeRaw('DELETE FROM config WHERE key=$1', [key]);
        else await f.engine().setConfig(key, original);
      }
    });
    test('a replaced worker resumes checkpoints with the same canonical request', async () => {
      const submitted = await submit(), old = await claim(), original = progress.saveOptimizerCheckpoint;
      const fault = spyOn(progress, 'saveOptimizerCheckpoint').mockImplementationOnce(async (...args) => {
        await original(...args); await f.engine().executeRaw("UPDATE minion_jobs SET lock_token='shared-new-owner',codex_claim_token=claim_generation+1,claim_generation=claim_generation+1 WHERE id=$1", [submitted.id]);
      });
      try { await expect(execute(old)).rejects.toMatchObject({ code: 'subscription_owner_lost' }); } finally { fault.mockRestore(); }
      expect(f.calls()).toHaveLength(15); expect(f.skill()).toBe(f.text);
      expect(await execute((await queue().getJob(submitted.id))!)).toMatchObject({ outcome: 'accepted', mutated_skill_file: true });
      expect(f.calls()).toHaveLength(66);
    });
    test('a committed canonical effect survives a lost worker acknowledgement', async () => {
      const g = grant(), submitted = await submit(g), job = await claim(), original = publication.saveSharedOptimizerResult;
      const fault = spyOn(publication, 'saveSharedOptimizerResult').mockImplementation(async (...args) => {
        if (args[3]) throw new Error('synthetic shared worker acknowledgement loss'); return original(...args);
      });
      try { await expect(execute(job)).rejects.toThrow('synthetic shared worker acknowledgement loss'); } finally { fault.mockRestore(); }
      expect(f.skill()).toContain('Always cite evidence.'); expect((await submit(g)).id).toBe(submitted.id);
      expect(await execute(job)).toMatchObject({ outcome: 'accepted', mutated_skill_file: true }); expect(f.calls()).toHaveLength(66);
    });
    test('old protocols and direct handler calls cannot execute a shared payload', async () => {
      const submitted = await submit();
      await expect(runSkillOptJob(f.engine(), submitted.data)).rejects.toMatchObject({ code: 'subscription_required' });
      await expect(queue().add('skillopt', { ...submitted.data, optimizer_protocol: 'codex-skillopt-workflow-v1' }, {},
        { allowProtectedSubmit: true, codexSubscription: grant() })).rejects.toThrow();
      expect(f.calls()).toHaveLength(0); expect(await f.engine().executeRaw('SELECT id FROM minion_jobs')).toHaveLength(1);
    });
    test('exhausted shared jobs retain their allowance and leave canonical content unchanged', async () => {
      const g = { ...grant(), maxAttempts: 2, maxTurns: 2 }, submitted = await submit(g), job = await claim();
      await expect(execute(job)).rejects.toMatchObject({ code: 'subscription_exhausted' });
      expect((await submit(g)).id).toBe(submitted.id); await expect(execute(job)).rejects.toThrow();
      expect(f.calls()).toHaveLength(2); expect(f.skill()).toBe(f.text);
    });
    const cli = (g: ReturnType<typeof grant>, extra: string[] = []) => {
      const opts = f.opts(), target = opts.sharedSkill!;
      const benchmarkPath = opts.benchmarkPath;
      if (!benchmarkPath) throw new Error('shared optimizer fixture requires an explicit benchmark path');
      return [opts.skillName, '--shared-skill', '--pack-id', target.pack_id, '--source-incarnation', target.source_incarnation,
        '--expected-revision', target.expected_revision, '--source', target.source_id, '--read-prefix', 'notes/*', '--benchmark', benchmarkPath,
        '--epochs', '1', '--batch-size', '5', '--lr', '1', '--lr-schedule', 'constant', '--split', '1:1:1', '--reflect-max-tokens', '2048',
        '--force', '--json', '--codex-request-id', g.requestId, '--codex-max-attempts', '150', '--codex-max-turns', '150', '--codex-deadline', g.deadline.toISOString(), ...extra];
    };
    test('foreground CLI resolves the canonical owner and returns a repeatable publication receipt', async () => {
      const g = grant(), exits: number[] = [], output: string[] = [];
      const exit = spyOn(process, 'exit').mockImplementation(code => { exits.push(Number(code)); return undefined as never; });
      const out = spyOn(process.stdout, 'write').mockImplementation(value => { output.push(String(value)); return true; });
      try { await runSkillOptCommand(f.engine(), cli(g)); await runSkillOptCommand(f.engine(), cli(g)); }
      finally { exit.mockRestore(); out.mockRestore(); }
      expect(exits).toEqual([0, 0]);
      const results = output.map(line => JSON.parse(line));
      expect(results).toHaveLength(2);
      expect(results.map(result => result.shared_optimization)).toEqual([
        expect.objectContaining({ proposal_id: g.requestId, publication: expect.objectContaining({ state: 'committed' }) }),
        expect.objectContaining({ proposal_id: g.requestId, publication: expect.objectContaining({ state: 'committed' }) }),
      ]);
      expect(f.skill()).toContain('Always cite evidence.'); expect(f.calls()).toHaveLength(66);
    });
    test('background CLI carries the shared target through native queue admission', async () => {
      const g = grant(), exits: number[] = [];
      const exit = spyOn(process, 'exit').mockImplementation(code => { exits.push(Number(code)); return undefined as never; });
      const out = spyOn(process.stdout, 'write').mockImplementation(() => true);
      try { await runSkillOptCommand(f.engine(), cli(g, ['--background'])); }
      finally { exit.mockRestore(); out.mockRestore(); }
      expect(exits).toEqual([0]); expect(f.calls()).toHaveLength(f.engine().kind === 'pglite' ? 66 : 0);
      if (f.engine().kind !== 'pglite') expect(await execute(await claim())).toMatchObject({ mutated_skill_file: true });
      expect(f.skill()).toContain('Always cite evidence.'); expect(f.calls()).toHaveLength(66);
    });
    test('invalid CLI benchmark preflight cannot persist an unused allowance or shared plan', async () => {
      const path = join(f.opts().skillsDir, 'invalid-benchmark.jsonl'); writeFileSync(path, 'not valid JSONL');
      const g = grant(), args = cli(g); args[args.indexOf('--benchmark') + 1] = path;
      const exits: number[] = [];
      const exit = spyOn(process, 'exit').mockImplementation(code => { exits.push(Number(code)); return undefined as never; });
      const out = spyOn(process.stdout, 'write').mockImplementation(() => true);
      try { await runSkillOptCommand(f.engine(), args); }
      finally { exit.mockRestore(); out.mockRestore(); }
      expect(exits).toEqual([2]); expect(f.calls()).toHaveLength(0);
      expect(await f.engine().executeRaw('SELECT run_id FROM codex_shared_skill_optimizations')).toHaveLength(0);
      expect(await f.engine().executeRaw('SELECT run_id FROM codex_subscription_runs WHERE run_id LIKE $1', ['codex-%'])).toHaveLength(0);
    });
    test('CLI dry-run validates the shared target without granting or publishing work', async () => {
      const exit = spyOn(process, 'exit').mockImplementation(() => undefined as never), out = spyOn(process.stdout, 'write').mockImplementation(() => true);
      try { await runSkillOptCommand(f.engine(), cli(grant(), ['--dry-run'])); }
      finally { exit.mockRestore(); out.mockRestore(); }
      expect(f.calls()).toHaveLength(0); expect(f.skill()).toBe(f.text);
      expect(await f.engine().executeRaw('SELECT run_id FROM codex_shared_skill_optimizations')).toHaveLength(0);
      expect(await f.engine().executeRaw('SELECT run_id FROM codex_subscription_runs WHERE run_id LIKE $1', ['codex-%'])).toHaveLength(0);
    });
  });
}
