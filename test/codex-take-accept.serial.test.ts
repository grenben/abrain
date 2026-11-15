import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { acceptProposal, listPendingProposals, type ProposalActionTarget } from '../src/core/take-proposals.ts';
import { bindTakeProposalPage, persistTakeProposalBatch } from '../src/core/cycle/propose-takes-persistence.ts';
import { createSubscriptionRun } from '../src/core/ai/subscription-admission.ts';
import { withCodexSubscription } from '../src/core/ai/subscription-context.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { compactWriteReceipts } from '../src/core/persistence/journal.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { preparePageAdmission, submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { parseTakesFence } from '../src/core/takes-fence.ts';
import { managedBrain, type ManagedBrain } from './helpers/managed-brain.ts';
import { put } from './helpers/wave-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';

const slug = 'notes/forecast', quote = 'The orchard will double its harvest next year.';
type Fixture = ManagedBrain & { id: number; target: ProposalActionTarget; file: () => string };
async function fixture(backend: string, run: (f: Fixture) => Promise<void>) {
  const fetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('forbidden inference/network'); }) as unknown as typeof globalThis.fetch;
  try {
    await managedBrain(async brain => {
      const { engine, ctx, root } = brain;
      await put(ctx, slug, quote);
      const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
      const body = snapshot.page.compiled_truth!;
      const binding = await bindTakeProposalPage(engine, 'default', slug, snapshot.revision, ctx);
      const runId = randomUUID();
      await createSubscriptionRun(engine, { runId, accountLane: runId, maxAttempts: 1, maxTurns: 1, deadline: new Date(Date.now() + 60000) });
      await withCodexSubscription({ engine, runId }, () => persistTakeProposalBatch(engine, {
        sourceId: 'default', slug, hash: sha256(body), version: 'codex-take-proposals-v1:fixture', runId,
        model: 'codex-cli:fixture', existing: [], emptyText: 'empty', binding,
        proposals: [{ claim_text: quote, kind: 'bet', holder: 'brain', weight: 0.6, source_quote: quote }],
      }));
      const [proposal] = await listPendingProposals(engine, { sourceId: 'default' });
      await run({ ...brain, id: proposal!.id, target: { engine, config: ctx.config, sourceId: 'default', brainDir: root },
        file: () => readFileSync(join(root, `${slug}.md`), 'utf8') });
    }, { databaseUrl: backend === 'postgres' ? process.env.DATABASE_URL : undefined });
  } finally { globalThis.fetch = fetch; }
}
async function state(engine: BrainEngine, id: number) {
  const [row] = await engine.executeRaw<{ status: string; promoted_row_num: number | null; codex_evidence: Record<string, any> }>(
    'SELECT status,promoted_row_num,codex_evidence FROM take_proposals WHERE id=$1', [id]);
  return row!;
}
const requests = (engine: BrainEngine) => engine.executeRaw<{ id: string; state: string; intent: unknown; compacted: boolean }>(
  "SELECT id,state,intent,compacted FROM persistence_requests WHERE operation='takes_add'");
const strand = (engine: BrainEngine, id: number) => engine.executeRaw('UPDATE take_proposals SET promoted_row_num=NULL WHERE id=$1', [id]);
async function protocol(engine: BrainEngine, sql: string, params: unknown[] = []) {
  await engine.transaction(async tx => { await declarePersistenceProtocol(tx); await tx.executeRaw(sql, params); });
}

