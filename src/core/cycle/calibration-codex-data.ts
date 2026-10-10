import type { OperationContext } from '../ops/contract.ts';
import { loadActivePack } from '../schema-pack/load-active.ts';
import type { BrainEngine, TakesScorecard } from '../engine.ts';
import { finalizeScorecard, type ScorecardRowRaw } from '../takes-resolution.ts';
import { aggregateDomainScorecards, type DomainScorecards } from '../calibration/domain-aggregators.ts';
import type { CalibrationDomain } from '../schema-pack/manifest-v1.ts';
import { OperationError } from '../ops/contract.ts';
import { digest } from '../persistence/digest.ts';

export interface CalibrationData { fingerprint: string; scorecard: TakesScorecard; domains: DomainScorecards; meanConfidence: number | null }
const sha = (sql: string) => `encode(sha256(convert_to(${sql},'UTF8')),'hex')`;
/** Database-side hashing bounds transferred evidence without truncating large scorecards.
 * Lock order: source (caller), pages, takes, assignments. Index-only fields do not change evidence.
 * The caller bounds transaction time. No private text is returned by this query.
 */
export async function calibrationFingerprint(tx: BrainEngine, sourceId: string, holder: string): Promise<string> {
  const statements = [
    `SELECT p.id, jsonb_build_array(p.id,p.slug,p.type,p.knowledge_revision,p.frontmatter)::text AS evidence
      FROM pages p WHERE p.source_id=$1 AND p.deleted_at IS NULL ORDER BY p.id FOR SHARE OF p`,
    `SELECT t.id, (to_jsonb(t)-'embedding'-'embedded_at'-'updated_at')::text AS evidence
      FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1 AND p.deleted_at IS NULL AND t.holder=$2
      ORDER BY t.id FOR SHARE OF t`,
    `SELECT a.take_id::text||':'||a.domain AS id,to_jsonb(a)::text AS evidence
      FROM take_domain_assignments a JOIN takes t ON t.id=a.take_id JOIN pages p ON p.id=t.page_id
      WHERE p.source_id=$1 AND p.deleted_at IS NULL AND t.holder=$2 ORDER BY a.take_id,a.domain FOR SHARE OF a`,
  ];
  const hashes: string[] = [];
  for (let i = 0; i < statements.length; i++) {
    const [row] = await tx.executeRaw<{ hash: string }>(`WITH locked AS MATERIALIZED (${statements[i]})
      SELECT ${sha(`COALESCE(string_agg(${sha('evidence')},'' ORDER BY id),'')`)} AS hash FROM locked`, i === 0 ? [sourceId] : [sourceId, holder]);
    if (!row?.hash) throw new OperationError('storage_error', 'Calibration evidence could not be fingerprinted.', 'Retry from current source evidence.');
    hashes.push(row.hash);
  }
  return digest(hashes);
}
export async function readCalibrationData(tx: BrainEngine, sourceId: string, holder: string, domains: CalibrationDomain[]): Promise<CalibrationData> {
  const fingerprint = await calibrationFingerprint(tx, sourceId, holder);
  const [row] = await tx.executeRaw<ScorecardRowRaw & { mean_confidence: number | null }>(`SELECT
    COUNT(*) FILTER (WHERE t.kind='bet')::int AS total_bets,
    COUNT(*) FILTER (WHERE t.resolved_quality IN ('correct','incorrect','partial'))::int AS resolved,
    COUNT(*) FILTER (WHERE t.resolved_quality='correct')::int AS correct,
    COUNT(*) FILTER (WHERE t.resolved_quality='incorrect')::int AS incorrect,
    COUNT(*) FILTER (WHERE t.resolved_quality='partial')::int AS partial,
    COUNT(*) FILTER (WHERE t.resolved_quality='unresolvable')::int AS unresolvable_count,
    AVG(CASE WHEN t.resolved_quality IN ('correct','incorrect') THEN POWER(t.weight-CASE t.resolved_quality WHEN 'correct' THEN 1 ELSE 0 END,2) END)::float8 AS brier,
    AVG(CASE WHEN t.resolved_quality IN ('correct','incorrect') THEN t.weight END)::float8 AS mean_confidence
    FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1 AND p.deleted_at IS NULL AND t.holder=$2`, [sourceId,holder]);
  if (!row) throw new OperationError('storage_error', 'Calibration scorecard is unavailable.', 'Retry the source-scoped aggregation.');
  const scorecards = await aggregateDomainScorecards(tx, holder, domains, sourceId, true);
  if (Object.values(scorecards).some(value => value.extras?.error !== undefined)) {
    throw new OperationError('storage_error', 'A calibration domain could not be aggregated.', 'Repair the domain configuration before generating a profile.');
  }
  if (fingerprint !== await calibrationFingerprint(tx, sourceId, holder)) {
    throw new OperationError('revision_conflict', 'Calibration inputs changed during aggregation.', 'Retry from a fresh source snapshot.');
  }
  return { fingerprint, scorecard: finalizeScorecard(row), domains: scorecards, meanConfidence: row.mean_confidence === null ? null : Number(row.mean_confidence) };
}

/** Resolve the same source-specific pack at snapshot and publication boundaries. */
export async function calibrationPack(ctx: OperationContext, sourceId: string) {
  const sourcePack = await ctx.engine.getConfig(`schema_pack.source.${sourceId}`);
  return loadActivePack({ cfg: ctx.config, remote: false, sourceId,
    dbConfig: await ctx.engine.getConfig('schema_pack') ?? undefined,
    perSourceDb: sourcePack ? new Map([[sourceId,sourcePack]]) : undefined });
}
