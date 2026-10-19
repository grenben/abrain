import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { runPhaseEdgeContradictions, type EdgeJudgeFn } from '../../src/core/cycle/edge-contradictions.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const databaseUrl = process.env.DATABASE_URL;
let engine: PostgresEngine | undefined;

beforeAll(async () => {
  if (!databaseUrl) return;
  assertSafeE2eDatabaseUrl(databaseUrl);
  engine = new PostgresEngine();
  await engine.connect({ database_url: databaseUrl });
  await engine.initSchema();
});
afterAll(async () => { await engine?.disconnect(); });

test('PostgreSQL publishes a live edge proposal and fences changed evidence', async () => {
  if (!engine) return;
  const db = engine;
  await db.setConfig('dream.edge_contradictions.mode', 'propose');
  const suffix = randomUUID().slice(0, 8);
  const context: OperationContext = { engine: db, config: { engine: 'postgres' },
    logger: { info: () => {}, warn: () => {}, error: () => {} }, dryRun: false, remote: false, sourceId: 'default' };
  const put = async (slug: string, title: string, type: string, body: string) => {
    await operations.find(op => op.name === 'put_page')!.handler(context, {
      slug, content: `---\ntype: ${type}\ntitle: ${title}\n---\n\n${body}`,
    });
  };
  const seed = async (name: string) => {
    const a = `companies/${name}-a-${suffix}`, b = `companies/${name}-b-${suffix}`;
    const subject = `people/${name}-${suffix}`;
    await put(a, `${name} A`, 'company', `A company ${suffix} A.`);
    await put(b, `${name} B`, 'company', `A company ${suffix} B.`);
    await put(subject, name, 'person',
      `${name} works at [${name} A](../${a}) and [${name} B](../${b}).\n\n` +
      `## Timeline\n\n- **2019-02-01** | test — joined [${name} A](../${a})\n` +
      `- **2024-05-01** | test — joined [${name} B](../${b})`);
    return { a, subject };
  };
  const conflict: EdgeJudgeFn = async () => [{ a: 1, b: 2, conflict: true, confidence: 0.9 }];
  const first = await seed('edge-live');
  const accepted = await runPhaseEdgeContradictions(db, { judge: conflict });
  expect(accepted.totals?.proposed).toBeGreaterThanOrEqual(1);
  const [proposal] = await db.executeRaw<{ status: string }>(
    `SELECT status FROM link_edge_proposals WHERE from_page_id=(SELECT id FROM pages WHERE slug=$1)`, [first.subject]);
  expect(proposal.status).toBe('proposed');

  const second = await seed('edge-stale');
  const changed: EdgeJudgeFn = async input => {
    if (input.subject.slug === second.subject) {
      await db.executeRaw(`UPDATE link_relationships SET evidence_hash='changed-during-postgres-judgment'
        WHERE from_page_id=(SELECT id FROM pages WHERE slug=$1)
          AND to_page_id=(SELECT id FROM pages WHERE slug=$2)`, [second.subject, second.a]);
    }
    return [{ a: 1, b: 2, conflict: true, confidence: 0.9 }];
  };
  const fenced = await runPhaseEdgeContradictions(db, { judge: changed });
  expect(fenced.totals?.skipped_unpublished).toBeGreaterThanOrEqual(1);
  const rows = await db.executeRaw(`SELECT 1 FROM link_edge_proposals
    WHERE from_page_id=(SELECT id FROM pages WHERE slug=$1)`, [second.subject]);
  expect(rows).toHaveLength(0);
}, 90_000);
