import { describe, expect, test, beforeEach, spyOn } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SkillOptOpts } from '../../src/core/skillopt/types.ts';
import { runSkillOpt } from '../../src/core/skillopt/orchestrator.ts';
import { createSubscriptionRun } from '../../src/core/ai/subscription-admission.ts';
import { withCodexSubscription } from '../../src/core/ai/subscription-context.ts';
import { CODEX_JOB_ACCOUNT_LANE } from '../../src/core/minions/subscription-jobs.ts';
import * as store from '../../src/core/skillopt/codex-run-store.ts';
import * as files from '../../src/core/skillopt/codex-run-files.ts';
import { withSkillOptAllowance } from '../../src/core/skillopt/codex-local-grant.ts';
import { runSkillOptCommand } from '../../src/commands/skillopt.ts';
interface Fixture { engine(): BrainEngine; root: string; replies(...values: unknown[]): void; calls(): any[] }
export function codexSkilloptRunContract(f: Fixture) {
  describe('durable Codex optimizer workflow', () => {
    let seq = 0, dir: string, skill: string, benchmark: string;
    const text = '---\nname: synthetic-skill\ndescription: Synthetic benchmark skill.\n---\n# Response\n\nPrefer brevity.\n';
    const tasks = (prefix: string, count = 15) => Array.from({ length: count }, (_, i) => ({ task_id: `${prefix}-${String(i).padStart(2, '0')}`,
      task: `${prefix} task ${i}: give a useful answer.`, judge: { kind: 'rule', checks: [{ op: 'contains', arg: 'evidence' }] } }));
    beforeEach(() => {
      dir = join(f.root, `optimizer-${seq++}`); mkdirSync(join(dir, 'synthetic-skill'), { recursive: true });
      skill = join(dir, 'synthetic-skill', 'SKILL.md'); benchmark = join(dir, 'benchmark.jsonl');
      writeFileSync(skill, text); writeFileSync(benchmark, tasks('benchmark').map(t => JSON.stringify(t)).join('\n'));
      f.replies({ autoOptimizer: true });
    });
    const opts = (extra: Partial<SkillOptOpts> = {}): SkillOptOpts => ({ engine: f.engine(), skillName: 'synthetic-skill', skillsDir: dir, benchmarkPath: benchmark,
      operationContext: { engine: f.engine(), remote: false, sourceId: 'default', config: {} as never, logger: {} as never, dryRun: false },
      codex: { allowedTools: ['get_page'], allowedSlugPrefixes: ['notes/*'] }, epochs: 1, batchSize: 5, lr: 1, lrSchedule: 'constant', split: [1, 1, 1],
      optimizerModel: 'codex-cli:gpt-test', targetModel: 'codex-cli:gpt-test', judgeModel: 'codex-cli:gpt-test', reflectMaxTokens: 2048,
      mode: 'patch', dryRun: false, noMutate: true, allowMutateBundled: false, bootstrapReviewed: false, json: true, maxCostUsd: 1, maxRuntimeMin: 20, force: true,
      ...extra, optimizerMode: extra.optimizerMode ?? 'reflect' });
    async function run<T>(fn: () => Promise<T>, max = 150) {
      await createSubscriptionRun(f.engine(), { runId: 'optimizer-workflow', accountLane: CODEX_JOB_ACCOUNT_LANE,
        maxAttempts: max, maxTurns: max, deadline: new Date(Date.now() + 3600000) });
      return withCodexSubscription({ engine: f.engine(), runId: 'optimizer-workflow' }, fn);
    }
    const localArgs = () => ['--codex-request-id', '123e4567-e89b-42d3-a456-426614174000', '--codex-max-attempts', '150',
      '--codex-max-turns', '150', '--codex-deadline', new Date(Date.now() + 3600000).toISOString(), '--source', 'default', '--read-prefix', 'notes/*'];
    test('local CLI runs the real optimizer and reuses its grant, receipt and accepted draft', async () => {
      const args = ['synthetic-skill', '--skills-dir', dir, '--benchmark', benchmark, '--epochs', '1', '--batch-size', '5', '--lr', '1', '--lr-schedule', 'constant',
        '--split', '1:1:1', '--reflect-max-tokens', '2048', '--no-mutate', '--force', '--json', ...localArgs()];
      const exits: number[] = [], stdout: string[] = [], stderr: string[] = [];
      const exit = spyOn(process, 'exit').mockImplementation(code => { exits.push(Number(code)); return undefined as never; });
      const out = spyOn(process.stdout, 'write').mockImplementation(chunk => { stdout.push(String(chunk)); return true; });
      const err = spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr.push(String(chunk)); return true; });
      try { await runSkillOptCommand(f.engine(), args); await runSkillOptCommand(f.engine(), args); }
      finally { exit.mockRestore(); out.mockRestore(); err.mockRestore(); }
      expect(exits).toEqual([0, 0]);
      const results = stdout.filter(s => s.startsWith('{')).map(s => JSON.parse(s));
      expect(results).toHaveLength(2); expect(results[1]).toEqual(results[0]);
      expect(results[0]).toMatchObject({ outcome: 'accepted', receipt: { final_cost_usd: null, subscription: { attempts: 66 } } });
      expect(stderr.join('')).toContain('subscription request 123e4567-e89b-42d3-a456-426614174000');
      expect(stderr.join('')).not.toContain('cap $'); expect(f.calls()).toHaveLength(66);
      const [row] = await f.engine().executeRaw<{ input: Record<string, any> }>('SELECT input FROM codex_skillopt_runs');
      expect(row!.input.sourceId).toBe('default'); expect(row!.input.codex).toEqual({ allowedTools: ['get_page'], allowedSlugPrefixes: ['notes/*'] });
    });
    test('private CLI rejects an explicit unsupported one-shot optimizer mode before inference', async () => {
      const args = ['synthetic-skill', '--skills-dir', dir, '--benchmark', benchmark, '--optimizer-mode', 'one-shot-rewrite',
        '--json', ...localArgs()];
      const exits: number[] = [], stderr: string[] = [];
      const exit = spyOn(process, 'exit').mockImplementation(code => { exits.push(Number(code)); return undefined as never; });
      const err = spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr.push(String(chunk)); return true; });
      try { await runSkillOptCommand(f.engine(), args); }
      finally { exit.mockRestore(); err.mockRestore(); }
      expect(exits).toEqual([2]); expect(stderr.join('')).toContain('supports reflect mode only');
      expect(f.calls()).toHaveLength(0);
    });
    test('discovery-enabled CLI binds the chosen tools across every optimizer phase', async () => {
      const args = ['synthetic-skill', '--skills-dir', dir, '--benchmark', benchmark, '--epochs', '1', '--batch-size', '5', '--lr', '1', '--lr-schedule', 'constant',
        '--split', '1:1:1', '--reflect-max-tokens', '2048', '--no-mutate', '--force', '--json', ...localArgs(), '--read-tool', 'list_pages', '--read-tool', 'get_page'];
      const exits: number[] = [];
      const exit = spyOn(process, 'exit').mockImplementation(code => { exits.push(Number(code)); return undefined as never; }), out = spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        await runSkillOptCommand(f.engine(), args); await runSkillOptCommand(f.engine(), args);
        const changed = args.filter((v, i, all) => v !== 'list_pages' && !(v === '--read-tool' && all[i + 1] === 'list_pages'));
        await runSkillOptCommand(f.engine(), changed);
      } finally { exit.mockRestore(); out.mockRestore(); }
      const [row] = await f.engine().executeRaw<{ input: any }>('SELECT input FROM codex_skillopt_runs');
      expect(row!.input.codex).toEqual({ allowedTools: ['list_pages', 'get_page'], allowedSlugPrefixes: ['notes/*'], readRegistry: 'codex-discovery-v1' });
      const children = await f.engine().executeRaw<{ registry: string }>("SELECT data->>'read_registry' AS registry FROM minion_jobs WHERE name='subagent'");
      expect(children.length).toBeGreaterThan(0); expect(children.every(r => r.registry === 'codex-discovery-v1')).toBe(true);
      expect(f.calls().filter(c => c.schema.properties.response).every(c => c.schema.properties.response.anyOf.some((b: any) => b.properties.name?.const === 'brain_list_pages'))).toBe(true);
      expect(exits).toEqual([0, 0, 2]); expect(f.calls()).toHaveLength(66);
    });
    test('discovery CLI invalid tools and bootstrap tool requests fail before admission', async () => {
      for (const extra of [['--read-tool', 'shell'], ['--read-tool', 'get_page', '--read-tool', 'get_page'], ['--read-tool', 'list_pages', '--bootstrap-from-skill']])
        await expect(withSkillOptAllowance(f.engine(), [...localArgs(), ...extra], async () => undefined)).rejects.toThrow();
      expect(await f.engine().executeRaw('SELECT run_id FROM codex_subscription_runs')).toHaveLength(0); expect(f.calls()).toHaveLength(0);
    });
    test('local preflight and dry-run never leave an unused durable allowance', async () => {
      const args = localArgs();
      await withSkillOptAllowance(f.engine(), args, async (_, scope) => {
        await expect(runSkillOpt(opts({ ...scope, targetModel: 'anthropic:claude-sonnet-4-6' }))).rejects.toThrow();
        expect(await runSkillOpt(opts({ ...scope, dryRun: true }))).toMatchObject({ mutatedSkillFile: false });
      });
      expect(await f.engine().executeRaw('SELECT run_id FROM codex_subscription_runs')).toHaveLength(0);
      expect(await f.engine().executeRaw('SELECT run_id FROM codex_skillopt_runs')).toHaveLength(0); expect(f.calls()).toHaveLength(0);
    });
    test('local recovery refuses changed limits, source, tool scope and auxiliary cap', async () => {
      const args = localArgs(), localRun = (a: string[]) => withSkillOptAllowance(f.engine(), a, (_, scope) => runSkillOpt(opts(scope)));
      await localRun(args);
      for (const altered of [args.map((v, i) => args[i - 1] === '--codex-max-attempts' ? '151' : v),
        args.map((v, i) => args[i - 1] === '--source' ? 'other' : v), args.map((v, i) => args[i - 1] === '--read-prefix' ? 'notes/one' : v), [...args, '--aux-max-usd', '1']])
        await expect(localRun(altered)).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
      expect(f.calls()).toHaveLength(66);
      expect(await f.engine().executeRaw('SELECT max_attempts,attempts FROM codex_subscription_runs WHERE parent_run_id IS NULL')).toEqual([{ max_attempts: 150, attempts: 66 }]);
    });
    test('local grant identity survives checkpoint acknowledgement loss without refunded calls', async () => {
      const args = localArgs(), localRun = () => withSkillOptAllowance(f.engine(), args, (_, scope) => runSkillOpt(opts(scope)));
      const original = store.saveOptimizerCheckpoint, fault = spyOn(store, 'saveOptimizerCheckpoint').mockImplementationOnce(async (...input) => {
        await original(...input); throw new Error('synthetic local acknowledgement lost');
      });
      try { await expect(localRun()).rejects.toThrow('synthetic local acknowledgement lost'); } finally { fault.mockRestore(); }
      expect(f.calls()).toHaveLength(15); expect((await localRun()).outcome).toBe('accepted'); expect(f.calls()).toHaveLength(66);
    });
    test('local USD-only, missing scope, malformed grant and unsupported producers fail before invocation', async () => {
      let invoked = false;
      for (const args of [[], ['--max-usd', '5'], localArgs().filter(v => v !== '--read-prefix' && v !== 'notes/*'),
        [...localArgs(), '--read-prefix', 'notes/*'], [...localArgs(), '--codex-max-attempts', '10'], [...localArgs(), '--follow']]) {
        await expect(withSkillOptAllowance(f.engine(), args, async () => { invoked = true; })).rejects.toThrow();
      }
      expect(invoked).toBe(false); expect(f.calls()).toHaveLength(0);
      expect(await f.engine().executeRaw('SELECT run_id FROM codex_subscription_runs')).toHaveLength(0);
    });
    test('local cancellation retains acknowledged progress and removes its signal handlers', async () => {
      const args = localArgs(), before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
      const localRun = () => withSkillOptAllowance(f.engine(), args, (_, scope) => runSkillOpt(opts(scope)));
      const original = store.saveOptimizerCheckpoint, fault = spyOn(store, 'saveOptimizerCheckpoint').mockImplementationOnce(async (...input) => {
        await original(...input);
        const cancel = process.listeners('SIGINT').at(-1);
        if (!cancel) throw new Error('local cancellation handler was not registered');
        (cancel as () => void)();
      });
      try { await expect(localRun()).rejects.toMatchObject({ code: 'subscription_owner_lost' }); } finally { fault.mockRestore(); }
      expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
      expect(f.calls()).toHaveLength(15); expect((await localRun()).outcome).toBe('accepted'); expect(f.calls()).toHaveLength(66);
    });
    test('actual entry evaluates baseline, reflection, candidate and final tests before a recoverable draft', async () => {
      await run(async () => {
        const result = await runSkillOpt(opts());
        expect(result).toMatchObject({ outcome: 'accepted', mutatedSkillFile: false, receipt: { baseline_sel_score: 0, best_sel_score: 1, baseline_test_score: 0, test_score: 1, final_cost_usd: null,
          subscription: { cost_usd: null, remaining_quota: null, attempts: 66, accepted_turns: 66, unmeasured_attempts: 0 } } });
        expect(readFileSync(result.proposedPath!, 'utf8')).toContain('Always cite evidence.');
        expect(readFileSync(skill, 'utf8')).toBe(text);
        expect(await runSkillOpt(opts())).toEqual(result);
        expect(await f.engine().executeRaw('SELECT state FROM codex_skillopt_runs')).toEqual([{ state: 'complete' }]);
      }); expect(f.calls()).toHaveLength(66);
    });
    test('an authorized unmanaged skill replacement preserves frontmatter and recovers its own bytes', async () => {
      await run(async () => {
        const result = await runSkillOpt(opts({ noMutate: false }));
        expect(result.mutatedSkillFile).toBe(true); expect(readFileSync(skill, 'utf8')).toBe(text.replace('Prefer brevity.', 'Always cite evidence.'));
        expect(await runSkillOpt(opts({ noMutate: false }))).toEqual(result);
      }); expect(f.calls()).toHaveLength(66);
    });
    test('a valid empty proposal remains no improvement and publishes nothing', async () => {
      f.replies({ autoOptimizer: true, noEdits: true });
      await run(async () => {
        const result = await runSkillOpt(opts({ noMutate: false }));
        expect(result).toMatchObject({ outcome: 'no_improvement', mutatedSkillFile: false, receipt: { best_sel_score: 0, final_cost_usd: null } });
        expect(readFileSync(skill, 'utf8')).toBe(text);
      }); expect(f.calls()).toHaveLength(51);
    });
    test('failed admission never becomes no improvement or a successful file effect', async () => {
      await run(async () => {
        await expect(runSkillOpt(opts({ noMutate: false }))).rejects.toMatchObject({ code: 'subscription_exhausted' });
        expect(readFileSync(skill, 'utf8')).toBe(text);
        expect(await f.engine().executeRaw('SELECT result FROM codex_skillopt_runs')).toEqual([{ result: null }]);
      }, 2); expect(f.calls()).toHaveLength(2);
    });
    test('checkpoint lost acknowledgement resumes the same evaluations and candidate', async () => {
      await run(async () => {
        const original = store.saveOptimizerCheckpoint, fault = spyOn(store, 'saveOptimizerCheckpoint').mockImplementationOnce(async (...args) => {
          await original(...args); throw new Error('synthetic checkpoint lost acknowledgement');
        });
        try { await expect(runSkillOpt(opts())).rejects.toThrow('synthetic checkpoint lost acknowledgement'); } finally { fault.mockRestore(); }
        expect(f.calls()).toHaveLength(15);
        expect((await runSkillOpt(opts())).outcome).toBe('accepted');
      }); expect(f.calls()).toHaveLength(66);
    });
    test('file effect followed by SQL rollback reconciles without regenerating', async () => {
      await run(async () => {
        const original = files.publishOptimizerFile, fault = spyOn(files, 'publishOptimizerFile').mockImplementationOnce(async (...args) => {
          await original(...args); throw new Error('synthetic file acknowledgement lost');
        });
        try { await expect(runSkillOpt(opts({ noMutate: false }))).rejects.toThrow('synthetic file acknowledgement lost'); } finally { fault.mockRestore(); }
        expect(readFileSync(skill, 'utf8')).toContain('Always cite evidence.');
        expect(await f.engine().executeRaw('SELECT state FROM codex_skillopt_runs')).toEqual([{ state: 'computed' }]);
        expect((await runSkillOpt(opts({ noMutate: false }))).mutatedSkillFile).toBe(true);
      }); expect(f.calls()).toHaveLength(66);
    });
    test('changed input and unrelated post-publication edits are preserved', async () => {
      await run(async () => {
        await runSkillOpt(opts({ noMutate: false }));
        await expect(runSkillOpt(opts({ noMutate: false, epochs: 2 }))).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
        writeFileSync(skill, 'Unrelated user work.');
        await expect(runSkillOpt(opts({ noMutate: false }))).rejects.toThrow();
        expect(readFileSync(skill, 'utf8')).toBe('Unrelated user work.');
      }); expect(f.calls()).toHaveLength(66);
    });
    test('rewrite mode uses the complete native body proposal and the same acceptance gates', async () => {
      await run(async () => {
        const result = await runSkillOpt(opts({ mode: 'rewrite' }));
        expect(result).toMatchObject({ outcome: 'accepted', receipt: { best_sel_score: 1 } });
        expect(result.finalText).toBe(text.replace('Prefer brevity.', 'Always cite evidence.'));
      }); expect(f.calls()).toHaveLength(66);
    });
    test('held-out regression rejects an otherwise improved selection score', async () => {
      f.replies({ autoOptimizer: true, heldOutFail: true });
      const held = join(dir, 'held-out.jsonl'); writeFileSync(held, tasks('held-out', 5).map(t => JSON.stringify(t)).join('\n'));
      await run(async () => {
        const result = await runSkillOpt(opts({ heldOutPath: held, noMutate: false }));
        expect(result).toMatchObject({ outcome: 'no_improvement', mutatedSkillFile: false, receipt: { best_sel_score: 0 } });
        const [row] = await f.engine().executeRaw<{ checkpoint: store.OptimizerCheckpoint }>('SELECT checkpoint FROM codex_skillopt_runs');
        expect(row!.checkpoint.decisions).toEqual([{ step: 0, accepted: false, score: 1, reason: 'held_out_regression' }]);
        expect(readFileSync(skill, 'utf8')).toBe(text);
      }); expect(f.calls()).toHaveLength(96);
    });
    test('malformed Markdown is not cached as an accepted optimizer proposal', async () => {
      f.replies({ autoOptimizer: true, badCandidate: true });
      await run(async () => {
        await expect(runSkillOpt(opts())).rejects.toMatchObject({ reason: 'invalid_output' });
        expect(await f.engine().executeRaw('SELECT response_text FROM codex_proposal_cache')).toHaveLength(0);
        expect(await f.engine().executeRaw('SELECT result FROM codex_skillopt_runs')).toEqual([{ result: null }]);
        expect(readFileSync(skill, 'utf8')).toBe(text);
      }); expect(f.calls()).toHaveLength(21);
    });
    test('USD-only admission, conflicting pins and unreviewed benchmarks refuse before calls', async () => {
      await expect(runSkillOpt(opts())).rejects.toMatchObject({ code: 'subscription_required' });
      await run(async () => {
        await expect(runSkillOpt(opts({ targetModel: 'anthropic:claude-sonnet-4-6' }))).rejects.toThrow();
        await expect(runSkillOpt(opts({ modelsStrict: true }))).rejects.toThrow();
        writeFileSync(benchmark, readFileSync(benchmark, 'utf8') + '\n# BOOTSTRAP_PENDING_REVIEW\n');
        await expect(runSkillOpt(opts())).rejects.toThrow();
        expect(await f.engine().executeRaw('SELECT run_id FROM codex_skillopt_runs')).toHaveLength(0);
      }); expect(f.calls()).toHaveLength(0);
    });
    test('dry-run validates inputs and creates no optimizer state or inference', async () => {
      await run(async () => {
        expect(await runSkillOpt(opts({ dryRun: true }))).toMatchObject({ mutatedSkillFile: false, receipt: { final_cost_usd: null } });
        expect(await f.engine().executeRaw('SELECT run_id FROM codex_skillopt_runs')).toHaveLength(0);
      }); expect(f.calls()).toHaveLength(0);
    });
    test('a stale optimizer owner cannot continue or publish after its checkpoint', async () => {
      await run(async () => {
        const original = store.saveOptimizerCheckpoint, fault = spyOn(store, 'saveOptimizerCheckpoint').mockImplementationOnce(async (...args) => {
          await original(...args);
          await f.engine().executeRaw("UPDATE codex_skillopt_runs SET owner_token='123e4567-e89b-42d3-a456-426614174000'::uuid");
        });
        try { await expect(runSkillOpt(opts({ noMutate: false }))).rejects.toMatchObject({ code: 'subscription_owner_lost' }); } finally { fault.mockRestore(); }
        expect(f.calls()).toHaveLength(15); expect(readFileSync(skill, 'utf8')).toBe(text);
        await expect(runSkillOpt(opts({ noMutate: false }))).rejects.toMatchObject({ code: 'subscription_owner_lost' });
        await f.engine().executeRaw("UPDATE codex_skillopt_runs SET lease_until=now()-interval '1 minute'");
        expect((await runSkillOpt(opts({ noMutate: false }))).outcome).toBe('accepted');
      }); expect(f.calls()).toHaveLength(66);
    });
    test('an edit made after validation is preserved instead of overwritten by publication', async () => {
      await run(async () => {
        const original = store.saveOptimizerResult, fault = spyOn(store, 'saveOptimizerResult').mockImplementationOnce(async (...args) => {
          await original(...args); writeFileSync(skill, 'New user revision.');
        });
        try { await expect(runSkillOpt(opts({ noMutate: false }))).rejects.toMatchObject({ reason: 'invalid_input' }); } finally { fault.mockRestore(); }
        expect(readFileSync(skill, 'utf8')).toBe('New user revision.');
        expect(await f.engine().executeRaw('SELECT state FROM codex_skillopt_runs')).toEqual([{ state: 'computed' }]);
        await expect(runSkillOpt(opts({ noMutate: false }))).rejects.toThrow();
        expect(readFileSync(skill, 'utf8')).toBe('New user revision.');
      }); expect(f.calls()).toHaveLength(66);
    });
    test('changing the configured runtime mid-run stops before another call', async () => {
      const path = join(f.root, '.gbrain', 'config.json'), saved = readFileSync(path, 'utf8');
      await run(async () => {
        const original = store.saveOptimizerCheckpoint, fault = spyOn(store, 'saveOptimizerCheckpoint').mockImplementationOnce(async (...args) => {
          await original(...args); const config = JSON.parse(saved); config.private_codex.bin = '/nonexistent/forbidden'; writeFileSync(path, JSON.stringify(config));
        });
        try { await expect(runSkillOpt(opts())).rejects.toMatchObject({ code: 'subscription_identity_conflict' }); }
        finally { fault.mockRestore(); writeFileSync(path, saved); }
        expect(f.calls()).toHaveLength(15);
        expect((await runSkillOpt(opts())).outcome).toBe('accepted');
      }); expect(f.calls()).toHaveLength(66);
    });
  });
}
