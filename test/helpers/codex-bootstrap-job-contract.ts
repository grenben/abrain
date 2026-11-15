import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { runSkillOptJob } from '../../src/core/skillopt/job.ts';
import { submitCodexBootstrapJob } from '../../src/core/skillopt/codex-bootstrap-job.ts';
import { BOOTSTRAP_PENDING_REVIEW } from '../../src/core/skillopt/types.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import type { ModelsPlanEntry, StrictVerdict } from '../../src/core/skillopt/models-plan.ts';
import { runSkillOptCommand } from '../../src/commands/skillopt.ts';

interface Fixture {
  engine: () => BrainEngine; queue: () => MinionQueue; replies: (...values: unknown[]) => void; calls: () => unknown[];
}

export function codexBootstrapJobContract(f: Fixture) {
  describe('background Codex benchmark bootstrap jobs', () => {
    let skillsDir: string, skillName: string, skill: string, routing: string, output: string;
    let requestId: string, deadline: Date;
    let scratch: string;
    const opts = (engine: BrainEngine) => ({ engine, operationContext: { engine, sourceId: 'default', remote: false, dryRun: false,
      config: {} as any, logger: { info: () => {}, warn: () => {}, error: () => {} } },
      mode: 'skill' as const, skillsDir, skillName, optimizer: { model: 'codex-cli:gpt-test', source: 'cli_flag' as const, origin: 'explicit test pin' },
      taskCount: 2, force: false, dryRun: false, modelsStrict: false, maxCostUsd: 5, maxCostSource: 'default' as const });
    const plan: { plan: ModelsPlanEntry[]; strict: StrictVerdict } = { plan: [{ touchpoint: 'optimizer', model: 'codex-cli:gpt-test', source: 'cli_flag', origin: 'explicit test pin', active: true }],
      strict: { enabled: false, ok: true, violations: [] } };
    const allowance = () => ({ requestId, maxAttempts: 3, maxTurns: 3, deadline, auxiliaryUsd: 1 });
    const cliArgs = () => [skillName, '--skills-dir', skillsDir, '--bootstrap-from-skill', '--bootstrap-tasks', '2', '--background', '--json',
      '--source', 'default', '--read-prefix', 'notes/*', '--codex-request-id', requestId, '--codex-max-attempts', '3', '--codex-max-turns', '3', '--codex-deadline', deadline.toISOString()];
    const runCli = async (engine: BrainEngine) => {
      const stdout: string[] = [], stderr: string[] = [], exits: number[] = [];
      const exit = spyOn(process, 'exit').mockImplementation(code => { exits.push(Number(code)); return undefined as never; });
      const out = spyOn(process.stdout, 'write').mockImplementation(value => { stdout.push(String(value)); return true; });
      const err = spyOn(process.stderr, 'write').mockImplementation(value => { stderr.push(String(value)); return true; });
      try { await runSkillOptCommand(engine, cliArgs()); } finally { exit.mockRestore(); out.mockRestore(); err.mockRestore(); }
      return { stdout: stdout.join(''), stderr: stderr.join(''), exits };
    };
    const submit = (engine: BrainEngine) => submitCodexBootstrapJob(engine, opts(engine), plan,
      { sourceId: 'default', allowedTools: ['get_page'], allowedSlugPrefixes: ['notes/*'] }, allowance());

    beforeEach(() => {
      skillName = 'synthetic-skill'; scratch = process.env.GBRAIN_TEST_SCRATCH ?? tmpdir(); skillsDir = join(scratch, `gbrain-test-background-bootstrap-${randomUUID()}`);
      mkdirSync(join(skillsDir, skillName), { recursive: true }); skill = join(skillsDir, skillName, 'SKILL.md');
      routing = join(skillsDir, skillName, 'routing-eval.jsonl'); output = join(skillsDir, skillName, 'skillopt-benchmark.jsonl');
      writeFileSync(skill, '---\nname: synthetic-skill\ntools: [search]\n---\n## Method\nUse grounded evidence.\n');
      writeFileSync(routing, ['First grounded task', 'Second grounded task'].map(intent => JSON.stringify({ intent, expected_skill: skillName })).join('\n'));
      requestId = randomUUID(); deadline = new Date(Date.now() + 3600000); f.replies({ autoBootstrap: true });
    });
    afterEach(() => { if (skillsDir) rmSync(skillsDir, { recursive: true, force: true }); });

    test('CLI queues on PostgreSQL and refuses background mode on PGLite', async () => {
      const engine = f.engine(), before = f.calls().length, result = await runCli(engine);
      if (engine.kind === 'pglite') {
        expect(result.exits).toEqual([2]); expect(result.stderr).toContain('requires PostgreSQL');
        expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='skillopt'")).toHaveLength(0);
      } else {
        expect(result.exits).toEqual([0]); expect(result.stdout).toMatch(/^job_id=\d+\n$/);
        expect(result.stderr).toContain('monetary cost unknown');
        expect(await engine.executeRaw('SELECT job_id FROM codex_skillopt_bootstraps WHERE request_id=$1::uuid', [requestId])).toHaveLength(1);
      }
      expect(f.calls().length).toBe(before);
    });

    test('submits idempotently without inference, then the worker publishes a retained review draft', async () => {
      const engine = f.engine(), before = f.calls().length;
      const first = await submit(engine), replay = await submit(engine);
      expect(first).toMatchObject({ name: 'skillopt', status: 'waiting' }); expect(replay.id).toBe(first.id);
      expect(f.calls().length).toBe(before);
      const worker = new MinionWorker(engine, { concurrency: 1, pollInterval: 15, healthCheckInterval: 0, maxRssMb: 0 });
      worker.register('skillopt', ctx => runSkillOptJob(engine, ctx.data, ctx)); const running = worker.start();
      try {
        const limit = Date.now() + 10000; let job = await f.queue().getJob(first.id);
        while (Date.now() < limit && !['completed', 'dead'].includes(job?.status ?? '')) { await new Promise(r => setTimeout(r, 25)); job = await f.queue().getJob(first.id); }
        expect(job?.status).toBe('completed'); expect(job?.result).toMatchObject({ cost_usd: null, remaining_quota: null, result: { rowsGenerated: 2 } });
      } finally { worker.stop(); await running; await disposePersistenceConsumer(engine); }
      expect(readFileSync(output, 'utf8')).toContain(BOOTSTRAP_PENDING_REVIEW);
      expect(f.calls().length - before).toBe(1);
      const [binding] = await engine.executeRaw<{ request_id: string; job_id: number | bigint; completed: boolean }>(
        'SELECT request_id::text,job_id,completed FROM codex_skillopt_bootstraps WHERE request_id=$1::uuid', [requestId]);
      expect(binding?.request_id).toBe(requestId); expect(Number(binding?.job_id)).toBe(first.id); expect(binding?.completed).toBe(true);
      expect(await f.queue().removeJob(first.id)).toBe(false);
    });

    test('changed source material cannot reuse a queued bootstrap request', async () => {
      const engine = f.engine(), before = f.calls().length;
      await submit(engine); writeFileSync(skill, '---\nname: synthetic-skill\ntools: [search]\n---\n## Method\nUse newly grounded evidence.\n');
      await expect(submit(engine)).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
      expect(f.calls().length).toBe(before);
    });

    test('a request reserved by optimizer or batch submission cannot change purpose', async () => {
      const engine = f.engine(), reservation = await f.queue().add('identity-reservation', {}, {}), hash = 'a'.repeat(64);
      await engine.executeRaw('INSERT INTO codex_skillopt_submissions(request_id,protocol,input_hash,data_hash,job_id) VALUES($1::uuid,1,$2,$2,$3)', [requestId, hash, reservation.id]);
      await engine.executeRaw('INSERT INTO codex_skillopt_batch_submissions(request_id,protocol,request_hash,data_hash,job_id) VALUES($1::uuid,1,$2,$2,$3)', [requestId, hash, reservation.id]);
      await expect(submit(engine)).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
      expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='skillopt'")).toHaveLength(0);
      expect(f.calls()).toHaveLength(0);
    });

    test('missing terminal completion fails the job and retains an unresolved account attempt', async () => {
      const engine = f.engine(), before = f.calls().length; f.replies({ missingCompletion: true });
      const jobReceipt = await submit(engine), worker = new MinionWorker(engine, { concurrency: 1, pollInterval: 15, healthCheckInterval: 0, maxRssMb: 0 });
      worker.register('skillopt', ctx => runSkillOptJob(engine, ctx.data, ctx)); const running = worker.start();
      try {
        const limit = Date.now() + 10000; let job = await f.queue().getJob(jobReceipt.id);
        while (Date.now() < limit && !['dead', 'completed'].includes(job?.status ?? '')) { await new Promise(r => setTimeout(r, 25)); job = await f.queue().getJob(jobReceipt.id); }
        expect(job?.status).toBe('dead'); expect(readFileSync(skill, 'utf8')).toContain('Use grounded evidence.');
        expect(f.calls().length - before).toBe(1);
        expect(await engine.executeRaw<{ state: string }>(`SELECT state FROM codex_subscription_attempts
          WHERE run_id LIKE $1 AND state='unresolved'`, [`codex-job:${jobReceipt.id}:%`])).toHaveLength(1);
      } finally { worker.stop(); await running; await disposePersistenceConsumer(engine); }
    });
  });
}
