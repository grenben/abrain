import type { OperationContext } from '../ops/contract.ts';
import { OperationError } from '../ops/contract.ts';
import type { CalibrationProfileOpts } from './calibration-profile.ts';
import { effectivePhaseDeadlineMs, type ScopedReadOpts } from './base-phase.ts';
import { codexSubscriptionContext, withCodexSubscription } from '../ai/subscription-context.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { CodexProposalError } from '../ai/providers/codex-contract.ts';
import { PrivateRoutingError } from '../ai/private-policy.ts';
import { currentVerifiedLocalWriter } from '../persistence/identity.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { resolveModel } from '../model-config.ts';
import { resolveOwnerHolder } from '../owner-holder.ts';
import { digest } from '../persistence/digest.ts';
import { gateVoice } from '../calibration/voice-gate.ts';
import { CodexVoiceRejectedError } from '../calibration/voice-gate-codex.ts';
import { readCalibrationData, calibrationPack } from './calibration-codex-data.ts';
import { calibrationFacts, proposeCalibration, CODEX_CALIBRATION_VERSION, type CalibrationProposal } from './calibration-codex-proposal.ts';
import { bindCalibration, calibrationTransaction, persistPrivateProfile, readPrivateProfile, recheckCalibrationAuthority, type PrivateProfile } from './calibration-codex-store.ts';

const errorCode = (error: unknown) => error instanceof CodexProposalError ? error.reason
  : error instanceof OperationError || error instanceof PrivateRoutingError || error instanceof SubscriptionAdmissionError || error instanceof CodexVoiceRejectedError ? error.code : 'storage_error';
const profileResult = (profile: PrivateProfile, cacheHit: boolean) => ({ profile_written: !cacheHit, cache_hit: cacheHit, profile_id: String(profile.id),
  voice_gate_passed: true, voice_gate_attempts: Number(profile.voice_gate_attempts), pattern_statements: profile.pattern_statements,
  active_bias_tags: profile.active_bias_tags, total_resolved: Number(profile.total_resolved), brier: profile.brier === null ? null : Number(profile.brier) });

/** One bounded source profile at a time. Reads and canonical profile storage never invoke a model. */
export async function runPrivateCalibration(ctx: OperationContext, scope: ScopedReadOpts, opts: CalibrationProfileOpts) {
  const results: Array<Record<string, unknown>> = [], failures: Array<{ source_id: string; code: string }> = [];
  try {
    const context = codexSubscriptionContext(), job = currentSubmissionAuthority();
    if (ctx.remote !== false || currentVerifiedLocalWriter()?.remote || job && job.kind !== 'application') throw new OperationError('permission_denied', 'Private calibration requires local authority.', 'Use a trusted local cycle.');
    if (!context) throw new SubscriptionAdmissionError('subscription_required');
    const [brain] = await ctx.engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
    const [admittedBrain] = await context.engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
    if (!brain || brain.brain_id !== admittedBrain?.brain_id) throw new SubscriptionAdmissionError('subscription_identity_conflict');
    const model = await resolveModel(ctx.engine, { cliFlag: opts.model, configKey: 'models.chat', tier: 'reasoning', fallback: 'sonnet' });
    await resolveModel(ctx.engine, { tier: 'utility', fallback: 'haiku' });
    const holder = resolveOwnerHolder({ override: opts.holder, configValue: await ctx.engine.getConfig('emotional_weight.user_holder') });
    const gradeCompletion = opts.gradeCompletion ?? 1;
    if (!holder.trim() || holder.length > 200 || !Number.isFinite(gradeCompletion) || gradeCompletion < 0 || gradeCompletion > 1) throw new CodexProposalError('invalid_input');
    const version = `${CODEX_CALIBRATION_VERSION}:${opts.promptVersion ?? 'default'}`;
    const ids = scope.sourceIds ?? (scope.sourceId ? [scope.sourceId] : undefined);
    const sources = await ctx.engine.executeRaw<{ id: string }>(`SELECT id FROM sources WHERE NOT archived${ids ? ' AND id=ANY($1::text[])' : ''} ORDER BY id LIMIT 21`, ids ? [ids] : []);
    if (sources.length > 20 || ids && ids.some(id => !sources.some(s => s.id === id))) throw new CodexProposalError('invalid_input');
    const remaining = effectivePhaseDeadlineMs(600000, opts.deadlineAtMs, Date.now());
    if (remaining <= 0) return { summary: 'calibration_profile: deadline exhausted', status: 'warn' as const, details: { deadline_hit: true, profile_written: false } };
    const signal = AbortSignal.any([AbortSignal.timeout(Math.floor(remaining)), ...(context.signal ? [context.signal] : [])]);
    const deadline = Date.now() + remaining;
    await withCodexSubscription({ ...context, signal }, async () => {
      for (const source of sources) {
        try {
          results.push({ source_id: source.id, ...await runSourceCalibration(ctx, source.id, {
            version, model, holder, gradeCompletion, runId: context.runId, deadline,
          }) });
        } catch (error) { failures.push({ source_id: source.id, code: errorCode(error) }); break; }
      }
    });
  } catch (error) { failures.push({ source_id: scope.sourceId ?? '__scope__', code: errorCode(error) }); }
  const completed = results.filter(row => row.profile_id !== undefined).length;
  return { summary: `calibration_profile: ${completed} private profiles, ${failures.length} failures`,
    status: failures.length ? completed ? 'warn' as const : 'fail' as const : 'ok' as const,
    details: { profiles: results, failures, profile_written: results.some(row => row.profile_written === true), profiles_completed: completed,
      cost_usd: null, billing: 'subscription', ...(failures[0] ? { error_code: failures[0].code } : {}) } };
}

