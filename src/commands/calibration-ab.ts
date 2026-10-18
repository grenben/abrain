import { embedQueryWithPrefix } from '../core/search/query-prefix.ts';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { resolveSourceId } from '../core/source-resolver.ts';
import { resolveOwnerHolder } from '../core/owner-holder.ts';
import { requireUuid } from '../core/persistence/digest.ts';
import { readPrivateCodexConfig } from '../core/ai/private-policy.ts';
import { usageError } from '../cli/cli-error.ts';
import { withThinkSubscription, THINK_ALLOWANCE_FLAGS } from './think-subscription.ts';
import { preparePrivateAbTrial, inspectPrivateAbTrial, recordPrivateAbPreference } from '../core/calibration/think-ab-codex.ts';
import type { ABPreference, ABTrial, ABTrialAnswer } from '../core/calibration/think-ab-store.ts';
const commands = ['ab-run', 'ab-show', 'ab-rate'];
const help = `Usage:
  gbrain calibration ab-run <question> --codex-max-attempts N --codex-max-turns N --codex-deadline <UTC> [--codex-request-id UUID] [--max-usd N] [--holder H] [--model M] [--source S] [--json]
  gbrain calibration ab-show <trial UUID> [--source S] [--json]
  gbrain calibration ab-rate <trial UUID> --prefer baseline|with_calibration|neither|tie [--notes TEXT] [--source S] [--json]

ab-run uses strict private Codex with two sequential calls and retains answers.
Reuse the request ID and identical options to resume. Review both answers before
ab-rate; no preference is inferred. ab-show and ab-rate make no model calls.
`;
function publicAnswer(answer: ABTrialAnswer | null) {
    if (!answer)
        return null;
    const { comparison_evidence, ...result } = answer;
    return { ...result, evidence: comparison_evidence.map(({ authority: _authority, ...item }) => item) };
}
function output(trial: ABTrial) {
    return { trial_id: trial.trial_id, state: trial.state, source_id: trial.source_id, holder: trial.binding.holder, model: trial.binding.model,
        profile_id: trial.binding.profile.id, baseline: publicAnswer(trial.baseline), with_calibration: publicAnswer(trial.calibrated), result_id: trial.result_id === null ? null : String(trial.result_id), monetary_cost_usd: null };
}
/** Returns false for existing calibration commands. Local CLI authority only. */
export async function runCalibrationAb(engine: BrainEngine, args: string[]): Promise<boolean> {
    const command = args[0];
    if (!commands.includes(command ?? ''))
        return false;
    if (args.includes('--help')) {
        process.stdout.write(help);
        return true;
    }
    const allowed = new Set(['--source', ...command === 'ab-run' ? ['--holder', '--model', ...THINK_ALLOWANCE_FLAGS] : command === 'ab-rate' ? ['--prefer', '--notes'] : []]);
    const values = new Map<string, string>(), positional: string[] = [];
    let json = false;
    for (let i = 1; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === '--json') {
            json = true;
            continue;
        }
        if (!arg.startsWith('--')) {
            positional.push(arg);
            continue;
        }
        if (!allowed.has(arg) || values.has(arg) || !args[i + 1] || args[i + 1]!.startsWith('--'))
            throw usageError('Unknown, repeated or incomplete A/B flag.', 'Use calibration ab-run --help.');
        values.set(arg, args[++i]!);
    }
    const sourceId = await resolveSourceId(engine, values.get('--source') ?? null);
    if (command === 'ab-run') {
        if (!readPrivateCodexConfig())
            throw usageError('ab-run requires explicit strict private configuration.', 'Configure private Codex on the host before authorizing trials.');
        const question = positional.join(' '), trialId = requireUuid(values.get('--codex-request-id') ?? randomUUID());
        const holder = resolveOwnerHolder({ override: values.get('--holder'), configValue: await engine.getConfig('emotional_weight.user_holder') });
        const opts = { question, sourceId, remote: false as const, model: values.get('--model'), calibrationHolder: holder, embedQuestion: (q: string) => embedQueryWithPrefix(engine, q) };
        const allowanceArgs = THINK_ALLOWANCE_FLAGS.filter(flag => flag !== '--codex-request-id' && values.has(flag)).flatMap(flag => [flag, values.get(flag)!]);
        const trial = await withThinkSubscription(engine, [...allowanceArgs, '--codex-request-id', trialId], opts, () => preparePrivateAbTrial({ ...opts, engine, trialId, holder }), 'calibration-ab');
        process.stdout.write(json ? JSON.stringify(output(trial), null, 2) + '\n' : `Trial ${trial.trial_id} (${trial.state})\n\nBaseline:\n${trial.baseline!.answer}\n\nWith calibration:\n${trial.calibrated!.answer}\n\nRecord your preference with calibration ab-rate ${trial.trial_id} --source ${sourceId} --prefer <choice>.\n`);
    }
    else {
        if (positional.length !== 1)
            throw usageError('Provide one A/B trial UUID.', 'Use calibration ab-run --help.');
        const trialId = requireUuid(positional[0]!);
        if (command === 'ab-rate') {
            const preference = values.get('--prefer') as ABPreference;
            const resultId = await recordPrivateAbPreference(engine, sourceId, trialId, false, preference, values.get('--notes') ?? '');
            process.stdout.write(json ? JSON.stringify({ trial_id: trialId, result_id: resultId, preferred: preference }) + '\n' : `Preference recorded for trial ${trialId}.\n`);
        }
        else {
            const trial = await inspectPrivateAbTrial(engine, sourceId, trialId, false);
            process.stdout.write(JSON.stringify(output(trial), null, 2) + '\n');
        }
    }
    return true;
}
