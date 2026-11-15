/**
 * Postgres-only regression: a fact quoted only in take_proposals.codex_evidence
 * is deleted by purge and is reported as a residual before deletion. Quotes
 * and a newline make the JSONB text representation require escaped matching.
 *
 * Run: DATABASE_URL=... bun test test/e2e/purge-codex-evidence-postgres.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { planFactPurge, submitPurgeFactMutation, type PurgeTarget } from '../../src/core/facts/purge.ts';
import { verifyFactPurge } from '../../src/core/facts/purge-verify.ts';
import { withEnv } from '../helpers/with-env.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;
const CLAIM = `The note says "alpha" on line one\nand line two ${randomUUID()}`;

let engine: PostgresEngine;
let home: string | undefined;

function ctx(): Parameters<typeof submitPurgeFactMutation>[0] {
  return {
    engine,
    config: { engine: 'postgres' },
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
  } as Parameters<typeof submitPurgeFactMutation>[0];
}

d('purge_fact take proposal Codex evidence (Postgres only)', () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-purge-codex-evidence-'));
    engine = await setupDB();
    // The shared e2e reset intentionally does not truncate this proposal cache.
    await engine.executeRaw('TRUNCATE take_proposals CASCADE');
    await registerLocalWriter(engine, 'cli');
  }, 30_000);

  afterAll(async () => {
    await teardownDB();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test('deletes an evidence-only match and reports it while it remains', async () => withEnv({ GBRAIN_HOME: home! }, async () => {
    const [fact] = await engine.executeRaw<PurgeTarget>(`INSERT INTO facts (source_id, fact, source, visibility)
      VALUES ('default', $1, 'test', 'private')
      RETURNING id,source_id,visibility,fact,entity_slug,source_markdown_slug,gbrain_fact_fingerprint(fact) AS fact_hash,
        embedding::text AS embedding,embedding_model`, [CLAIM]);
    const [proposal] = await engine.executeRaw<{ id: number }>(`INSERT INTO take_proposals
      (source_id,page_slug,content_hash,prompt_version,proposal_run_id,claim_text,kind,holder,weight,model_id,codex_evidence)
      VALUES ('default','codex-evidence/regression',repeat('a',64),'fixture-v1','purge-codex-evidence-run',
        'unrelated proposal claim','take','brain',0.5,'fixture-model',$1::text::jsonb)
      RETURNING id`, [JSON.stringify({ source_quote: CLAIM })]);
    const proposalId = Number(proposal!.id);

    // Confirm the target occurs only in JSON-escaped evidence, not claim_text
    // or the raw evidence serialization.
    const [stored] = await engine.executeRaw<{ claim_text: string; evidence: string }>(
      'SELECT claim_text,codex_evidence::text AS evidence FROM take_proposals WHERE id=$1', [proposalId]);
    expect(stored!.claim_text).not.toContain(CLAIM);
    expect(stored!.evidence).not.toContain(CLAIM);
    expect(stored!.evidence).toContain(JSON.stringify(CLAIM).slice(1, -1));

    const plan = await planFactPurge(engine, fact!, false);
    const before = await verifyFactPurge(engine, { target: fact!, plan, dryRun: false });
    expect(before.stores.find(store => store.store === 'take_proposals'))
      .toMatchObject({ status: 'incomplete', remaining: 1 });

    const dry = await submitPurgeFactMutation(ctx(), { id: fact!.id, dry_run: true });
    const done = await submitPurgeFactMutation(ctx(), {
      id: fact!.id,
      confirm: dry.confirm_token,
      expected_revision: dry.expected_revision,
    }) as { state: string; purge: { removed: Record<string, number> }; stores: Array<{ store: string; status: string; removed?: number }> };
    expect(done.state).toBe('committed');
    expect(done.purge.removed.take_proposals).toBe(1);
    expect(done.stores.find((store: { store: string }) => store.store === 'take_proposals'))
      .toMatchObject({ status: 'deleted', removed: 1 });
    expect(await engine.executeRaw('SELECT 1 FROM take_proposals WHERE id=$1', [proposalId])).toHaveLength(0);
  }));
});