for (const backend of testBackends()) {
  const check = (name: string, run: (f: Fixture) => Promise<void>) => test(`${backend}: private take acceptance ${name}`, () => fixture(backend, run), 180000);
  check('publishes reviewed content with retained evidence and one canonical receipt', async ({ engine, target, id, file }) => {
    expect((await listPendingProposals(engine))[0]!.codex_evidence?.source_quote).toBe(quote);
    const result = await acceptProposal(target, id, { claim: 'The orchard will double its harvest by next winter.', weight: 0.8 });
    expect(result.rowNum).toBeGreaterThan(0);
    const saved = await state(engine, id);
    expect(saved.status).toBe('accepted');
    expect(Number(saved.promoted_row_num)).toBe(result.rowNum);
    expect(saved.codex_evidence.acceptance.params.weight).toBe(0.8);
    expect(saved.codex_evidence.acceptance.params.source).toBe(`take_proposals#${id} (edited)`);
    expect(saved.codex_evidence.source_quote).toBe(quote);
    expect(parseTakesFence(file()).takes.map(t => t.claim)).toEqual(['The orchard will double its harvest by next winter.']);
    expect(await requests(engine)).toHaveLength(1);
  });
  check('resumes committed reviewer edits without reinterpreting omitted edits', async ({ engine, target, id, file }) => {
    const first = await acceptProposal(target, id, { claim: 'The orchard expands its harvest by next winter.', holder: 'world' });
    await strand(engine, id);
    await expect(acceptProposal(target, id, { claim: 'Changed retry claim' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect((await acceptProposal(target, id)).rowNum).toBe(first.rowNum);
    expect(parseTakesFence(file()).takes.map(t => t.claim)).toEqual(['The orchard expands its harvest by next winter.']);
    expect(await requests(engine)).toHaveLength(1);
  });
  check('uses the retained digest after real receipt compaction and across writers', async ({ engine, target, id }) => {
    const first = await acceptProposal(target, id, { weight: 0.9 });
    await disposePersistenceConsumer(engine);
    const [request] = await requests(engine);
    // Completed auxiliary effects permit the production compactor to discard intent.
    await protocol(engine, "UPDATE persistence_effects SET state='committed' WHERE request_id=$1::uuid", [request!.id]);
    expect(await compactWriteReceipts(engine, 0)).toBeGreaterThan(0);
    expect((await requests(engine))[0]).toMatchObject({ intent: null, compacted: true });
    await registerLocalWriter(engine, 'cli', undefined, true);
    await strand(engine, id);
    expect((await acceptProposal(target, id)).rowNum).toBe(first.rowNum);
    expect(await requests(engine)).toHaveLength(1);
  });
  check('refuses a changed proposal even when its prior write committed', async ({ engine, target, id }) => {
    await acceptProposal(target, id); await strand(engine, id);
    await engine.executeRaw("UPDATE take_proposals SET claim_text='A changed proposal claim' WHERE id=$1", [id]);
    await expect(acceptProposal(target, id)).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(await requests(engine)).toHaveLength(1);
    expect((await state(engine, id)).promoted_row_num).toBeNull();
  });
  check('refuses missing evidence without claiming or publishing', async ({ engine, target, id, file }) => {
    const before = file();
    await engine.executeRaw('UPDATE take_proposals SET codex_evidence=NULL WHERE id=$1', [id]);
    await expect(acceptProposal(target, id)).rejects.toMatchObject({ code: 'invalid_params' });
    expect((await state(engine, id)).status).toBe('pending');
    expect(await requests(engine)).toHaveLength(0); expect(file()).toBe(before);
  });
  check('refuses changed page revisions before acceptance', async ({ engine, ctx, target, id, file }) => {
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug, expected_revision: snapshot.revision,
      content: `---\ntype: note\ntitle: Forecast\n---\n\n${quote} The forecast was updated.\n` } });
    const before = file();
    await expect(acceptProposal(target, id)).rejects.toMatchObject({ code: 'revision_conflict' });
    expect((await state(engine, id)).status).toBe('pending');
    expect(await requests(engine)).toHaveLength(0); expect(file()).toBe(before);
  });
  check('refuses absent quotations and replacement source identity', async ({ engine, target, id }) => {
    const evidence = (await state(engine, id)).codex_evidence;
    await engine.executeRaw('UPDATE take_proposals SET codex_evidence=$2::text::jsonb WHERE id=$1', [id, JSON.stringify({ ...evidence, source_quote: 'An invented source quotation.' })]);
    await expect(acceptProposal(target, id)).rejects.toMatchObject({ code: 'revision_conflict' });
    await engine.executeRaw('UPDATE take_proposals SET codex_evidence=$2::text::jsonb WHERE id=$1', [id, JSON.stringify({ ...evidence, source_incarnation: randomUUID() })]);
    await expect(acceptProposal(target, id)).rejects.toMatchObject({ code: 'source_changed' });
    expect(await requests(engine)).toHaveLength(0);
  });
  check('checks the expected source again in the real admission path', async ({ engine, ctx }) => {
    await expect(preparePageAdmission(ctx, { operation: 'takes_add', params: { slug, claim: quote, kind: 'bet', holder: 'brain',
      weight: 0.6, expected_source_incarnation: randomUUID() } })).rejects.toMatchObject({ code: 'source_changed' });
    expect(await requests(engine)).toHaveLength(0);
  });
  check('rolls back its claim and frozen plan if journal insertion fails', async ({ engine, target, id, file }) => {
    await engine.executeRaw(`CREATE FUNCTION fail_private_accept() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.operation='takes_add' THEN RAISE EXCEPTION 'synthetic admission failure'; END IF; RETURN NEW; END $$`);
    await engine.executeRaw('CREATE TRIGGER fail_private_accept BEFORE INSERT ON persistence_requests FOR EACH ROW EXECUTE FUNCTION fail_private_accept()');
    const before = file();
    await expect(acceptProposal(target, id)).rejects.toThrow();
    expect((await state(engine, id)).status).toBe('pending');
    expect((await state(engine, id)).codex_evidence.acceptance).toBeUndefined();
    expect(await requests(engine)).toHaveLength(0); expect(file()).toBe(before);
    await engine.executeRaw('DROP TRIGGER fail_private_accept ON persistence_requests');
    expect((await acceptProposal(target, id)).rowNum).toBeGreaterThan(0);
  });
  check('reconciles after an exception between committed effect and completion stamp', async ({ engine, target, id, file }) => {
    await engine.executeRaw(`CREATE FUNCTION fail_private_stamp() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.promoted_row_num IS NOT NULL THEN RAISE EXCEPTION 'synthetic completion failure'; END IF; RETURN NEW; END $$`);
    await engine.executeRaw('CREATE TRIGGER fail_private_stamp BEFORE UPDATE ON take_proposals FOR EACH ROW EXECUTE FUNCTION fail_private_stamp()');
    await expect(acceptProposal(target, id, { weight: 0.8 })).rejects.toThrow();
    expect((await state(engine, id)).status).toBe('accepted');
    expect((await requests(engine))[0]!.state).toBe('committed');
    expect(parseTakesFence(file()).takes).toHaveLength(1);
    await engine.executeRaw('DROP TRIGGER fail_private_stamp ON take_proposals');
    expect((await acceptProposal(target, id)).rowNum).toBeGreaterThan(0);
    expect(await requests(engine)).toHaveLength(1); expect(parseTakesFence(file()).takes).toHaveLength(1);
  });
  check('serializes competing writer identities and rejects changed retry inputs', async ({ engine, target, id, file }) => {
    const first = await registerLocalWriter(engine, 'cli');
    const second = { id: randomUUID(), credential: randomUUID(), lane: 'cli' as const };
    await engine.executeRaw(`INSERT INTO persistence_local_writers(id,lane,credential_hash,grant_ceiling)
      SELECT $1::uuid,'cli',$2,grant_ceiling FROM persistence_local_writers WHERE id=$3::uuid`, [second.id, sha256(second.credential), first.id]);
    const results = await Promise.allSettled([
      withVerifiedLocalRegistration(engine, first, () => acceptProposal(target, id, { weight: 0.7 })),
      withVerifiedLocalRegistration(engine, second, () => acceptProposal(target, id, { weight: 0.8 })),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect(await requests(engine)).toHaveLength(1); expect(parseTakesFence(file()).takes).toHaveLength(1);
  });
  check('refuses a revoked accepting writer before claim admission', async ({ engine, target, id }) => {
    await engine.executeRaw('UPDATE persistence_local_writers SET revoked_at=now()');
    await expect(acceptProposal(target, id)).rejects.toMatchObject({ code: 'permission_denied' });
    expect((await state(engine, id)).status).toBe('pending'); expect(await requests(engine)).toHaveLength(0);
  });
  check('recovers the admitted request after interruption before waiting for effects', async ({ engine, target, id, file }) => {
    await disposePersistenceConsumer(engine);
    let interrupted = false;
    const wrapper = new Proxy(engine, { get(base, key) {
      if (key === 'transaction') return async (fn: (tx: BrainEngine) => Promise<unknown>) => {
        let claimed = false;
        const result = await base.transaction(tx => fn(new Proxy(tx, { get(inner, method) {
          if (method === 'executeRaw') return (sql: string, args?: unknown[]) => {
            if (sql.includes("UPDATE take_proposals SET status='accepted'")) claimed = true;
            return inner.executeRaw(sql, args);
          };
          const value = Reflect.get(inner, method, inner);
          return typeof value === 'function' ? value.bind(inner) : value;
        } })));
        if (claimed && !interrupted) { interrupted = true; throw new Error('synthetic after admission interruption'); }
        return result;
      };
      const value = Reflect.get(base, key, base);
      return typeof value === 'function' ? value.bind(base) : value;
    } });
    await expect(acceptProposal({ ...target, engine: wrapper }, id, { weight: 0.9 })).rejects.toThrow();
    expect(interrupted).toBe(true);
    expect((await state(engine, id)).status).toBe('accepted');
    expect((await requests(engine))[0]!.state).toBe('queued');
    expect(parseTakesFence(file()).takes).toHaveLength(0);
    expect((await acceptProposal(target, id)).rowNum).toBeGreaterThan(0);
    expect(await requests(engine)).toHaveLength(1); expect(parseTakesFence(file()).takes).toHaveLength(1);
  });
  check('does not silently reinterpret a pre-protocol stranded private claim', async ({ engine, target, id }) => {
    await engine.executeRaw("UPDATE take_proposals SET status='accepted',acted_at=now()-interval '1 day' WHERE id=$1", [id]);
    await expect(acceptProposal(target, id)).rejects.toMatchObject({ code: 'invalid_params' });
    expect(await requests(engine)).toHaveLength(0);
  });
  check('refuses a retained plan with changed or extra operation fields', async ({ engine, target, id }) => {
    await acceptProposal(target, id); await strand(engine, id);
    await engine.executeRaw(`UPDATE take_proposals SET codex_evidence=jsonb_set(codex_evidence,
      '{acceptance,params,force}','true'::jsonb) WHERE id=$1`, [id]);
    await expect(acceptProposal(target, id)).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(await requests(engine)).toHaveLength(1);
  });
  check('does not turn ambiguous or failed receipts into a fresh write', async ({ engine, target, id }) => {
    await acceptProposal(target, id); await strand(engine, id);
    await disposePersistenceConsumer(engine);
    const [request] = await requests(engine);
    await protocol(engine, "UPDATE persistence_requests SET state='failed',error_code='write_outcome_unknown' WHERE id=$1::uuid", [request!.id]);
    await expect(acceptProposal(target, id)).rejects.toMatchObject({ code: 'write_outcome_unknown' });
    expect(await requests(engine)).toHaveLength(1);
    expect((await state(engine, id)).promoted_row_num).toBeNull();
  });
  check('refuses a missing retained receipt without re-admitting', async ({ engine, target, id }) => {
    await acceptProposal(target, id); await strand(engine, id);
    await engine.executeRaw(`UPDATE take_proposals SET codex_evidence=jsonb_set(codex_evidence,
      '{acceptance,requestId}',$2::text::jsonb) WHERE id=$1`, [id, JSON.stringify(randomUUID())]);
    await expect(acceptProposal(target, id)).rejects.toMatchObject({ code: 'write_pending' });
    expect(await requests(engine)).toHaveLength(1);
    expect((await state(engine, id)).promoted_row_num).toBeNull();
  });
  check('detects a changed proposal between inspection and its locked admission', async ({ engine, target, id, file }) => {
    const before = file(); let changed = false;
    const wrapper = new Proxy(engine, { get(base, key) {
      if (key === 'transaction') return async (fn: (tx: BrainEngine) => Promise<unknown>) => {
        if (!changed) {
          changed = true;
          await base.executeRaw("UPDATE take_proposals SET claim_text='The orchard changes its forecast.' WHERE id=$1", [id]);
        }
        return base.transaction(fn);
      };
      const value = Reflect.get(base, key, base);
      return typeof value === 'function' ? value.bind(base) : value;
    } });
    await expect(acceptProposal({ ...target, engine: wrapper }, id)).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(changed).toBe(true); expect(await requests(engine)).toHaveLength(0);
    expect((await state(engine, id)).status).toBe('pending'); expect(file()).toBe(before);
  });
  check('retains a committed effect but refuses completion of a changed proposal', async ({ engine, target, id, file }) => {
    await engine.executeRaw(`CREATE FUNCTION change_private_proposal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      UPDATE take_proposals SET claim_text='A changed proposal after admission' WHERE id=TG_ARGV[0]::bigint;
      RETURN NEW; END $$`);
    await engine.executeRaw(`CREATE TRIGGER change_private_proposal AFTER INSERT ON takes
      FOR EACH ROW EXECUTE FUNCTION change_private_proposal('${id}')`);
    await expect(acceptProposal(target, id)).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect((await requests(engine))[0]!.state).toBe('committed');
    expect((await state(engine, id)).promoted_row_num).toBeNull();
    expect(parseTakesFence(file()).takes.map(t => t.claim)).toEqual([quote]);
    await engine.executeRaw('DROP TRIGGER change_private_proposal ON takes');
    // Restore the original reviewed row for reconciliation; never regenerate its write.
    await engine.executeRaw('UPDATE take_proposals SET claim_text=$2 WHERE id=$1', [id, quote]);
    expect((await acceptProposal(target, id)).rowNum).toBeGreaterThan(0);
    expect(await requests(engine)).toHaveLength(1);
  });
}
