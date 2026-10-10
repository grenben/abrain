import { describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { MinionJob, MinionJobContext } from '../../src/core/minions/types.ts';
import { CODEX_DISCOVERY_REGISTRY } from '../../src/core/minions/codex-action-contract.ts';
import * as store from '../../src/core/minions/codex-action-store.ts';
import { runJobInChild } from '../../src/core/minions/child-job-runner.ts';
import { noteChildSubscriptionEnforcement } from '../../src/core/minions/subscription-child.ts';
import { buildBrainTools } from '../../src/core/minions/tools/brain-allowlist.ts';

interface Fixture { engine(): BrainEngine; claim(extra?: Record<string, unknown>): Promise<MinionJob>; run(job: MinionJob, ctx?: MinionJobContext): Promise<unknown>;
  replies(...values: unknown[]): void; calls(): any[]; final: unknown }
export function codexDiscoveryContract(f: Fixture) {
  describe('native scoped discovery', () => {
    const tool = (name: string, args: Record<string, unknown>) => ({ response: { kind: 'tool', name: `brain_${name}`, arguments: args } });
    const output = async (job: MinionJob) => (await f.engine().executeRaw<{ output: any }>('SELECT output FROM subagent_tool_executions WHERE job_id=$1 ORDER BY message_idx', [job.id])).map(r => r.output);
    async function fixture() {
      const source = `discover-${randomUUID().slice(0, 8)}`, engine = f.engine();
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [source]);
      for (const [slug, visibility, extra] of [
        ['notes/a', 'world', {}], ['notes/b', 'world', {}], ['notes/c', 'world', {}],
        ['notes/aaa-private', 'private', {}], ['notes/aaa-finance', 'finance', {}],
        ['notes/aaa-quarantined', 'world', { quarantine: { reason: 'synthetic' } }],
        ['outside/hidden', 'world', {}], ['notes', 'world', {}],
      ] as const) {
        const body = `Evidence discovery for ${slug}.`;
        await engine.putPage(slug, { title: slug, type: 'note', compiled_truth: body, frontmatter: { visibility, ...extra } }, { sourceId: source });
        const snapshot = (await engine.readPageSnapshot(slug, { sourceId: source }))!;
        await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' }],
          { sourceId: source, expectedRevision: snapshot.revision, sealChunkerVersion: 4 });
        await engine.executeRaw('UPDATE pages SET text_projection_revision=knowledge_revision WHERE source_id=$1 AND slug=$2', [source, slug]);
      }
      await engine.setConfig('search.remote_private_pages', 'visible');
      await engine.setConfig('search.mcp_keyword_only', 'false');
      return { source_id: source, read_registry: CODEX_DISCOVERY_REGISTRY, allowed_tools: ['get_page', 'search', 'list_pages'] };
    }
    test('listing applies source, prefix and visibility before pagination', async () => {
      const extra = await fixture(), job = await f.claim(extra);
      f.replies(tool('list_pages', { limit: 2, offset: 0 }), tool('list_pages', { limit: 2, offset: 2 }), f.final);
      await f.run(job); const rows = await output(job);
      expect(rows[0].items.map((r: any) => r.slug)).toEqual(['notes/a', 'notes/b']);
      expect(rows[0]).toMatchObject({ has_more: true, next_offset: 2 });
      expect(rows[1].items.map((r: any) => r.slug)).toEqual(['notes/c']); expect(rows[1].has_more).toBe(false);
      expect(JSON.stringify(f.calls())).not.toContain('aaa-private'); expect(f.calls()).toHaveLength(3);
    });
    test('keyword search has bounded snippets and no vector dispatch under hybrid configuration', async () => {
      const extra = await fixture(), job = await f.claim(extra);
      const forbidden = spyOn(f.engine(), 'searchVector').mockImplementation(async () => { throw new Error('forbidden vector dispatch'); });
      try {
        f.replies(tool('search', { query: 'evidence', limit: 20, offset: 0 }), f.final); await f.run(job);
        const [result] = await output(job); expect(result.mode).toBe('keyword');
        expect(result.items.map((r: any) => r.slug).sort()).toEqual(['notes/a', 'notes/b', 'notes/c']);
        expect(result.items.every((r: any) => r.source_id === extra.source_id && r.chunk_text.includes('Evidence'))).toBe(true);
        expect(forbidden).not.toHaveBeenCalled(); expect(f.calls()).toHaveLength(2);
      } finally { forbidden.mockRestore(); }
    });
    test('an exact slug grant is not widened to descendants', async () => {
      const job = await f.claim({ ...await fixture(), allowed_slug_prefixes: ['notes/a'] });
      f.replies(tool('list_pages', { limit: 20, offset: 0 }), f.final); await f.run(job);
      expect((await output(job))[0].items.map((r: any) => r.slug)).toEqual(['notes/a']);
    });
    test('keyword pagination includes the requested offset and bounds snippets', async () => {
      const extra = await fixture(), engine = f.engine();
      for (let i = 0; i < 15; i++) {
        const slug = `notes/more-${i}`, body = 'Evidence discovery. '.repeat(100);
        await engine.putPage(slug, { title: slug, type: 'note', compiled_truth: body }, { sourceId: extra.source_id });
        const snapshot = (await engine.readPageSnapshot(slug, { sourceId: extra.source_id }))!;
        await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: body, chunk_source: 'compiled_truth' }],
          { sourceId: extra.source_id, expectedRevision: snapshot.revision, sealChunkerVersion: 4 });
        await engine.executeRaw('UPDATE pages SET text_projection_revision=knowledge_revision WHERE source_id=$1 AND slug=$2', [extra.source_id, slug]);
      }
      const job = await f.claim(extra); f.replies(tool('search', { query: 'evidence', limit: 1, offset: 10 }), f.final); await f.run(job);
      const [result] = await output(job); expect(result.items).toHaveLength(1);
      expect(result.items[0].chunk_text.length).toBeLessThanOrEqual(600); expect(result.has_more).toBe(true);
    });
    test('the operation preserves a narrower delegated source grant', async () => {
      const extra = await fixture(), engine = f.engine();
      const tools = buildBrainTools({ engine, config: { engine: engine.kind }, subagentId: 1, sourceId: extra.source_id,
        allowedNames: new Set(['list_pages']), nativeDiscovery: { allowedSlugPrefixes: ['notes/*'] },
        delegatedAuth: { clientId: 'synthetic-client', scopes: ['read'], sourceId: 'other', allowedSources: ['other'], allowedOperations: ['list_pages'] } });
      await expect(tools[0]!.execute({ source_id: extra.source_id, limit: 2, offset: 0 }, { engine, jobId: 1, remote: true })).rejects.toMatchObject({ code: 'permission_denied' });
      expect(f.calls()).toHaveLength(0);
    });
    test('empty keyword results are successful retained reads', async () => {
      const job = await f.claim(await fixture());
      f.replies(tool('search', { query: 'nonexistentword', limit: 3, offset: 0 }), f.final); await f.run(job);
      expect((await output(job))[0]).toMatchObject({ items: [], has_more: false });
      expect((await f.engine().executeRaw('SELECT status FROM subagent_tool_executions WHERE job_id=$1', [job.id]))).toEqual([{ status: 'complete' }]);
    });
    test('model-authored source authority and unbounded requests fail before reads', async () => {
      const extra = await fixture();
      for (const args of [{ limit: 1, offset: 0, source_id: 'other' }, { limit: 21, offset: 0 }, { limit: 1, offset: 1001 }]) {
        const job = await f.claim(extra); f.replies(tool('list_pages', args));
        await expect(f.run(job)).rejects.toThrow(); expect(await output(job)).toEqual([]);
      }
    });
    test('lost result acknowledgement reuses the persisted action identity', async () => {
      const job = await f.claim(await fixture()), original = store.settleCodexAction;
      f.replies(tool('list_pages', { limit: 2, offset: 0 }), f.final);
      const fault = spyOn(store, 'settleCodexAction').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('synthetic result acknowledgement loss'); });
      try { await expect(f.run(job)).rejects.toThrow('synthetic'); } finally { fault.mockRestore(); }
      const [prior] = await f.engine().executeRaw<{ gbrain_tool_use_id: string }>('SELECT gbrain_tool_use_id FROM subagent_tool_executions WHERE job_id=$1', [job.id]);
      await f.run(job); expect(f.calls()).toHaveLength(2);
      expect(await f.engine().executeRaw('SELECT gbrain_tool_use_id FROM subagent_tool_executions WHERE job_id=$1', [job.id])).toEqual([prior]);
    });
    test('a database failure is retained as failure, never a successful empty search', async () => {
      const job = await f.claim(await fixture()); f.replies(tool('search', { query: 'evidence', limit: 2, offset: 0 }), f.final);
      const fault = spyOn(f.engine(), 'searchKeyword').mockRejectedValueOnce(new Error('SYNTHETIC_PRIVATE_DATABASE_ERROR'));
      try { await f.run(job); } finally { fault.mockRestore(); }
      expect(await output(job)).toEqual([{ error: 'codex_action_read_failed' }]);
      expect(await f.engine().executeRaw('SELECT status FROM subagent_tool_executions WHERE job_id=$1', [job.id])).toEqual([{ status: 'failed' }]);
      expect(JSON.stringify(f.calls())).not.toContain('SYNTHETIC_PRIVATE_DATABASE_ERROR');
    });
    test('unsafe or stale text projections are excluded and search declares indexed coverage', async () => {
      const extra = await fixture();
      await f.engine().executeRaw("UPDATE pages SET chunker_version=-1 WHERE source_id=$1 AND slug='notes/a'", [extra.source_id]);
      await f.engine().executeRaw("UPDATE pages SET text_projection_revision=NULL WHERE source_id=$1 AND slug='notes/b'", [extra.source_id]);
      const job = await f.claim(extra); f.replies(tool('search', { query: 'evidence', limit: 20, offset: 0 }), f.final); await f.run(job);
      const [result] = await output(job); expect(result.items.map((r: any) => r.slug)).toEqual(['notes/c']);
      expect(result.coverage).toBe('bounded_indexed_keyword_candidates');
    });
    test('legacy and unknown registries cannot admit discovery tools', async () => {
      for (const extra of [{ allowed_tools: ['search'] }, { read_registry: 'future' }]) await expect(f.claim(extra)).rejects.toThrow();
      expect(f.calls()).toHaveLength(0);
    });
    test('an older child cannot execute a discovery job', async () => {
      noteChildSubscriptionEnforcement(['codex-subscription-v1', 'codex-host-read-v1', 'codex-host-actions-v1']);
      for (const jobName of ['subagent', 'skillopt']) await expect(runJobInChild({ jobId: 1, jobName, codexAuthorized: true, codexDiscovery: true, lockToken: 'unused',
        abortSignal: new AbortController().signal, shutdownSignal: new AbortController().signal,
        invocation: { cmd: '/nonexistent/forbidden', argsPrefix: [] }, tiniPath: '' })).rejects.toMatchObject({ reasonCode: 'child_protocol_incompatible' });
    });
  });
}
