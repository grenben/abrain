import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { linkSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import type { SkillOptOpts } from '../../src/core/skillopt/types.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../../src/core/persistence/skill-activation.ts';
import { sharedSkillRetentionStatus } from '../../src/core/shared-skills/retention.ts';
import { getSharedSkill } from '../../src/core/shared-skills/catalog.ts';
import { setSharedSkillPolicy } from '../../src/core/shared-skills/policy.ts';
import { submitSharedSkillMutation } from '../../src/core/shared-skills/publication.ts';
import { createSubscriptionRun } from '../../src/core/ai/subscription-admission.ts';
import { withCodexSubscription } from '../../src/core/ai/subscription-context.ts';
import { CODEX_JOB_ACCOUNT_LANE } from '../../src/core/minions/subscription-jobs.ts';
import { runSkillOpt } from '../../src/core/skillopt/orchestrator.ts';
import * as store from '../../src/core/shared-skills/codex-optimizer-store.ts';
import * as stages from '../../src/core/shared-skills/codex-optimizer-files.ts';
import * as publication from '../../src/core/shared-skills/codex-optimizer-publication.ts';
import { codexSharedOptimizerProducers } from './codex-shared-optimizer-producers.ts';
interface Fixture { engine(): BrainEngine; root: string; replies(...values: unknown[]): void; calls(): any[] }
export function codexSharedOptimizerContract(f: Fixture) {
  describe('native shared optimizer publication', () => {
    let sequence = 0, root: string, runId: string, ctx: OperationContext, opts: SkillOptOpts;
    const text = '---\nname: synthetic-skill\ndescription: Synthetic benchmark skill.\n---\n# Response\n\nPrefer brevity.\n';
    const benchmark = Array.from({ length: 15 }, (_, i) => JSON.stringify({ task_id: `task-${i}`, task: `Synthetic task ${i}.`, judge: { kind: 'rule', checks: [{ op: 'contains', arg: 'evidence' }] } })).join('\n');
    beforeEach(async () => {
      root = join(f.root, `shared-root-${sequence++}`); mkdirSync(root); const sourceId = `shared-${sequence}`; runId = `shared-optimizer-${sequence}`;
      await f.engine().executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      await claimWorktree(f.engine(), sourceId, root); await activateSharedSkillPersistence(f.engine(), { confirmQuiesced: true });
      ctx = { engine: f.engine(), sourceId, remote: false, config: { engine: f.engine().kind }, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
      await f.engine().setConfig('mcp.publish_skills', 'true');
      await setSharedSkillPolicy(ctx, sourceId, { version: 1, enabled: true, classes: ['prose', 'reference'], audiences: ['readers'], requirements: [], allow_follow: true }, null);
      await submitSharedSkillMutation(ctx, 'put_skill', { name: 'synthetic-skill', pack_id: 'example-pack', expected_revision: null, files: [
        { path: 'skills/synthetic-skill/SKILL.md', content: text, file_class: 'prose', depends_on: ['skills/synthetic-skill/benchmark.jsonl', 'skills/synthetic-skill/reference.md'] },
        { path: 'skills/synthetic-skill/benchmark.jsonl', content: benchmark, file_class: 'reference' },
        { path: 'skills/synthetic-skill/reference.md', content: 'Immutable approved reference.', file_class: 'reference' },
      ] });
      const detail = await getSharedSkill(ctx, { name: 'synthetic-skill' });
      opts = { engine: f.engine(), operationContext: ctx, sharedSkill: { source_id: sourceId, source_incarnation: detail.source_incarnation,
        pack_id: 'example-pack', expected_revision: detail.revision, request_id: randomUUID() },
        skillName: 'synthetic-skill', skillsDir: join(root, 'skills'), benchmarkPath: join(root, 'skills/synthetic-skill/benchmark.jsonl'),
        codex: { allowedTools: ['get_page'], allowedSlugPrefixes: ['notes/*'] }, epochs: 1, batchSize: 5, lr: 1, lrSchedule: 'constant', split: [1, 1, 1],
        optimizerModel: 'codex-cli:gpt-test', targetModel: 'codex-cli:gpt-test', judgeModel: 'codex-cli:gpt-test', reflectMaxTokens: 2048,
        mode: 'patch', dryRun: false, noMutate: false, allowMutateBundled: false, bootstrapReviewed: false, json: true, maxCostUsd: 1, maxRuntimeMin: 20, force: true };
      await createSubscriptionRun(f.engine(), { runId: runId, accountLane: CODEX_JOB_ACCOUNT_LANE, maxAttempts: 150, maxTurns: 150, deadline: new Date(Date.now() + 3600000) });
      f.replies({ autoOptimizer: true });
    });
    const run = (value = opts, signal?: AbortSignal) => withCodexSubscription({ engine: f.engine(), runId, signal }, () => runSkillOpt(value));
    const skill = () => readFileSync(join(root, 'skills/synthetic-skill/SKILL.md'), 'utf8');
    codexSharedOptimizerProducers({ engine: f.engine, opts: () => opts, skill, text, calls: f.calls });
    test('actual native optimizer publishes one protocol-6 bundle and replays the same receipt', async () => {
      const result = await run();
      expect(result).toMatchObject({ outcome: 'accepted', mutatedSkillFile: true, sharedOptimization: { publication: { state: 'committed' } }, receipt: { final_cost_usd: null } });
      expect(skill()).toBe(text.replace('Prefer brevity.', 'Always cite evidence.'));
      expect(readFileSync(join(root, 'skills/synthetic-skill/reference.md'), 'utf8')).toBe('Immutable approved reference.');
      expect((await getSharedSkill(ctx, { name: 'synthetic-skill' })).body).toBe(skill());
      expect(await run()).toEqual(result); expect(f.calls()).toHaveLength(66);
      expect((await sharedSkillRetentionStatus(f.engine(), ctx.sourceId, opts.sharedSkill!.source_incarnation)).protected_publications).toBe(1);
      expect(await f.engine().executeRaw('SELECT protocol_version,target_kind FROM persistence_requests WHERE request_id=$1::uuid', [opts.sharedSkill!.request_id])).toEqual([{ protocol_version: 6, target_kind: 'skill_bundle' }]);
    });
    test('staging acknowledgement loss retains one original stage before any inference', async () => {
      const original = stages.stageSharedOptimizer, fault = spyOn(stages, 'stageSharedOptimizer').mockImplementationOnce(input => {
        original(input); throw new Error('synthetic stage acknowledgement lost');
      });
      try { await expect(run()).rejects.toThrow('synthetic stage acknowledgement lost'); } finally { fault.mockRestore(); }
      const [plan] = await f.engine().executeRaw<{ input: store.SharedOptimizerInput }>('SELECT input FROM codex_shared_skill_optimizations');
      expect(f.calls()).toHaveLength(0); expect(skill()).toBe(text);
      expect((await run()).mutatedSkillFile).toBe(true); expect(f.calls()).toHaveLength(66);
      expect(readdirSync(plan!.input.stageRoot)).toContain('skills');
    });
    test('accepted result acknowledgement loss resumes publication without regenerating', async () => {
      const original = store.saveSharedOptimizerResult, fault = spyOn(store, 'saveSharedOptimizerResult').mockImplementationOnce(async (...args) => {
        await original(...args); throw new Error('synthetic result acknowledgement lost');
      });
      try { await expect(run()).rejects.toThrow('synthetic result acknowledgement lost'); } finally { fault.mockRestore(); }
      expect(skill()).toBe(text); expect(f.calls()).toHaveLength(66);
      expect((await run()).mutatedSkillFile).toBe(true); expect(f.calls()).toHaveLength(66);
    });
    test('publication admission acknowledgement loss retains the same canonical request', async () => {
      const original = publication.admitSharedOptimizerWrite, fault = spyOn(publication, 'admitSharedOptimizerWrite').mockImplementationOnce(async (...args) => {
        const row = await original(...args); throw new Error('synthetic publication admission acknowledgement lost');
      });
      try { await expect(run()).rejects.toThrow('synthetic publication admission acknowledgement lost'); } finally { fault.mockRestore(); }
      expect((await run()).mutatedSkillFile).toBe(true); expect(f.calls()).toHaveLength(66);
      expect(await f.engine().executeRaw('SELECT request_id FROM persistence_requests WHERE request_id=$1::uuid', [opts.sharedSkill!.request_id])).toHaveLength(1);
    });
    test('a committed publication with a lost final acknowledgement reuses its receipt', async () => {
      const original = store.saveSharedOptimizerResult, fault = spyOn(store, 'saveSharedOptimizerResult').mockImplementation(async (...args) => {
        if (args[3]) throw new Error('synthetic final acknowledgement lost');
        return original(...args);
      });
      try { await expect(run()).rejects.toThrow('synthetic final acknowledgement lost'); } finally { fault.mockRestore(); }
      expect(skill()).toContain('Always cite evidence.'); expect(f.calls()).toHaveLength(66);
      expect((await run()).mutatedSkillFile).toBe(true); expect(f.calls()).toHaveLength(66);
    });
    test('a stale optimizer owner cannot publish or release a replacement owner', async () => {
      const replacement = randomUUID(), original = store.saveSharedOptimizerResult;
      const fault = spyOn(store, 'saveSharedOptimizerResult').mockImplementationOnce(async (...args) => {
        await original(...args);
        await args[0].executeRaw('UPDATE codex_shared_skill_optimizations SET owner_token=$1::uuid WHERE run_id=$2', [replacement, args[1].runId]);
      });
      try { await expect(run()).rejects.toThrow(); } finally { fault.mockRestore(); }
      expect(skill()).toBe(text); expect(f.calls()).toHaveLength(66);
      expect((await store.readSharedOptimizer(f.engine(), runId))?.owner_token).toBe(replacement);
      await expect(run()).rejects.toThrow(); expect(f.calls()).toHaveLength(66);
      await f.engine().executeRaw("UPDATE codex_shared_skill_optimizations SET lease_until=now()-interval '1 second' WHERE run_id=$1", [runId]);
      expect((await run()).mutatedSkillFile).toBe(true); expect(f.calls()).toHaveLength(66);
    });
    test('a newer canonical revision is preserved and the accepted proposal is not regenerated', async () => {
      const original = publication.withSharedOptimizerPublication;
      const newer = text.replace('Prefer brevity.', 'Preserve this concurrent edit.');
      const fault = spyOn(publication, 'withSharedOptimizerPublication').mockImplementationOnce(async (scope, callback) => {
        await submitSharedSkillMutation(ctx, 'put_skill', { ...opts.sharedSkill!, name: opts.skillName, request_id: randomUUID(), files: [
          { path: 'skills/synthetic-skill/SKILL.md', content: newer, file_class: 'prose', depends_on: ['skills/synthetic-skill/benchmark.jsonl', 'skills/synthetic-skill/reference.md'] },
          { path: 'skills/synthetic-skill/benchmark.jsonl', content: benchmark, file_class: 'reference' },
          { path: 'skills/synthetic-skill/reference.md', content: 'Immutable approved reference.', file_class: 'reference' },
        ] });
        return original(scope, callback);
      });
      try { await expect(run()).rejects.toThrow(); } finally { fault.mockRestore(); }
      expect(skill()).toBe(newer); expect(f.calls()).toHaveLength(66);
      await expect(run()).rejects.toThrow(); expect(skill()).toBe(newer); expect(f.calls()).toHaveLength(66);
    });
    test('failure after file publication reconciles the original bytes and remains an explicit failure', async () => {
      let reached = false;
      installFaultHook((point, detail) => {
        if (point === 'publication:after_publication' && detail.requestId === opts.sharedSkill!.request_id) {
          reached = true; expect(skill()).toContain('Always cite evidence.'); throw new Error('synthetic publication interruption');
        }
      });
      try { await expect(run()).rejects.toThrow(); } finally { installFaultHook(undefined); }
      expect(reached).toBe(true); expect(skill()).toBe(text); expect(f.calls()).toHaveLength(66);
      await expect(run()).rejects.toThrow(); expect(f.calls()).toHaveLength(66);
      const [request] = await f.engine().executeRaw<{ state: string; recovery: unknown }>('SELECT state,recovery FROM persistence_requests WHERE request_id=$1::uuid', [opts.sharedSkill!.request_id]);
      expect(request?.state).toBe('failed'); expect(request?.recovery).toBeNull();
    });
    test('a changed request or staged input is rejected before inference', async () => {
      const original = stages.stageSharedOptimizer, fault = spyOn(stages, 'stageSharedOptimizer').mockImplementationOnce(input => {
        const result = original(input); writeFileSync(join(result.skillsDir, opts.skillName, 'SKILL.md'), 'Unrelated staged edit.');
        throw new Error('synthetic stage interruption');
      });
      try { await expect(run()).rejects.toThrow('synthetic stage interruption'); } finally { fault.mockRestore(); }
      await expect(run({ ...opts, epochs: 2 })).rejects.toThrow();
      await expect(run()).rejects.toThrow(); expect(f.calls()).toHaveLength(0); expect(skill()).toBe(text);
    });
    test('unsafe native evaluation files refuse before creating a plan or making calls', async () => {
      const base = join(root, 'external-benchmark.jsonl'), linked = join(root, 'linked-benchmark.jsonl');
      const symbolic = join(root, 'symbolic-benchmark.jsonl'), huge = join(root, 'oversized-benchmark.jsonl');
      writeFileSync(base, benchmark); linkSync(base, linked); symlinkSync(base, symbolic); writeFileSync(huge, Buffer.alloc(2097153));
      for (const benchmarkPath of [linked, symbolic, huge]) await expect(run({ ...opts, benchmarkPath })).rejects.toThrow();
      expect(await store.readSharedOptimizer(f.engine(), runId)).toBeUndefined(); expect(f.calls()).toHaveLength(0); expect(skill()).toBe(text);
    });
    test('cancellation before admission preserves the accepted result for an authorized retry', async () => {
      const controller = new AbortController(), original = publication.withSharedOptimizerPublication;
      const fault = spyOn(publication, 'withSharedOptimizerPublication').mockImplementationOnce((scope, callback) => {
        controller.abort(new Error('synthetic optimizer cancellation')); return original(scope, callback);
      });
      try { await expect(run(opts, controller.signal)).rejects.toThrow('synthetic optimizer cancellation'); } finally { fault.mockRestore(); }
      expect(skill()).toBe(text); expect(f.calls()).toHaveLength(66);
      expect(await f.engine().executeRaw('SELECT request_id FROM persistence_requests WHERE request_id=$1::uuid', [opts.sharedSkill!.request_id])).toHaveLength(0);
      expect((await run()).mutatedSkillFile).toBe(true); expect(f.calls()).toHaveLength(66);
    });
    test('no-mutate retains an accepted proposal without changing the canonical revision', async () => {
      const result = await run({ ...opts, noMutate: true }); expect(result).toMatchObject({ outcome: 'accepted', mutatedSkillFile: false });
      expect(result.sharedOptimization?.publication).toBeUndefined(); expect(skill()).toBe(text);
      expect(await f.engine().executeRaw('SELECT request_id FROM persistence_requests WHERE request_id=$1::uuid', [opts.sharedSkill!.request_id])).toHaveLength(0);
    });
  });
}
