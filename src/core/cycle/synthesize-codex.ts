import { remainingSynthesisSubmissions, reserveSynthesisSubmission } from './synthesize-codex-admission.ts';
import { resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { readPrivateCodexConfig, assertPrivateRoute, privateModelForRole } from '../ai/private-policy.ts';
import { codexSubscriptionContext } from '../ai/subscription-context.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { maintenanceCallerPreflight, maintenancePreflight, validateMaintenance } from '../persistence/prepared-maintenance.ts';
import { digest } from '../persistence/digest.ts';
import { serializeMarkdown } from '../markdown.ts';
import { loadStorageConfig, isDbOnly } from '../storage-config.ts';
import { loadSynthConfig, runTriagePass, buildDreamSummarySlug, type SynthesizePhaseOpts, type SynthConfig } from './synthesize.ts';
import { resolveCycleDate } from './cycle-date.ts';
import { rescueConfigOf } from './triage-rescue.ts';
import { resolveTriageDecide } from './triage-decide.ts';
import { assertTriageRoute } from './triage-codex.ts';
import { partitionCompletedSynthesis } from './synthesize-completion.ts';
import { pendingPublication, retainPublication, executePublication, type PublicationPage } from './codex-publication-plan.ts';
import { discoverPrivateSynthesis, snapshotSynthesisInput, type SynthesisInput } from './synthesize-codex-input.ts';
import { proposeSynthesis, synthesisChunks } from './synthesize-codex-proposal.ts';

/** Separate from the legacy native agent queue: one bounded schema proposal per chunk. */
export async function runPrivateSynthesize(engine: BrainEngine, opts: SynthesizePhaseOpts): Promise<PhaseResult> {
  const start = Date.now();
  const result = (status: PhaseResult['status'], summary: string, details: Record<string, unknown> = {}): PhaseResult =>
    ({ phase: 'synthesize', status, summary, duration_ms: Date.now() - start, details: { ...details, cost_usd: null } });
  try {
    opts.signal?.throwIfAborted();
    if (!opts.brainDir?.trim()) throw new Error('codex_synthesis_brain_dir_required');
    const signals = [opts.signal];
    if (opts.deadlineAtMs != null) signals.push(AbortSignal.timeout(Math.max(0, Math.min(2147483647, opts.deadlineAtMs - Date.now()))));
    opts = { ...opts, brainDir: resolve(opts.brainDir), signal: AbortSignal.any(signals.filter((s): s is AbortSignal => !!s)) };
    const sourceId = opts.sourceId ?? 'default', config = await loadSynthConfig(engine), policy = readPrivateCodexConfig()!;
    assertPrivateRoute(config.model, 'dream.synthesize.model', policy);
    const decide = await resolveTriageDecide(engine);
    assertTriageRoute(config.triage.model, !!decide);
    if (!config.enabled && !opts.once && !opts.inputFile) return result('skipped', 'synthesis is disabled', { reason: 'disabled' });
    if (!await maintenanceCallerPreflight(engine, sourceId)) throw new Error('codex_publication_requires_managed_persistence');
    if (opts.dryRun) return result('ok', 'Private synthesis preview: no inference or publication.', { dryRun: true });
    const authority = (await maintenancePreflight(engine, sourceId, opts.brainDir, { deadlineAtMs: opts.deadlineAtMs }))!;
    const pending = await pendingPublication(engine, authority, 'synthesis');
    if (pending) {
      const count = await executePublication(engine, authority, pending, opts.signal);
      return result('ok', 'Recovered the retained synthesis plan.', { recovered: true, pages_written: count, plan_id: pending.plan_id });
    }
    const cooldownKey = `dream.codex.synthesis.last_completion.${sourceId}.${authority.writer.sourceIncarnation}`;
    if (!opts.once && !opts.inputFile && !opts.date && !opts.from && !opts.to && config.cooldownHours > 0 &&
      Date.parse(await engine.getConfig(cooldownKey) ?? '') + config.cooldownHours * 3600000 > Date.now()) return result('skipped', 'Synthesis cooldown is active.', { reason: 'cooldown_active' });
    if (!codexSubscriptionContext()) throw new SubscriptionAdmissionError('subscription_required');
    if (config.budgetUsd === 0) return result('skipped', 'Synthesis budget is explicitly zero.', { reason: 'budget_zero' });
    const date = await resolveCycleDate(engine, { explicitDate: opts.date ?? opts.cycleDate, now: opts.now });
    const transcripts = await discoverPrivateSynthesis(engine, config, opts);
    const legacy = await partitionCompletedSynthesis(engine, transcripts, sourceId, authority, false);
    let processed = 0, written = 0, completed = legacy.completed.size, deferred = 0, ignored = 0;
    for (const transcript of transcripts) {
      opts.signal?.throwIfAborted(); await opts.yieldDuringPhase?.();
      if (legacy.completed.has(transcript.filePath)) continue;
      const identity = digest(['codex-synthesis-v1', sourceId, authority.writer.sourceIncarnation, transcript.filePath,
        transcript.contentHash, config.reflectionsPrefix, config.originalsPrefix]);
      const key = `dream.codex.synthesis.v1.${identity}`;
      if (await engine.getConfig(key)) { completed++; continue; }
      if (processed >= 8 || (opts.deadlineAtMs != null && Date.now() >= opts.deadlineAtMs)) { deferred++; continue; }
      const input = await snapshotSynthesisInput(engine, sourceId, transcript);
      if (!input) { ignored++; continue; }
      // Reject oversize transcripts before buying triage; never mark an omitted chunk complete.
      const chunks = synthesisChunks(input.transcript, config);
      if (chunks.length > await remainingSynthesisSubmissions(engine, authority, config.maxSubmissionsPerSourcePerDay)) { deferred++; continue; }
      const triage = await runTriagePass(engine, [input.transcript], { ...config.triage, model: config.triage.model,
        concurrency: 1, signal: opts.signal, now: opts.triageNow, rescue: rescueConfigOf(config.triage), decide }, opts.yieldDuringPhase);
      const verdict = triage.reports[0];
      // Cached negatives are free and must not starve later transcripts on every cycle.
      if (triage.judged > 0 || verdict?.worth) processed++;
      if (!verdict || verdict.deferred || verdict.unreliable || verdict.score === null) { deferred++; continue; }
      if (!verdict.worth) continue;
      const pages = await proposeSynthesis({ ...input, config, model: privateModelForRole(policy, 'dream-synthesis'), date, identity,
        signal: opts.signal, yieldDuringPhase: opts.yieldDuringPhase,
        beforeCall: () => reserveSynthesisSubmission(engine, authority, config.maxSubmissionsPerSourcePerDay) });
      await addSynthesisSummary(engine, opts, config, input, pages, identity, date);
      const plan = await retainPublication(engine, authority, 'synthesis', { version: 1, authority: authority.writer,
        pages, evidence: input.evidence, files: input.files, skipped: pages.length === 0,
        watermark: { key, value: new Date().toISOString() } }, opts.signal);
      written += await executePublication(engine, authority, plan, opts.signal);
    }
    if (!deferred && written > 0) await engine.transaction(async tx => {
      opts.signal?.throwIfAborted();
      await codexSubscriptionContext()?.checkAuthorityInTransaction?.(tx);
      await validateMaintenance(tx, authority, config.reflectionsPrefix);
      await tx.setConfig(cooldownKey, new Date().toISOString());
    });
    return result(deferred ? 'warn' : 'ok', deferred ? 'Synthesis has deferred transcripts; completion is not claimed for them.' : 'Bounded synthesis finished.',
      { transcripts_processed: processed, already_synthesized: completed, pages_written: written, deferred, excluded_visibility: ignored });
  } catch (error) {
    // Never turn policy, parsing, lifecycle or publication failures into clean zero/completion.
    const candidate = (error as { code?: unknown })?.code ?? (error instanceof Error ? error.message : null);
    const code = typeof candidate === 'string' && /^[a-zA-Z0-9_:-]{1,100}$/.test(candidate) ? candidate : 'codex_synthesis_failed';
    return result('fail', 'Private synthesis failed; inspect its retained plan and receipts before retrying.', { reason: code });
  }
}
async function addSynthesisSummary(engine: BrainEngine, opts: SynthesizePhaseOpts, config: SynthConfig, input: SynthesisInput,
  pages: PublicationPage[], identity: string, date: string): Promise<void> {
  if (!pages.length) return;
  const slug = `${buildDreamSummarySlug(config.outputRoot, date)}-codex-${identity.slice(0, 16)}`;
  const body = pages.map(p => `- [[${p.slug}]]`).join('\n');
  const storage = loadStorageConfig(opts.brainDir);
  const file = !/^(false|0|off)$/i.test(await engine.getConfig('dream.synthesize.summary_file_write') ?? '') && !(storage && isDbOnly(slug, storage));
  pages.push({ slug, expectedRevision: null, evidence: input.evidence, files: input.files, file: !!file,
    content: serializeMarkdown({ visibility: 'world', dream_generated: true, dream_cycle_date: date, dream_created_cycle_date: date,
      raw_source: input.transcript.filePath, transcript_hash: input.transcript.contentHash, codex_proposal_version: 1 },
    body, '', { title: 'Synthesis output', type: 'note', tags: [] }) });
}
