import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runSkillOptCommand } from '../../src/commands/skillopt.ts';
import { digest } from '../../src/core/persistence/digest.ts';
import { BOOTSTRAP_PENDING_REVIEW } from '../../src/core/skillopt/types.ts';
import * as store from '../../src/core/skillopt/codex-bootstrap-store.ts';
interface Fixture { root: string; engine(): BrainEngine; sourceId: string; reply(value: unknown): void; calls(): any[] }
export function codexBootstrapLocalContract(f: Fixture) {
  describe('native standalone bootstrap admission', () => {
    let dir: string, skill: string, routing: string, output: string, request: string, deadline: string, before: number, sequence = 0;
    const skillName = 'synthetic-skill', text = '---\nname: synthetic-skill\ntools: [search]\n---\n## Method\nUse grounded evidence.\n';
    beforeEach(() => {
      dir = join(f.root, `bootstrap-cli-${sequence++}`); mkdirSync(join(dir, skillName), { recursive: true });
      skill = join(dir, skillName, 'SKILL.md'); routing = join(dir, skillName, 'routing-eval.jsonl'); output = join(dir, skillName, 'skillopt-benchmark.jsonl');
      writeFileSync(skill, text); writeFileSync(routing, ['First grounded task', 'Second grounded task'].map(intent => JSON.stringify({ intent, expected_skill: skillName })).join('\n'));
      request = randomUUID(); deadline = new Date(Date.now() + 3600000).toISOString(); before = f.calls().length; f.reply({ autoBootstrap: true });
    });
    const id = () => `codex-skillopt:${request}`;
    const args = (extra: string[] = []) => [skillName, '--skills-dir', dir, '--bootstrap-from-skill', '--bootstrap-tasks', '2', '--json',
      '--source', f.sourceId, '--read-prefix', 'notes/*', '--codex-request-id', request, '--codex-max-attempts', '3', '--codex-max-turns', '3', '--codex-deadline', deadline, ...extra];
    const cli = async (input = args()) => {
      const exits: number[] = [], output: string[] = [], errors: string[] = [];
      const exit = spyOn(process, 'exit').mockImplementation(code => { exits.push(Number(code)); return undefined as never; });
      const out = spyOn(process.stdout, 'write').mockImplementation(value => { output.push(String(value)); return true; });
      const err = spyOn(process.stderr, 'write').mockImplementation(value => { errors.push(String(value)); return true; });
      try { await runSkillOptCommand(f.engine(), input); } finally { exit.mockRestore(); out.mockRestore(); err.mockRestore(); }
      return { exits, output: output.join(''), errors: errors.join('') };
    };
    const grants = () => f.engine().executeRaw('SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE run_id=$1', [id()]);
    test('actual CLI binds one allowance and replays its reviewed draft without another call', async () => {
      const first = await cli(); expect(first.exits).toEqual([0]); expect(first.output).toContain('"cost_usd":null'); expect(first.output).toContain(request);
      expect(readFileSync(output, 'utf8')).toContain(BOOTSTRAP_PENDING_REVIEW);
      const repeat = await cli(); expect(repeat.exits).toEqual([0]); expect(repeat.output).toContain('"replayed":true');
      expect(f.calls().length - before).toBe(1); expect(await grants()).toEqual([{ attempts: 1, accepted_turns: 1 }]);
      expect((await store.readBootstrapRun(f.engine(), id()))?.completed).toBe(true);
    });
    test('routing bootstrap preserves exact selected intents under one CLI admission', async () => {
      const input = args().filter((v, i, a) => v !== '--bootstrap-tasks' && a[i - 1] !== '--bootstrap-tasks').map(v => v === '--bootstrap-from-skill' ? '--bootstrap-from-routing' : v);
      expect((await cli(input)).exits).toEqual([0]); const content = readFileSync(output, 'utf8');
      expect(content).toContain('First grounded task'); expect(content).toContain('Second grounded task'); expect(f.calls().length - before).toBe(1);
    });
    test('dry-run and invalid input create neither an allowance nor a plan', async () => {
      expect((await cli(args(['--dry-run']))).exits).toEqual([0]);
      writeFileSync(skill, 'x'.repeat(64001)); expect((await cli()).exits).toEqual([2]);
      expect(await grants()).toHaveLength(0); expect(await store.readBootstrapRun(f.engine(), id())).toBeUndefined();
      expect(existsSync(output)).toBe(false); expect(f.calls().length).toBe(before);
    });
    test('changed CLI limits and task counts cannot reuse a request', async () => {
      await cli(); const accepted = readFileSync(output, 'utf8');
      const changed = args(); changed[changed.indexOf('--codex-max-attempts') + 1] = '4'; expect((await cli(changed)).exits).toEqual([2]);
      const count = args(); count[count.indexOf('--bootstrap-tasks') + 1] = '3'; expect((await cli(count)).exits).toEqual([2]);
      expect(readFileSync(output, 'utf8')).toBe(accepted); expect(f.calls().length - before).toBe(1);
    });
    test('source or draft edits are preserved on replay', async () => {
      await cli(); writeFileSync(output, 'Concurrent draft edit.'); expect((await cli()).exits).toEqual([2]);
      expect(readFileSync(output, 'utf8')).toBe('Concurrent draft edit.'); expect(f.calls().length - before).toBe(1);
    });
    test('accepted-result loss reuses the cached proposal before writing', async () => {
      const original = store.saveBootstrapAccepted, fault = spyOn(store, 'saveBootstrapAccepted').mockImplementationOnce(async (...args) => {
        await original(...args); throw new Error('synthetic bootstrap result acknowledgement loss');
      });
      try { expect((await cli()).exits).toEqual([2]); } finally { fault.mockRestore(); }
      expect(existsSync(output)).toBe(false); expect((await cli()).exits).toEqual([0]); expect(f.calls().length - before).toBe(1);
    });
    test('a written draft survives rollback of terminal SQL without force or regeneration', async () => {
      const original = store.completeBootstrapRun, fault = spyOn(store, 'completeBootstrapRun').mockImplementationOnce(async (...args) => {
        await original(...args); throw new Error('synthetic bootstrap completion loss');
      });
      try { expect((await cli()).exits).toEqual([2]); } finally { fault.mockRestore(); }
      expect(existsSync(output)).toBe(true); expect((await store.readBootstrapRun(f.engine(), id()))?.completed).toBe(false);
      expect((await cli()).exits).toEqual([0]); expect((await store.readBootstrapRun(f.engine(), id()))?.completed).toBe(true); expect(f.calls().length - before).toBe(1);
    });
    const expireRetainedFixture = async () => {
      // Seed the state of an unchanged request whose deadline has now passed.
      // Both durable records and CLI retain the same historical deadline.
      deadline = new Date(Date.now() - 60000).toISOString();
      const row = (await store.readBootstrapRun(f.engine(), id()))!;
      (row.input.controls.allowance as { deadline: string }).deadline = deadline;
      await f.engine().executeRaw('UPDATE codex_subscription_runs SET deadline=$2::timestamptz WHERE run_id=$1', [id(), deadline]);
      await f.engine().executeRaw('UPDATE codex_skillopt_bootstraps SET input=$2::text::jsonb,input_hash=$3 WHERE run_id=$1', [id(), JSON.stringify(row.input), digest(row.input)]);
    };
    test('an expired allowance reconciles the exact already-written draft', async () => {
      const original = store.completeBootstrapRun, fault = spyOn(store, 'completeBootstrapRun').mockImplementationOnce(async (...args) => {
        await original(...args); throw new Error('synthetic terminal loss');
      });
      try { expect((await cli()).exits).toEqual([2]); } finally { fault.mockRestore(); }
      const accepted = readFileSync(output, 'utf8'); await expireRetainedFixture();
      expect((await cli()).exits).toEqual([0]); expect(readFileSync(output, 'utf8')).toBe(accepted);
      expect((await store.readBootstrapRun(f.engine(), id()))?.completed).toBe(true); expect(f.calls().length - before).toBe(1);
    });
    test('an expired allowance cannot publish an accepted but unwritten draft', async () => {
      const original = store.saveBootstrapAccepted, fault = spyOn(store, 'saveBootstrapAccepted').mockImplementationOnce(async (...args) => {
        await original(...args); process.emit('SIGINT');
      });
      try { expect((await cli()).exits).toEqual([2]); } finally { fault.mockRestore(); }
      await expireRetainedFixture(); expect((await cli()).exits).toEqual([2]);
      expect(existsSync(output)).toBe(false); expect(f.calls().length - before).toBe(1);
    });
    test('changed source incarnation prevents accepted draft publication', async () => {
      const original = store.saveBootstrapAccepted, sourceId = `bootstrap-${randomUUID().slice(0, 8)}`;
      await f.engine().executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      const input = args(); input[input.indexOf('--source') + 1] = sourceId;
      const fault = spyOn(store, 'saveBootstrapAccepted').mockImplementationOnce(async (...args) => {
        await original(...args); await args[0].executeRaw('UPDATE sources SET incarnation=$2::uuid WHERE id=$1', [sourceId, randomUUID()]);
      });
      try {
        expect((await cli(input)).exits).toEqual([2]); expect(existsSync(output)).toBe(false);
        expect((await cli(input)).exits).toEqual([2]); expect(f.calls().length - before).toBe(1);
      } finally { fault.mockRestore(); }
    });
    test('a stale owner cannot publish or clear its replacement lease', async () => {
      const replacement = randomUUID(), original = store.saveBootstrapAccepted;
      const fault = spyOn(store, 'saveBootstrapAccepted').mockImplementationOnce(async (...args) => {
        await original(...args); await args[0].executeRaw('UPDATE codex_skillopt_bootstraps SET owner_token=$2::uuid WHERE run_id=$1', [id(), replacement]);
      });
      try { expect((await cli()).exits).toEqual([2]); } finally { fault.mockRestore(); }
      expect(existsSync(output)).toBe(false); expect((await store.readBootstrapRun(f.engine(), id()))?.owner_token).toBe(replacement);
      expect((await cli()).exits).toEqual([2]);
      await f.engine().executeRaw("UPDATE codex_skillopt_bootstraps SET lease_until=now()-interval '1 second' WHERE run_id=$1", [id()]);
      expect((await cli()).exits).toEqual([0]); expect(f.calls().length - before).toBe(1);
    });
    test('cancellation after acceptance leaves a recoverable result and no draft', async () => {
      const original = store.saveBootstrapAccepted, fault = spyOn(store, 'saveBootstrapAccepted').mockImplementationOnce(async (...args) => {
        await original(...args); process.emit('SIGINT');
      });
      try { expect((await cli()).exits).toEqual([2]); } finally { fault.mockRestore(); }
      expect(existsSync(output)).toBe(false); expect((await cli()).exits).toEqual([0]); expect(f.calls().length - before).toBe(1);
    });
    test('bootstrap identity cannot switch to foreground or background optimization', async () => {
      const initial = args(); initial[initial.indexOf('--bootstrap-tasks') + 1] = '15';
      expect((await cli(initial)).exits).toEqual([0]);
      const optimizer = initial.filter((v, i, a) => v !== '--bootstrap-from-skill' && v !== '--bootstrap-tasks' && a[i - 1] !== '--bootstrap-tasks');
      optimizer.push('--benchmark', output, '--bootstrap-reviewed', '--epochs', '1', '--batch-size', '5', '--lr', '1', '--lr-schedule', 'constant',
        '--split', '1:1:1', '--reflect-max-tokens', '2048', '--no-mutate');
      expect((await cli(optimizer)).exits).toEqual([2]); expect((await cli([...optimizer, '--background'])).exits).toEqual([2]);
      expect(f.calls().length - before).toBe(1);
      expect(await f.engine().executeRaw('SELECT run_id FROM codex_skillopt_runs WHERE run_id=$1', [id()])).toHaveLength(0);
      expect(await f.engine().executeRaw('SELECT job_id FROM codex_skillopt_submissions WHERE request_id=$1::uuid', [request])).toHaveLength(0);
    });
    test('a skill edit after acceptance blocks draft publication and remains preserved', async () => {
      const original = store.saveBootstrapAccepted, fault = spyOn(store, 'saveBootstrapAccepted').mockImplementationOnce(async (...args) => {
        await original(...args); writeFileSync(skill, 'Concurrent skill edit.');
      });
      try { expect((await cli()).exits).toEqual([2]); } finally { fault.mockRestore(); }
      expect(existsSync(output)).toBe(false); expect(readFileSync(skill, 'utf8')).toBe('Concurrent skill edit.');
      expect((await cli()).exits).toEqual([2]); expect(f.calls().length - before).toBe(1);
    });
    test('unconfirmed inference stays unresolved and blocks another call', async () => {
      f.reply({ missingCompletion: true }); const first = await cli(); expect(first.exits).toEqual([2]); expect(first.errors).toContain('codex_missing_completion');
      expect((await cli()).exits).toEqual([2]); expect(f.calls().length - before).toBe(1); expect(existsSync(output)).toBe(false);
      expect(await f.engine().executeRaw('SELECT state FROM codex_subscription_attempts WHERE run_id=$1', [id()])).toEqual([{ state: 'unresolved' }]);
      // This synthetic fixture is now settled by the test harness so independent cases can use its account lane.
      await f.engine().executeRaw("UPDATE codex_subscription_attempts SET state='failed',settled_at=now() WHERE run_id=$1", [id()]);
    });
    test('an exhausted request cannot turn a malformed proposal into a successful empty draft', async () => {
      f.reply({ raw: 'invalid' }); const input = args(); input[input.indexOf('--codex-max-attempts') + 1] = '1'; input[input.indexOf('--codex-max-turns') + 1] = '1';
      expect((await cli(input)).exits).toEqual([2]); const exhausted = await cli(input); expect(exhausted.exits).toEqual([2]); expect(exhausted.errors).toContain('subscription_exhausted');
      expect(existsSync(output)).toBe(false); expect(f.calls().length - before).toBe(1); expect(await grants()).toEqual([{ attempts: 1, accepted_turns: 0 }]);
    });
  });
}
