import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { runWithJobSpend } from '../../src/core/minions/spend-authorization.ts';
import { buildJobContext } from '../../src/core/minions/job-context.ts';
import { makeSubagentHandler } from '../../src/core/minions/handlers/subagent.ts';
import { __registerCodexFixtureForTests } from '../../src/core/ai/providers/codex-qualification.ts';
import { CODEX_READ_PROTOCOL, CODEX_WRITE_PROTOCOL } from '../../src/core/minions/codex-action-contract.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import * as store from '../../src/core/minions/codex-action-store.ts';
import * as writes from '../../src/core/minions/codex-action-writes.ts';
import { spyOn } from 'bun:test';

const [mode, root, digest] = process.argv.slice(2);
const phase = mode.split('-')[0];
const writeMode = mode.includes('-write');
const beforeCommit = mode.endsWith('-before');
const home = join(root, 'home');
const config = JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8'));
const unregister = __registerCodexFixtureForTests(config.private_codex.bin, digest);
const databaseUrl = process.env.CODEX_ACTION_CRASH_DATABASE_URL;
const engine = databaseUrl ? new PostgresEngine() : new PGLiteEngine();
if (databaseUrl) {
  await (engine as PostgresEngine).connect({ database_url: databaseUrl, poolSize: 2 });
} else {
  await (engine as PGLiteEngine).connect({ database_path: join(root, 'database') });
}
const queue = new MinionQueue(engine);
const handler = makeSubagentHandler({ engine, makeAnthropic: () => { throw new Error('forbidden Anthropic construction'); } });
try {
  if (phase === 'seed') {
    await engine.initSchema();
    await engine.setConfig('recall.track_retrieval', 'false');
    const sourceId = writeMode ? 'action-kill' : 'default';
    if (writeMode) {
      const dir = join(root, 'source');
      mkdirSync(join(dir, 'notes'), { recursive: true });
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, dir]);
    }
    await engine.putPage('notes/one', { title: 'Evidence', type: 'note', compiled_truth: 'Check the evidence before drawing a conclusion.', frontmatter: { visibility: 'world' } }, { sourceId });
    if (writeMode) {
      const dir = join(root, 'source');
      writeFileSync(join(dir, 'notes/one.md'), serializePageToMarkdown((await engine.getPage('notes/one', { sourceId }))!, []));
      await claimWorktree(engine, sourceId, dir);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    }
    await queue.add('subagent', { action_protocol: writeMode ? CODEX_WRITE_PROTOCOL : CODEX_READ_PROTOCOL,
      prompt: writeMode ? 'Read notes/one and write notes/new.' : 'Read notes/one and summarize.',
      source_id: sourceId, allowed_tools: writeMode ? ['get_page', 'put_page'] : ['get_page'],
      allowed_slug_prefixes: ['notes/*'], max_turns: 4, no_self_fix: true, ...(writeMode ? { require_writes: true } : {}) },
    { max_attempts: 1, max_stalled: 3, lock_duration_ms: 5000 },
    { allowProtectedSubmit: true, codexSubscription: { maxAttempts: 8, maxTurns: 8, deadline: new Date(Date.now() + 600000) } });
  } else if (phase === 'crash' || phase === 'recover') {
    let retainedId: string | undefined;
    if (phase === 'recover') {
      const [active] = await engine.executeRaw<{ status: string; lock_token: string }>('SELECT status,lock_token FROM minion_jobs');
      if (active?.status !== 'active' || active.lock_token !== 'killed-worker') throw new Error('Expected killed worker to own active job');
      const [before] = await engine.executeRaw<{ gbrain_tool_use_id: string; status: string }>(
        'SELECT gbrain_tool_use_id::text,status FROM subagent_tool_executions WHERE tool_name=$1', [writeMode ? 'brain_put_page' : 'brain_get_page']);
      if (!before || before.status !== 'pending') throw new Error('Expected durable pending action');
      retainedId = before.gbrain_tool_use_id;
      if (writeMode) {
        const requests = await engine.executeRaw('SELECT id FROM persistence_requests');
        if (beforeCommit && (requests.length !== 0 || await engine.getPage('notes/new', { sourceId: 'action-kill' }))) {
          throw new Error('Pre-commit kill already wrote a page');
        }
        if (!beforeCommit && requests.length !== 1) throw new Error('Post-commit kill lost its write receipt');
      }
      // Advance only the expired lease after the OS kill; do not alter the action ledger.
      await engine.executeRaw("UPDATE minion_jobs SET lock_until=now()-interval '1 second' WHERE lock_token='killed-worker'");
      const stalled = await queue.handleStalled(0);
      if (stalled.requeued.length !== 1 || stalled.dead.length) throw new Error('Killed job was not requeued');
    }
    const job = await queue.claim(phase === 'crash' ? 'killed-worker' : 'recovery-worker', 5000, 'default', ['subagent']);
    if (!job) throw new Error('Private action job was not claimed');
    const ctx = buildJobContext(engine, queue, job, job.lock_token!, new AbortController().signal, new AbortController().signal);
    if (phase === 'crash' && !writeMode) {
      const original = store.retainCodexAction;
      spyOn(store, 'retainCodexAction').mockImplementation(async (...args) => {
        await original(...args);
        console.log('ACTION_RETAINED');
        await new Promise<void>(() => { setInterval(() => {}, 1000); });
        throw new Error('unreachable');
      });
    } else if (phase === 'crash' && beforeCommit) {
      const original = writes.retainCodexWrite;
      spyOn(writes, 'retainCodexWrite').mockImplementation(async (...args) => {
        await original(...args);
        console.log('ACTION_RETAINED');
        await new Promise<void>(() => { setInterval(() => {}, 1000); });
        throw new Error('unreachable');
      });
    } else if (phase === 'crash' && writeMode) {
      const original = store.settleCodexAction;
      spyOn(store, 'settleCodexAction').mockImplementation(async (...args) => {
        if (args[2].tool_name === 'brain_put_page') {
          console.log('ACTION_RETAINED');
          await new Promise<void>(() => { setInterval(() => {}, 1000); });
          throw new Error('unreachable');
        }
        return original(...args);
      });
    }
    const result = await runWithJobSpend(engine, job, ctx, () => handler(ctx));
    if (phase === 'recover') {
      const completed = await queue.completeJob(job.id, job.lock_token!, { ...result });
      const [after] = await engine.executeRaw<{ gbrain_tool_use_id: string; status: string }>(
        'SELECT gbrain_tool_use_id::text,status FROM subagent_tool_executions WHERE tool_name=$1', [writeMode ? 'brain_put_page' : 'brain_get_page']);
      if (!completed || completed.status !== 'completed' || after?.status !== 'complete' || after.gbrain_tool_use_id !== retainedId ||
          result.result !== 'The synthetic note says to check evidence.' ||
          (await engine.executeRaw('SELECT id FROM subagent_tool_executions')).length !== (writeMode ? 2 : 1)) {
        throw new Error('Recovered action did not complete exactly once');
      }
      if (writeMode) {
        const [receipt] = await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests');
        const page = await engine.getPage('notes/new', { sourceId: 'action-kill' });
        if (receipt?.state !== 'committed' || (await engine.executeRaw('SELECT id FROM persistence_requests')).length !== 1 ||
            result.pages_written !== 1 || !page?.compiled_truth.includes('careful review') ||
            !readFileSync(join(root, 'source', 'notes/new.md'), 'utf8').includes('careful review')) {
          throw new Error('Recovered write did not retain one committed canonical effect');
        }
      }
      console.log('ACTION_RECOVERED');
    }
  } else throw new Error(`Unknown mode: ${mode}`);
} finally { unregister(); await engine.disconnect(); }
