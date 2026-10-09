import { writeStdoutFinal, setCliExitVerdict } from '../../core/cli-force-exit.ts';
import { auditPrivateRoutes } from '../../core/ai/private-route-audit.ts';
import type { CliDispatchContext } from '../command-table.ts';

/** Engine-free: an audit must never bootstrap a database, discover models or invoke a provider. */
export async function run(args: string[], _ctx: CliDispatchContext): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    await writeStdoutFinal('Usage: gbrain private-codex audit --json\nNo-call file/environment audit. Database, worker and queued-job planes remain uninspected.\n');
    return;
  }
  if (args[0] !== 'audit' || args.some(arg=>!['audit','--json'].includes(arg))) throw new Error('Usage: gbrain private-codex audit --json');
  await writeStdoutFinal(JSON.stringify(await auditPrivateRoutes(),null,2)+'\n');
  setCliExitVerdict(1); // Incomplete coverage must not be a green CI result.
}
