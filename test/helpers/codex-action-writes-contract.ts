/** Protect observable replay-safe writes through the actual handler, ledger and canonical
 * persistence owner. The former read suite never executed writes; removing the binding,
 * receipt or revision fences makes these cases fail. Spies target production boundaries. */
import { test, expect, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { MinionJob, SubagentResult } from '../../src/core/minions/types.ts';
import { CODEX_WRITE_PROTOCOL } from '../../src/core/minions/codex-action-contract.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import * as writes from '../../src/core/minions/codex-action-writes.ts';
import * as store from '../../src/core/minions/codex-action-store.ts';
import * as journal from '../../src/core/persistence/journal.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import * as service from '../../src/core/persistence/service.ts';

interface Fixture {
  engine(): BrainEngine; root: string;
  claim(extra?: Record<string, unknown>): Promise<MinionJob>;
  run(job: MinionJob): Promise<SubagentResult>;
  replies(...values: unknown[]): void; calls(): Array<{ schema: any; prompt: string }>;
  get(slug?: string): unknown; final: unknown;
}
export function codexActionWritesContract(f: Fixture) {
  const content = '---\ntitle: Reviewed evidence\ntype: note\n---\n\n## Summary\n\nThe synthetic evidence supports careful review.\n';
  const put = (slug = 'notes/new', body = content) => ({ response: { kind: 'tool', name: 'brain_put_page', arguments: { slug, content: body } } });
  async function fixture() {
    const engine = f.engine(), sourceId = `action-${randomUUID().slice(0, 8)}`, dir = join(f.root, sourceId); mkdirSync(dir);
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, dir]);
    await engine.putPage('notes/one', { title: 'Evidence', type: 'note', compiled_truth: 'Review the synthetic evidence.', frontmatter: { visibility: 'world' } }, { sourceId });
    mkdirSync(join(dir, 'notes'));
    writeFileSync(join(dir, 'notes/one.md'), serializePageToMarkdown((await engine.getPage('notes/one', { sourceId }))!, []));
    await claimWorktree(engine, sourceId, dir);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const job = await f.claim({ source_id: sourceId, action_protocol: CODEX_WRITE_PROTOCOL, allowed_tools: ['get_page', 'put_page'], require_writes: true });
    f.replies(f.get(), put(), f.final);
    return { engine, job, dir, sourceId };
  }
  test('host write creates a canonical file, records its receipt and completes from actual receipts', async () => {
    const { engine, job, dir, sourceId } = await fixture();
    expect(await f.run(job)).toMatchObject({ pages_attempted: 1, pages_written: 1, pages_failed: 0, cost_usd: null, action_protocol: CODEX_WRITE_PROTOCOL });
    expect(readFileSync(join(dir, 'notes/new.md'), 'utf8')).toContain('careful review');
    expect((await engine.getPage('notes/new', { sourceId }))?.compiled_truth).toContain('careful review');
    const [row] = await engine.executeRaw<any>("SELECT * FROM subagent_tool_executions WHERE job_id=$1 AND tool_name='brain_put_page'", [job.id]);
    expect(row).toMatchObject({ status: 'complete', schema_version: 4, output: { state: 'committed' } });
    expect(row.host_binding.binding.canonicalId).toBe(row.gbrain_tool_use_id);
    expect(row.host_binding.admission.authority).toMatchObject({ remote: true, restrictedNamespace: true, sourceId });
    const [receipt] = await engine.executeRaw('SELECT state,protocol_version FROM persistence_requests WHERE request_id=$1::uuid', [row.output.request_id]);
    expect(receipt).toEqual({ state: 'committed', protocol_version: 3 });
    expect(f.calls()[1]!.schema.properties.response.anyOf.find((v: any) => v.properties.name?.const === 'brain_put_page').properties.arguments.required).toEqual(['slug', 'content']);
    expect((await f.run(job)).pages_written).toBe(1); expect(f.calls()).toHaveLength(3);
  });
  test('crash after retained write authority resumes the same stable request', async () => {
    const { job, engine } = await fixture(), original = writes.retainCodexWrite;
    const fault = spyOn(writes, 'retainCodexWrite').mockImplementation(async (...args) => { await original(...args); throw new Error('synthetic before admission'); });
    try { await expect(f.run(job)).rejects.toThrow('synthetic before admission'); } finally { fault.mockRestore(); }
    const [before] = await engine.executeRaw<any>("SELECT host_binding FROM subagent_tool_executions WHERE job_id=$1 AND tool_name='brain_put_page'", [job.id]);
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE request_id=$1::uuid', [before.host_binding.admission.requestId])).toHaveLength(0);
    expect((await f.run(job)).pages_written).toBe(1); expect(f.calls()).toHaveLength(3);
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE request_id=$1::uuid', [before.host_binding.admission.requestId])).toHaveLength(1);
  });
  test('crash after committed effect reconciles the receipt without republishing', async () => {
    const { job, engine } = await fixture(), original = store.settleCodexAction;
    const fault = spyOn(store, 'settleCodexAction').mockImplementation(async (...args) => {
      if (args[2].tool_name === 'brain_put_page') throw new Error('synthetic after effect'); return original(...args);
    });
    try { await expect(f.run(job)).rejects.toThrow('synthetic after effect'); } finally { fault.mockRestore(); }
    const admit = spyOn(journal, 'admitWrite');
    try { expect((await f.run(job)).pages_written).toBe(1); expect(admit).not.toHaveBeenCalled(); } finally { admit.mockRestore(); }
    expect(f.calls()).toHaveLength(3);
    expect((await engine.executeRaw<any>("SELECT output FROM subagent_tool_executions WHERE job_id=$1 AND tool_name='brain_put_page'", [job.id]))[0].output.state).toBe('committed');
  });
  test('required-write jobs reject an unsupported final success claim', async () => {
    const { job } = await fixture(); f.replies(f.final);
    await expect(f.run(job)).rejects.toThrow('required_write_missing'); expect(f.calls()).toHaveLength(1);
    await expect(f.run(job)).rejects.toThrow('required_write_missing'); expect(f.calls()).toHaveLength(1);
  });
  test('unread existing pages cannot be replaced', async () => {
    const { job, engine, sourceId } = await fixture(); f.replies(put('notes/one'), f.final);
    await expect(f.run(job)).rejects.toThrow('read_revision_required');
    expect((await engine.getPage('notes/one', { sourceId }))?.compiled_truth).toBe('Review the synthetic evidence.'); expect(f.calls()).toHaveLength(1);
  });
  test('lost worker claim after binding prevents write admission', async () => {
    const { job, engine, sourceId } = await fixture(), original = writes.retainCodexWrite;
    const fault = spyOn(writes, 'retainCodexWrite').mockImplementation(async (...args) => {
      const retained = await original(...args);
      await engine.executeRaw("UPDATE minion_jobs SET lock_token='other-worker' WHERE id=$1", [job.id]); return retained;
    });
    try { await expect(f.run(job)).rejects.toThrow(); } finally { fault.mockRestore(); }
    expect(await engine.getPage('notes/new', { sourceId })).toBeNull(); expect(f.calls()).toHaveLength(2);
  });
  test('crash after admission recovers the queued request without issuing another proposal', async () => {
    const { job } = await fixture(), original = journal.admitWrite;
    const fault = spyOn(journal, 'admitWrite').mockImplementation(async (...args) => { await original(...args); throw new Error('synthetic after admission'); });
    try { await expect(f.run(job)).rejects.toThrow('synthetic after admission'); } finally { fault.mockRestore(); }
    expect(f.calls()).toHaveLength(2); expect((await f.run(job)).pages_written).toBe(1); expect(f.calls()).toHaveLength(3);
  });
  test('a new worker reconciles a committed write left pending by the old worker', async () => {
    const { job, engine } = await fixture(), original = store.settleCodexAction;
    const fault = spyOn(store, 'settleCodexAction').mockImplementation(async (...args) => {
      if (args[2].tool_name === 'brain_put_page') {
        await engine.executeRaw("UPDATE minion_jobs SET lock_token='next-worker',codex_claim_token=claim_generation+1,claim_generation=claim_generation+1 WHERE id=$1", [job.id]);
      }
      return original(...args);
    });
    try { await expect(f.run(job)).rejects.toThrow('subscription_owner_lost'); } finally { fault.mockRestore(); }
    const current = (await new MinionQueue(engine).getJob(job.id))!;
    expect((await f.run(current)).pages_written).toBe(1); expect(f.calls()).toHaveLength(3);
  });
  test('lease theft after preparation prevents stale publication at the commit fence', async () => {
    const { job, engine, sourceId } = await fixture();
    installFaultHook(async point => { if (point === 'consumer:prepared') await engine.transaction(async tx => {
      await tx.executeRaw("UPDATE minion_jobs SET lock_token='next-worker',codex_claim_token=claim_generation+1,claim_generation=claim_generation+1 WHERE id=$1", [job.id]);
    }); });
    try { await expect(f.run(job)).rejects.toThrow(); } finally { installFaultHook(undefined); }
    expect(await engine.getPage('notes/new', { sourceId })).toBeNull(); expect(f.calls()).toHaveLength(2);
  });
  test('a revision changed after proposal retention is not overwritten', async () => {
    const { job, engine, sourceId } = await fixture(), original = writes.retainCodexWrite;
    f.replies(f.get(), put('notes/one'), f.final);
    const fault = spyOn(writes, 'retainCodexWrite').mockImplementation(async (...args) => {
      const retained = await original(...args);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      try { await engine.putPage('notes/one', { title: 'Concurrent author', type: 'note', compiled_truth: 'A newer synthetic revision.' }, { sourceId }); }
      finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
      return retained;
    });
    try { await expect(f.run(job)).rejects.toThrow('required_write_missing'); } finally { fault.mockRestore(); }
    expect((await engine.getPage('notes/one', { sourceId }))?.compiled_truth).toBe('A newer synthetic revision.');
    const [row] = await engine.executeRaw<any>("SELECT status,output FROM subagent_tool_executions WHERE job_id=$1 AND tool_name='brain_put_page'", [job.id]);
    expect(row.status).toBe('failed'); expect(row.output.error).toBe('codex_action_write_failed');
  });
  test('an existing page can be replaced only with its retained read revision', async () => {
    const { job, engine, sourceId } = await fixture(); f.replies(f.get(), put('notes/one'), f.final);
    expect((await f.run(job)).pages_written).toBe(1);
    expect((await engine.getPage('notes/one', { sourceId }))?.compiled_truth).toContain('careful review');
  });
  test('source incarnation changes are refused even when the creation timestamp is unchanged', async () => {
    const engine = f.engine(), sourceId = `empty-${randomUUID().slice(0, 8)}`;
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    const job = await f.claim({ source_id: sourceId });
    await engine.executeRaw('UPDATE sources SET incarnation=$2::uuid WHERE id=$1', [sourceId, randomUUID()]);
    await expect(f.run(job)).rejects.toThrow('subscription_identity_conflict'); expect(f.calls()).toHaveLength(0);
  });
  test('unsettled receipt blocks further inference and later resumes the same request', async () => {
    const { job } = await fixture();
    const fault = spyOn(service, 'waitForWrite').mockImplementation(async (_engine, row) => row);
    try { await expect(f.run(job)).rejects.toThrow('needs_reconciliation'); } finally { fault.mockRestore(); }
    expect(f.calls()).toHaveLength(2);
    const admission = spyOn(journal, 'admitWrite');
    try { expect((await f.run(job)).pages_written).toBe(1); expect(admission).not.toHaveBeenCalled(); } finally { admission.mockRestore(); }
    expect(f.calls()).toHaveLength(3);
  });
  test('changed retained inputs cannot reuse an accepted canonical write identity', async () => {
    const { job, engine, sourceId } = await fixture(), original = writes.retainCodexWrite;
    const fault = spyOn(writes, 'retainCodexWrite').mockImplementation(async (...args) => {
      const retained = await original(...args);
      await engine.executeRaw("UPDATE subagent_tool_executions SET input=jsonb_set(input,'{content}','\"Changed synthetic content\"'::jsonb) WHERE job_id=$1 AND tool_name='brain_put_page'", [job.id]);
      return retained;
    });
    try { await expect(f.run(job)).rejects.toThrow(); } finally { fault.mockRestore(); }
    expect(await engine.getPage('notes/new', { sourceId })).toBeNull(); expect(f.calls()).toHaveLength(2);
    await expect(f.run(job)).rejects.toThrow('identity_conflict'); expect(f.calls()).toHaveLength(2);
  });
  test('a canonical no-op receipt cannot satisfy a required content write', async () => {
    const { job, engine, sourceId } = await fixture();
    const page = (await engine.getPage('notes/one', { sourceId }))!;
    f.replies(f.get(), put('notes/one', serializePageToMarkdown(page, [])), f.final);
    await expect(f.run(job)).rejects.toThrow('required_write_missing');
    const [row] = await engine.executeRaw<any>("SELECT output FROM subagent_tool_executions WHERE job_id=$1 AND tool_name='brain_put_page'", [job.id]);
    expect(row.output).toMatchObject({ state: 'committed', changed: false });
    expect((await engine.getPage('notes/one', { sourceId }))!.knowledge_revision).toBe(page.knowledge_revision);
  });
  test('normal untrusted put_page protection rejects an empty replacement', async () => {
    const { job, engine, sourceId } = await fixture(); f.replies(f.get(), put('notes/one', '---\ntitle: Empty\ntype: note\n---\n'), f.final);
    await expect(f.run(job)).rejects.toThrow('required_write_missing');
    expect((await engine.getPage('notes/one', { sourceId }))!.compiled_truth).toBe('Review the synthetic evidence.');
    expect(f.calls()[2]!.prompt).toContain('codex_action_write_failed');
  });
  test('confirmed publication rollback is a failed write, never a successful completion', async () => {
    const { job, engine, sourceId, dir } = await fixture();
    installFaultHook(point => { if (point === 'publication:after_publication') throw new Error('synthetic publication interruption'); });
    try { await expect(f.run(job)).rejects.toThrow('required_write_missing'); } finally { installFaultHook(undefined); }
    expect(f.calls()).toHaveLength(3);
    const [row] = await engine.executeRaw<any>("SELECT status,host_binding FROM subagent_tool_executions WHERE job_id=$1 AND tool_name='brain_put_page'", [job.id]);
    expect(row.status).toBe('failed'); expect(row.host_binding.admission.requestId).toBeTruthy();
    expect(await engine.getPage('notes/new', { sourceId })).toBeNull();
    expect(existsSync(join(dir, 'notes/new.md'))).toBe(false);
  });
}
