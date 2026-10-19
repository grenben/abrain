import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { runWithJobSpend } from '../../src/core/minions/spend-authorization.ts';
import { buildJobContext } from '../../src/core/minions/job-context.ts';
import { makeSubagentHandler } from '../../src/core/minions/handlers/subagent.ts';
import { __registerCodexFixtureForTests } from '../../src/core/ai/providers/codex-qualification.ts';
import { CODEX_READ_PROTOCOL } from '../../src/core/minions/codex-action-contract.ts';
import * as store from '../../src/core/minions/codex-action-store.ts';
import { spyOn } from 'bun:test';

const [mode, root, digest] = process.argv.slice(2);
const home = join(root, 'home');
const config = JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8'));
const unregister = __registerCodexFixtureForTests(config.private_codex.bin, digest);
const engine = new PGLiteEngine();
await engine.connect({ database_path: join(root, 'database') });
const queue = new MinionQueue(engine);
const handler = makeSubagentHandler({ engine, makeAnthropic: () => { throw new Error('forbidden Anthropic construction'); } });
try {
  if (mode === 'seed') {
    await engine.initSchema();
    await engine.setConfig('recall.track_retrieval', 'false');
    await engine.putPage('notes/one', { title: 'Evidence', type: 'note', compiled_truth: 'Check the evidence before drawing a conclusion.', frontmatter: { visibility: 'world' } });
    await queue.add('subagent', { action_protocol: CODEX_READ_PROTOCOL, prompt: 'Read notes/one and summarize.',
      source_id: 'default', allowed_tools: ['get_page'], allowed_slug_prefixes: ['notes/*'], max_turns: 4, no_self_fix: true },
    { max_attempts: 1, max_stalled: 3, lock_duration_ms: 5000 },
    { allowProtectedSubmit: true, codexSubscription: { maxAttempts: 8, maxTurns: 8, deadline: new Date(Date.now() + 600000) } });
  } else if (mode === 'crash' || mode === 'recover') {
    let retainedId: string | undefined;
    if (mode === 'recover') {
      const [active] = await engine.executeRaw<{ status: string; lock_token: string }>('SELECT status,lock_token FROM minion_jobs');
      if (active?.status !== 'active' || active.lock_token !== 'killed-worker') throw new Error('Expected killed worker to own active job');
      const [before] = await engine.executeRaw<{ gbrain_tool_use_id: string; status: string }>('SELECT gbrain_tool_use_id::text,status FROM subagent_tool_executions');
      if (!before || before.status !== 'pending') throw new Error('Expected durable pending action');
      retainedId = before.gbrain_tool_use_id;
      // Advance only the expired lease after the OS kill; do not alter the action ledger.
      await engine.executeRaw("UPDATE minion_jobs SET lock_until=now()-interval '1 second' WHERE lock_token='killed-worker'");
      const stalled = await queue.handleStalled(0);
      if (stalled.requeued.length !== 1 || stalled.dead.length) throw new Error('Killed job was not requeued');
    }
    const job = await queue.claim(mode === 'crash' ? 'killed-worker' : 'recovery-worker', 5000, 'default', ['subagent']);
    if (!job) throw new Error('Private action job was not claimed');
    const ctx = buildJobContext(engine, queue, job, job.lock_token!, new AbortController().signal, new AbortController().signal);
    if (mode === 'crash') {
      const original = store.retainCodexAction;
      spyOn(store, 'retainCodexAction').mockImplementation(async (...args) => {
        await original(...args);
        console.log('ACTION_RETAINED');
        await new Promise<void>(() => { setInterval(() => {}, 1000); });
        throw new Error('unreachable');
      });
    }
    const result = await runWithJobSpend(engine, job, ctx, () => handler(ctx));
    if (mode === 'recover') {
      const completed = await queue.completeJob(job.id, job.lock_token!, { ...result });
      const [after] = await engine.executeRaw<{ gbrain_tool_use_id: string; status: string }>('SELECT gbrain_tool_use_id::text,status FROM subagent_tool_executions');
      if (!completed || completed.status !== 'completed' || after?.status !== 'complete' || after.gbrain_tool_use_id !== retainedId ||
          result.result !== 'The synthetic note says to check evidence.' ||
          (await engine.executeRaw('SELECT id FROM subagent_tool_executions')).length !== 1) {
        throw new Error('Recovered action did not complete exactly once');
      }
      console.log('ACTION_RECOVERED');
    }
  } else throw new Error(`Unknown mode: ${mode}`);
} finally { unregister(); await engine.disconnect(); }
