import type { BrainEngine } from '../../core/engine.ts';
import { readPrivateCodexConfig } from '../../core/ai/private-policy.ts';
import { jobMayGenerate, preflightSubscriptionSubmit, type JobSubscriptionAuthorization } from '../../core/minions/subscription-jobs.ts';
import { jobSpendAuthorization, type SpendAuthorization } from '../../core/minions/spend-authorization.ts';
import { intFlagValue, numberFlagValue } from '../../cli/flag-values.ts';
import { usageError } from '../../cli/cli-error.ts';

const FLAGS = ['--codex-max-attempts', '--codex-max-turns', '--codex-deadline'] as const;
function value(args: string[], flag: string): string | undefined {
  const indices = args.flatMap((arg, i) => arg === flag ? [i] : []);
  if (indices.length > 1 || args.some(arg => arg.startsWith(`${flag}=`))) {
    throw usageError(`${flag} must occur once in space-separated form.`, `Use ${flag} <value>.`);
  }
  if (!indices.length) return undefined;
  const raw = args[indices[0]! + 1];
  if (!raw || raw.startsWith('--')) throw usageError(`${flag} requires a value.`, `Use ${flag} <value>.`);
  return raw;
}

/** Local CLI authority only. Job JSON, --yes and USD flags cannot create this grant. */
export async function prepareCodexJobSubmit(engine: BrainEngine, name: string, data: Record<string, unknown>, args: string[]): Promise<{
  codexSubscription?: JobSubscriptionAuthorization; spendAuthorization?: SpendAuthorization;
}> {
  const requested = args.some(arg => FLAGS.some(flag => arg === flag || arg.startsWith(`${flag}=`)));
  const generative = jobMayGenerate(name, data);
  if (!requested && !generative) return {};
  const policy = readPrivateCodexConfig();
  if (!policy && !requested) return {};
  if (!policy || !generative) throw usageError('Codex allowances require strict private configuration and a generative job.', 'Configure private Codex explicitly and select a supported generative job.');
  const raw = FLAGS.map(flag => value(args, flag));
  if (raw.some(v => v === undefined)) throw usageError('Private generation requires all three Codex allowance flags.', 'Supply --codex-max-attempts, --codex-max-turns and --codex-deadline; a USD cap or --yes does not authorize subscription calls.');
  const maxAttempts = intFlagValue(raw[0], FLAGS[0], { min: 1, max: 1000, example: 10 });
  const maxTurns = intFlagValue(raw[1], FLAGS[1], { min: 1, max: maxAttempts, example: Math.min(10, maxAttempts) });
  const deadline = new Date(raw[2]!);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(raw[2]!) || !Number.isFinite(deadline.getTime()) ||
      deadline.toISOString().replace('.000Z', 'Z') !== raw[2]!.replace('.000Z', 'Z') ||
      deadline.getTime() <= Date.now() || deadline.getTime() > Date.now() + 86_400_000) {
    throw usageError('--codex-deadline must be a future UTC ISO timestamp within 24 hours.', 'Use the same absolute deadline when resubmitting the same idempotency key.');
  }
  const codexSubscription = { maxAttempts, maxTurns, deadline };
  await preflightSubscriptionSubmit(engine, name, data, codexSubscription);
  // Any paid auxiliary work needs its own explicit numeric USD cap.
  const usd = value(args, '--max-usd');
  let spendAuthorization: SpendAuthorization | undefined;
  if (usd !== undefined) {
    const cap = numberFlagValue(usd, '--max-usd', { min: 0.000001, example: 1 });
    spendAuthorization = jobSpendAuthorization({ consented_effects: ['paid'], cap_usd: cap, cap_source: 'user', via: 'max_usd' }, { command: `jobs submit ${name}` });
  }
  return { codexSubscription, ...(spendAuthorization ? { spendAuthorization } : {}) };
}

export function codexSubmitSummary(grant: JobSubscriptionAuthorization): string {
  return JSON.stringify({ billing: 'subscription', max_attempts: grant.maxAttempts, max_turns: grant.maxTurns,
    deadline: grant.deadline.toISOString(), monetary_cost_usd: null, remaining_quota: null });
}
