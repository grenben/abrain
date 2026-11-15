/**
 * trajectory-route.ts — the per-question trajectory lookup behind the
 * harness's trajectory routing (temporal / knowledge_update intents): extract
 * candidate entities from the question + retrieved slugs, resolve each to a
 * slug, and render the first non-empty trajectory block. Peeled from
 * src/commands/eval-longmemeval.ts.
 *
 * Non-private best-effort: any error (or a 5s findTrajectory stall) degrades to
 * "no block injected". Private lookup/timeout failures fail the question.
 */

import { readPrivateCodexConfig } from '../../core/ai/private-policy.ts';
import { assertSubscriptionTarget } from '../../core/ai/subscription-target.ts';
import { codexSubscriptionContext } from '../../core/ai/subscription-context.ts';
import { canonicalizeEvalEntity, makeAliasMap } from './extract.ts';

import type { PGLiteEngine } from '../../core/pglite-engine.ts';
import type { TrajectoryPoint } from '../../core/engine.ts';
import { extractCandidateEntities } from '../../core/think/entity-extract.ts';
import { resolveEntitySlugWithSource, type ResolutionSource } from '../../core/entities/resolve.ts';
import { formatTrajectoryBlock } from '../../core/trajectory-format.ts';
import { OperationTimeoutError, withTimeout } from '../../core/timeout.ts';
import type { Intent } from './intent.ts';

export interface TrajectoryRoute {
  /** Rendered block for the reader prompt; empty when nothing was found. */
  block: string;
  points: number;
  entityResolved: string | null;
  resolutionSource: ResolutionSource | null;
}

export const EMPTY_TRAJECTORY_ROUTE: TrajectoryRoute = { block: '', points: 0, entityResolved: null, resolutionSource: null };

export async function routeTrajectory(
  engine: PGLiteEngine,
  question: string,
  retrievedSlugs: readonly string[],
  intent: Intent,
): Promise<TrajectoryRoute> {
  const privateMode = !!readPrivateCodexConfig();
  try {
    if (privateMode) {
      const context = codexSubscriptionContext();
      if (!context) throw new Error('subscription required');
      await assertSubscriptionTarget(engine);
      await context.checkAuthority?.();
    }
    const candidates = extractCandidateEntities(question, [...retrievedSlugs]);
    for (const cand of candidates) {
      const resolved = privateMode ? await canonicalizeEvalEntity(engine, 'default', cand.raw, makeAliasMap(), true)
        : await resolveEntitySlugWithSource(engine, 'default', cand.raw);
      if (!resolved) continue;
      // Unlike the think production path, the harness does NOT skip
      // fallback_slugify results: the extractor and the lookup both slugify
      // free-form entity names, so they cohere on the same fallback slug
      // and there are no canonical pages in the benchmark to protect.
      const points: TrajectoryPoint[] = await withTimeout(
        engine.findTrajectory({ entitySlug: resolved.slug, sourceId: 'default', remote: false, kind: 'all', limit: 100 }),
        5000,
        'findTrajectory',
      ).catch((err: unknown) => {
        if (!privateMode && err instanceof OperationTimeoutError) return [];
        throw err;
      });
      if (privateMode) {
        await assertSubscriptionTarget(engine);
        await codexSubscriptionContext()?.checkAuthority?.();
      }
      if (points.length === 0) continue;
      const fmt = formatTrajectoryBlock(points, resolved.slug, { intent });
      if (fmt.rendered.length === 0) continue;
      return { block: fmt.rendered, points: fmt.emittedPoints, entityResolved: resolved.slug, resolutionSource: resolved.source };
    }
  } catch {
    if (privateMode) throw new Error('private_eval_trajectory_failed');
    // Best-effort: any error degrades to "no block injected".
  }
  return EMPTY_TRAJECTORY_ROUTE;
}