interface CalibrationSettings {
  version: string; model: string; holder: string; gradeCompletion: number;
  runId: string; deadline: number;
}
async function runSourceCalibration(ctx: OperationContext, sourceId: string, settings: CalibrationSettings): Promise<Record<string, unknown>> {
  const { version, model, holder, gradeCompletion, runId, deadline } = settings;
  const pack = await calibrationPack(ctx, sourceId);
  const packIdentity = pack.identity, domains = pack.manifest.calibration_domains ?? [];
  if (domains.length > 32 || domains.some(d => d.name.length > 100 || d.page_types.length > 32)) throw new CodexProposalError('invalid_input');
  const requestHash = digest({ version, model, holder, gradeCompletion, domains, pack: packIdentity });
  const snapshot = await calibrationTransaction(ctx, async tx => {
    const binding = await bindCalibration({ ...ctx, engine: tx }, sourceId);
    const prior = await readPrivateProfile(tx, binding, holder, runId, requestHash);
    return prior ? { binding, prior } : { binding, data: await readCalibrationData(tx, sourceId, holder, domains) };
  });
  if (snapshot.prior) return profileResult(snapshot.prior, true);
  const data = snapshot.data!;
  if (data.scorecard.resolved < 5) return { profile_written: false, skipped: 'insufficient_data', total_resolved: data.scorecard.resolved };
  const facts = calibrationFacts(data), context = codexSubscriptionContext()!;
  let proposal: CalibrationProposal | undefined;
  const gated = await withCodexSubscription({ ...context, checkAuthority: async () => {
    await context.checkAuthority?.();
    await calibrationTransaction(ctx, tx => recheckCalibrationAuthority(ctx, tx, snapshot.binding));
  } }, () => gateVoice({ mode: 'pattern_statement', maxAttempts: 2,
    generate: async ({ feedback }) => {
      if (context.signal?.aborted || deadline <= Date.now()) throw new CodexProposalError('aborted');
      proposal = await proposeCalibration({ model, fingerprint: data.fingerprint, facts, feedback, timeoutMs: Math.max(1, Math.min(120000, deadline-Date.now())) });
      return proposal.patterns.map(pattern => pattern.statement).join('\n');
    }, templateFallback: { fn: () => { throw new CodexVoiceRejectedError(); }, slots: null },
  }));
  if (!proposal) throw new CodexProposalError('invalid_output');
  const saved = await persistPrivateProfile(ctx, { binding: snapshot.binding, data, holder, runId, requestHash,
    model, gradeCompletion, proposal, facts, attempts: gated.attempts, version, packIdentity });
  return profileResult(saved.profile, saved.cacheHit);
}
