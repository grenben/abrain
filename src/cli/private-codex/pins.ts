import { writeStdoutFinal } from '../../core/cli-force-exit.ts';
import type { CliDispatchContext } from '../command-table.ts';
import { pinError, pinPreview, validatePinTarget, type PinTarget } from '../../core/ai/private-pin-plan.ts';
import { previewFilePins, applyFilePins, rollbackFilePins, filePinReceipts } from '../../core/ai/private-pin-file.ts';
import { previewDatabasePins, applyDatabasePins, rollbackDatabasePins } from '../../core/ai/private-pin-database.ts';

export const PIN_HELP = `gbrain private-codex pins preview --plane file|database --model codex-cli:MODEL --json
gbrain private-codex pins apply --plane file|database --model codex-cli:MODEL --expect HASH --yes --json
gbrain private-codex pins receipts --plane file|database --json
gbrain private-codex pins rollback --plane file|database --id UUID --expect HASH --yes --json
Preview is read-only. Database operations explicitly connect to the selected existing brain without startup migrations.
Use --models '{"utility":"codex-cli:U","reasoning":"codex-cli:R","deep":"codex-cli:D","subagent":"codex-cli:S"}' instead of --model for a tiered plan.
Apply changes model pins only; activation, credentials, auxiliary providers, workers and jobs are unchanged.
File migration requires a controlled cutover with other configuration writers stopped. Its native lock coordinates migration writers.
`;
export async function runPins(args: string[], ctx: CliDispatchContext): Promise<void> {
  const command = args[0], flags = new Map<string, string>();
  for (let i = 1; i < args.length; i++) {
    const key = args[i]!;
    if (!['--plane','--model','--models','--expect','--id','--yes','--json'].includes(key) || flags.has(key)) pinError('invalid_arguments');
    if (['--yes','--json'].includes(key)) flags.set(key, 'true');
    else { const value = args[++i]; if (!value || value.startsWith('--')) pinError('invalid_arguments'); flags.set(key, value!); }
  }
  const plane = flags.get('--plane'), expected = flags.get('--expect'), id = flags.get('--id');
  let target: PinTarget | undefined = flags.get('--model');
  if (flags.has('--models')) {
    if (target || flags.get('--models')!.length > 4096) pinError('invalid_arguments');
    try { target = JSON.parse(flags.get('--models')!); } catch { pinError('invalid_target'); }
    if (typeof target === 'string' || !target) pinError('invalid_target');
  }
  if (!['preview','apply','rollback','receipts'].includes(command!) || !['file','database'].includes(plane!) ||
      (['preview','apply'].includes(command!) && !target) ||
      (['apply','rollback'].includes(command!) && (!expected || !flags.has('--yes'))) || (command === 'rollback' && !id)) pinError('invalid_arguments');
  if (['preview','receipts'].includes(command!) && (flags.has('--yes') || expected || id)) pinError('invalid_arguments');
  const allowed = command === 'preview' ? ['--plane','--model','--models','--json'] : command === 'apply' ? ['--plane','--model','--models','--expect','--yes','--json']
    : command === 'rollback' ? ['--plane','--id','--expect','--yes','--json'] : ['--plane','--json'];
  if ([...flags.keys()].some(k => !allowed.includes(k)) || expected && !/^[a-f0-9]{64}$/.test(expected) || id && !/^[a-f0-9-]{36}$/.test(id)) pinError('invalid_arguments');
  if (target) validatePinTarget(target);
  let result: unknown;
  if (plane === 'file') {
    if (command === 'preview') result = pinPreview(previewFilePins(target!));
    else if (command === 'apply') result = await applyFilePins(target!, expected!);
    else if (command === 'rollback') result = await rollbackFilePins(id!, expected!);
    else result = filePinReceipts();
  } else {
    const engine = await ctx.connectEngine({ probeOnly: true });
    try {
      if (command === 'preview') result = pinPreview(await previewDatabasePins(engine, target!));
      else if (command === 'apply') result = await applyDatabasePins(engine, target!, expected!);
      else if (command === 'rollback') result = await rollbackDatabasePins(engine, id!, expected!);
      else result = await engine.executeRaw("SELECT id,plan,state,receipt FROM codex_upgrade_receipts WHERE kind='pins' ORDER BY sequence DESC LIMIT 256");
    } finally { await engine.disconnect(); }
  }
  await writeStdoutFinal(JSON.stringify(result, null, 2) + '\n');
}
