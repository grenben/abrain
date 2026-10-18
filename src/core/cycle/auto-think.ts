import { readPrivateCodexConfig } from '../ai/private-policy.ts';
import { runPrivateAutoThink } from './auto-think-codex.ts';
import { OperationError } from '../ops/contract.ts';
import type { PhaseResult } from '../cycle.ts';
import { formatCycleCost } from './budget-meter.ts';
/** Opt-in automatic questions, dispatched by ordinary and queued cycles.
 * Private mode retains drafts and requires every selected answer/save before
 * cooldown. API mode preserves its legacy budget and completion behavior. */

import type { BrainEngine } from '../engine.ts';
import { runThink, persistSynthesis, type ThinkLLMClient } from '../think/index.ts';
import { resolveModel } from '../model-config.ts';
import { embedQueryWithPrefix } from '../search/query-prefix.ts';
import { BudgetMeter, loadAllowUnpriced, loadPricingOverrides, parseBudgetUsd } from './budget-meter.ts';

export interface DreamPhaseResult {
  name: 'auto_think' | 'drift';
  status: 'complete' | 'partial' | 'failed' | 'skipped';
  detail: string;
  totals?: Record<string, number>;
  duration_ms: number;
}

export interface AutoThinkPhaseOpts {
  brainDir?: string;
  signal?: AbortSignal;
  deadlineAtMs?: number | null;
  dryRun: boolean;
  /** Inject LLM client (tests). Defaults to the real Anthropic SDK. */
  client?: ThinkLLMClient;
  /** Override the audit-ledger path (tests). */
  auditPath?: string;
  /** #5426: source the cycle runs for; syntheses are saved there. */
  sourceId?: string;
}

export interface AutoThinkConfig {
  enabled: boolean;
  questions: string[];
  maxPerCycle: number;
  budgetUsd: number;
  allowUnpriced: boolean;
  cooldownDays: number;
  autoCommit: boolean;
}

async function loadConfig(engine: BrainEngine): Promise<AutoThinkConfig> {
  const enabledStr = await engine.getConfig('dream.auto_think.enabled');
  const questionsStr = await engine.getConfig('dream.auto_think.questions');
  const maxPerStr = await engine.getConfig('dream.auto_think.max_per_cycle');
  const autoCommitStr = await engine.getConfig('dream.auto_think.auto_commit');

  let questions: string[] = [];
  if (questionsStr) {
    try {
      const parsed = JSON.parse(questionsStr);
      if (readPrivateCodexConfig() && (!Array.isArray(parsed) || parsed.some(q=>typeof q !== 'string'))) throw new Error('invalid questions');
      if (Array.isArray(parsed)) questions = parsed.filter(q => typeof q === 'string');
    } catch { if(readPrivateCodexConfig()) throw new OperationError('invalid_params','Automatic think questions must be a JSON string array.','Correct dream.auto_think.questions before running the phase.'); }
  }

  // getNumberConfig (not `parse* || N`) so a configured 0 is honored — a bare
  // `|| N` coerces an explicit 0 back to the default (budget 0 = "spend nothing",
  // cooldown 0 = "no cooldown"). max_per_cycle stays inline: its Math.max(1, ...)
  // floor already makes 0 invalid there, so no configured value is lost.
  const budgetUsd = parseBudgetUsd(await engine.getConfig('dream.auto_think.budget'), 2.0);
  const cooldownDays = Math.max(0, await getNumberConfig(engine, 'dream.auto_think.cooldown_days', 30));

  if(readPrivateCodexConfig() && maxPerStr && !/^(?:[1-9]|1[0-9]|20)$/.test(maxPerStr))throw new OperationError('invalid_params','Automatic think max_per_cycle must be between 1 and 20.','Use a bounded integer.');
  return {
    enabled: enabledStr === 'true',
    questions,
    maxPerCycle: maxPerStr ? Math.max(1, parseInt(maxPerStr, 10) || 5) : 5,
    budgetUsd,
    allowUnpriced: await loadAllowUnpriced(engine),
    cooldownDays,
    autoCommit: autoCommitStr === 'true',
  };
}

async function getNumberConfig(engine: BrainEngine, key: string, fallback: number): Promise<number> {
  const raw = await engine.getConfig(key);
  if (raw === undefined || raw === null) return fallback;
  const value = Number(raw);
  return Number.isNaN(value) ? fallback : value;
}

async function isCoolingDown(engine: BrainEngine, days: number): Promise<boolean> {
  if (days <= 0) return false;
  const last = await engine.getConfig('dream.auto_think.last_completion_ts');
  if (!last) return false;
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) return false;
  return (Date.now() - lastMs) < days * 86_400_000;
}

function skipped(_reason: string, detail: string): DreamPhaseResult {
  return { name: 'auto_think', status: 'skipped', detail, duration_ms: 0 };
}

