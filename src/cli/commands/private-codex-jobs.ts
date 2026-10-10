import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import type { CliDispatchContext } from '../command-table.ts';
import { writeStdoutFinal } from '../../core/cli-force-exit.ts';
import { previewJobUpgrade, upgradeError, upgradeHash, upgradeIds } from '../../core/minions/codex-upgrade-snapshot.ts';
import { parkUpgradeJobs, restoreParkedJobs } from '../../core/minions/codex-upgrade-park.ts';
import { previewUpgradeSubmission, resubmitUpgradeJob, validateUpgradeSubmission } from '../../core/minions/codex-upgrade-resubmit.ts';

export const JOB_UPGRADE_HELP = `gbrain private-codex jobs preview --ids ID,ID --json
gbrain private-codex jobs park --ids ID,ID --expect HASH --yes --json
gbrain private-codex jobs restore --id UUID --expect HASH --yes --json
gbrain private-codex jobs resubmit-preview --file REVIEWED.json --json
gbrain private-codex jobs resubmit --file REVIEWED.json --expect HASH --yes --json
gbrain private-codex jobs receipts --json
All commands connect the selected existing brain without startup migrations or inference.
Stop producers for cutover. Active work must drain; parking never cancels it. Resubmission requires new explicit content and allowances.
`;
function submissionFile(file: string) {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return upgradeError('submission_file_unavailable'); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) upgradeError('unsafe_submission_file');
    let data: unknown;
    try { data = JSON.parse(readFileSync(fd, 'utf8')); } catch { return upgradeError('invalid_submission_json'); }
    return validateUpgradeSubmission(data);
  } finally { closeSync(fd); }
}
export async function runJobUpgrade(args: string[], ctx: CliDispatchContext): Promise<void> {
  const command = args[0], flags = new Map<string,string>();
  const commands: Record<string,string[]> = {
    preview: ['--ids','--json'], park: ['--ids','--expect','--yes','--json'], restore: ['--id','--expect','--yes','--json'],
    'resubmit-preview': ['--file','--json'], resubmit: ['--file','--expect','--yes','--json'], receipts: ['--json'],
  };
  const allowed = Object.hasOwn(commands,command!) ? commands[command!] : undefined;
  if (!allowed) upgradeError('invalid_arguments');
  for (let i=1; i<args.length; i++) {
    const key = args[i]!; if (!allowed!.includes(key) || flags.has(key)) upgradeError('invalid_arguments');
    const value = ['--yes','--json'].includes(key) ? 'true' : args[++i];
    if (!value || value.startsWith('--')) upgradeError('invalid_arguments'); flags.set(key,value!);
  }
  const expected = flags.get('--expect');
  if (['park','restore','resubmit'].includes(command!)) { if (!flags.has('--yes') || !expected) upgradeError('preview_required'); upgradeHash(expected!); }
  let ids: number[] = [];
  if (['preview','park'].includes(command!)) { const raw = flags.get('--ids'); if (!raw || !/^\d+(,\d+)*$/.test(raw)) upgradeError('invalid_ids'); ids = upgradeIds(raw!.split(',').map(Number)); }
  const id = flags.get('--id'); if (command === 'restore' && (!id || !/^[a-f0-9-]{36}$/.test(id))) upgradeError('invalid_receipt');
  const file = flags.get('--file'); if (command!.startsWith('resubmit') && !file) upgradeError('submission_file_required');
  const submission = file ? submissionFile(file) : undefined;
  const engine = await ctx.connectEngine({ probeOnly: true });
  try {
    const result = command === 'preview' ? await previewJobUpgrade(engine,ids)
      : command === 'park' ? await parkUpgradeJobs(engine,ids,expected!)
      : command === 'restore' ? await restoreParkedJobs(engine,id!,expected!)
      : command === 'resubmit-preview' ? await previewUpgradeSubmission(engine,submission)
      : command === 'resubmit' ? await resubmitUpgradeJob(engine,submission,expected!)
      : await engine.executeRaw("SELECT id,plan,state,receipt FROM codex_upgrade_receipts WHERE kind='jobs' ORDER BY sequence DESC LIMIT 256");
    await writeStdoutFinal(JSON.stringify(result,null,2)+'\n');
  } finally { await engine.disconnect(); }
}
