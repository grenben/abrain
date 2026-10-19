import { writeStdoutFinal, setCliExitVerdict } from '../../core/cli-force-exit.ts';
import { auditPrivateRoutes } from '../../core/ai/private-route-audit.ts';
import type { CliDispatchContext } from '../command-table.ts';
import { PIN_HELP, runPins } from '../private-codex/pins.ts';
import { JOB_UPGRADE_HELP, runJobUpgrade } from '../private-codex/jobs.ts';

/** Engine-free: an audit must never bootstrap a database, discover models or invoke a provider. */
export async function run(args: string[], ctx: CliDispatchContext): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    await writeStdoutFinal('Usage: gbrain private-codex audit --json\nThe no-call audit alone does not inspect database, worker or queued-job planes.\n' + PIN_HELP + JOB_UPGRADE_HELP);
    return;
  }
  if (args[0] === 'pins') return runPins(args.slice(1), ctx);
  if (args[0] === 'jobs') return runJobUpgrade(args.slice(1), ctx);
  if (args[0] !== 'audit' || args.some(arg=>!['audit','--json'].includes(arg))) throw new Error('Usage: gbrain private-codex audit --json');
  await writeStdoutFinal(JSON.stringify(await auditPrivateRoutes(),null,2)+'\n');
  setCliExitVerdict(1); // Incomplete coverage must not be a green CI result.
}