export async function runPhaseAutoThink(
  engine: BrainEngine,
  opts: AutoThinkPhaseOpts,
): Promise<DreamPhaseResult> {
  const start = Date.now();
  const config = await loadConfig(engine);
  if(readPrivateCodexConfig())return runPrivateAutoThink(engine,opts,config);

  if (!config.enabled) {
    return skipped('not_configured', 'dream.auto_think.enabled is false');
  }
  if (config.questions.length === 0) {
    return skipped('no_questions', 'dream.auto_think.questions is empty');
  }
  if (await isCoolingDown(engine, config.cooldownDays)) {
    return skipped('cooldown_active', `auto_think cooled down (${config.cooldownDays}d cooldown)`);
  }

  const meter = new BudgetMeter({
    budgetUsd: config.budgetUsd,
    allowUnpriced: config.allowUnpriced,
    pricingOverrides: await loadPricingOverrides(engine),
    phase: 'auto_think',
    auditPath: opts.auditPath,
  });

  const modelId = await resolveModel(engine, {
    configKey: 'models.auto_think',
    deprecatedConfigKey: 'dream.auto_think.model',
    tier: 'deep',
    fallback: 'opus',
  });

  const limit = Math.min(config.questions.length, config.maxPerCycle);
  const results: Array<{ question: string; status: string; slug?: string; warnings?: string[] }> = [];

  for (let i = 0; i < limit; i++) {
    const q = config.questions[i];

    // Pre-check budget for the planned synthesize call. Estimate ~5K input tokens
    // (system + ~30 takes + 20 page chunks) and 4K output cap.
    const check = meter.check({
      modelId,
      estimatedInputTokens: 5_000,
      maxOutputTokens: 4_000,
      label: `auto_think:${q.slice(0, 40)}`,
    });
    if (!check.allowed) {
      results.push({ question: q, status: 'budget_exhausted' });
      break;
    }

    if (opts.dryRun) {
      results.push({ question: q, status: 'dry_run' });
      continue;
    }

    try {
      const result = await runThink(engine, {
        question: q,
        // #3734: auto-think uses same vector takes retrieval as interactive think.
        embedQuestion: (text) => embedQueryWithPrefix(engine, text),
        save: config.autoCommit,
        client: opts.client,
        model: modelId,
        // The BudgetMeter above priced modelId; a chain hop would spend on a model it never checked.
        allowFallback: false,
        // Fail-closed trust: the local dream cycle must say so explicitly, or
        // trajectory injection degrades to visibility='world' rows.
        remote: false,
        ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
      });
      // #1698: an empty synthesis (no LLM available / malformed output / empty-JSON answer)
      // must NOT count as complete or advance the cooldown — that is the same silent-success
      // the CLI + MCP think paths now guard against. runThink sets synthesisOk=false; the
      // empty page is never written, and persistSynthesis returns slug '' + the
      // SYNTHESIS_EMPTY_NOT_PERSISTED warning. Mark these 'partial' so `anyComplete` below
      // stays false on empty-only runs and the cooldown timestamp isn't advanced (so the
      // next cycle retries) — and surface the warning instead of dropping it.
      const emptySynthesis = result.synthesisOk === false;
      const warnings = [...result.warnings];
      let slug: string | undefined;
      if (config.autoCommit) {
        const persisted = await persistSynthesis(engine, result, opts.sourceId ? { sourceId: opts.sourceId } : {});
        slug = persisted.slug || undefined;  // '' = persist-skip signal (#1698)
        warnings.push(...persisted.warnings);
      }
      results.push({
        question: q,
        status: emptySynthesis ? 'partial' : 'complete',
        slug,
        warnings: warnings.length ? warnings : undefined,
      });
    } catch (e) {
      results.push({
        question: q,
        status: 'failed',
        warnings: [(e as Error).message],
      });
    }
  }

  // Update cooldown timestamp ONLY when at least one synthesis completed.
  const anyComplete = results.some(r => r.status === 'complete');
  if (anyComplete && !opts.dryRun) {
    await engine.setConfig('dream.auto_think.last_completion_ts', new Date().toISOString());
  }

  const detail = `${results.filter(r => r.status === 'complete').length} synthesized, ` +
    `${results.filter(r => r.status === 'budget_exhausted').length} skipped (budget), ` +
    `${results.filter(r => r.status === 'failed').length} failed. ` +
    `Cumulative cost: ${formatCycleCost(meter.totalSpent)} / $${config.budgetUsd.toFixed(2)}`;

  return {
    name: 'auto_think',
    status: anyComplete ? 'complete' : (results.length === 0 ? 'skipped' : 'partial'),
    detail,
    totals: { questions_run: results.length, synthesized: results.filter(r => r.status === 'complete').length },
    duration_ms: Date.now() - start,
  };
}

// Test-only export: pin config-resolution behavior at function granularity.
export const __testing = { loadConfig };

/** Common phase adapter for dream, scheduled cycles and queued workers. */
export async function runCycleAutoThink(engine:BrainEngine|null,opts:AutoThinkPhaseOpts):Promise<PhaseResult>{
  if(!engine)return{phase:'auto_think',status:'skipped',duration_ms:0,summary:'no database connected',details:{reason:'no_database'}};
  const result=await runPhaseAutoThink(engine,opts);
  return{phase:'auto_think',status:result.status==='complete'?'ok':result.status==='partial'?'warn':result.status==='failed'?'fail':'skipped',
    duration_ms:result.duration_ms,summary:result.detail,details:{...result.totals,...readPrivateCodexConfig()?{billing:'subscription',cost_usd:null}:{}}};
}
