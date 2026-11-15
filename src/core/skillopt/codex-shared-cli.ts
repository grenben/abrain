import { usageError } from '../../cli/cli-error.ts';
import { isWriteRequestId } from '../persistence/types.ts';
import { skillName } from '../shared-skills/manifest.ts';
import type { SkillOptOpts } from './types.ts';
type Target = Omit<NonNullable<SkillOptOpts['sharedSkill']>, 'source_id' | 'request_id'>;
const bad = (): never => { throw usageError('Invalid shared optimizer target.',
  'Use --shared-skill with --pack-id, --source-incarnation and --expected-revision from the shared catalog, plus the explicit Codex allowance and source.'); };
/** Host CLI target only; no model-authored authority or inferred current revision. */
export function splitSharedOptimizerFlags(args: string[]): { args: string[]; target?: Target } {
  const rest: string[] = [], values = new Map<string, string>(); let shared = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--shared-skill') { if (shared) bad(); shared = true; continue; }
    if (!['--pack-id', '--source-incarnation', '--expected-revision'].includes(flag)) { rest.push(flag); continue; }
    if (values.has(flag) || !args[i + 1] || args[i + 1]!.startsWith('--')) bad();
    values.set(flag, args[++i]!);
  }
  if (!shared && !values.size) return { args: rest };
  if (!shared || values.size !== 3 || !isWriteRequestId(values.get('--source-incarnation')) || !isWriteRequestId(values.get('--expected-revision'))) bad();
  return { args: rest, target: { pack_id: skillName(values.get('--pack-id'), 'pack_id'),
    source_incarnation: values.get('--source-incarnation')!.toLowerCase(), expected_revision: values.get('--expected-revision')!.toLowerCase() } };
}
