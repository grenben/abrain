import { randomUUID } from 'node:crypto';
import { isWriteRequestId } from '../../core/persistence/types.ts';
import { usageError } from '../../cli/cli-error.ts';

export interface EvalAllowance { requestId: string; maxAttempts: number; maxTurns: number; deadline: Date; auxiliaryUsd?: number }
const flags = ['--codex-request-id','--codex-max-attempts','--codex-max-turns','--codex-deadline','--aux-max-usd'];
export const CODEX_EVAL_ALLOWANCE_HELP = [
  'Private Codex subscription (trusted local CLI only):',
  '  --codex-max-attempts N    Maximum native attempts (1–1000).',
  '  --codex-max-turns N       Maximum accepted turns (at most attempts).',
  '  --codex-deadline UTC      Absolute ISO UTC deadline; new grants: within 24h.',
  '  --codex-request-id UUID   Reuse unchanged identity/limits for recovery.',
  '  --aux-max-usd N           Separate explicit embedding/reranking cap.',
  'All three native limits are required. --max-usd remains the legacy judge',
  'cap and never authorizes private embedding/reranking. No API fallback.',
];
const bad = () => usageError('Invalid private evaluation allowance.', 'Use all three space-separated Codex limits, one optional request UUID and an optional positive --aux-max-usd.');

/** Parse before connecting a database; past deadlines are legal only for an existing identical grant. */
export function splitEvalAllowance(args: string[]): { args: string[]; allowance?: EvalAllowance } {
  const rest: string[] = [], values = new Map<string,string>();
  for (let i=0;i<args.length;i++) {
    const arg=args[i]!;
    if (!arg.startsWith('--codex-') && !arg.startsWith('--aux-max-usd')) { rest.push(arg); continue; }
    if (!flags.includes(arg) || values.has(arg) || !args[i+1] || args[i+1]!.startsWith('--')) throw bad();
    values.set(arg,args[++i]!);
  }
  if (!values.size) return { args:rest };
  const attempts=Number(values.get('--codex-max-attempts')), turns=Number(values.get('--codex-max-turns'));
  if (![attempts,turns].every(n=>Number.isSafeInteger(n)&&n>=1&&n<=1000) || turns>attempts) throw bad();
  const raw=values.get('--codex-deadline') ?? '', deadline=new Date(raw);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(raw) || !Number.isFinite(deadline.getTime()) ||
      deadline.toISOString().replace('.000Z','Z')!==raw.replace('.000Z','Z') || deadline.getTime()>Date.now()+86400000) throw bad();
  const requestId=values.get('--codex-request-id') ?? randomUUID();
  if (!isWriteRequestId(requestId)) throw bad();
  const auxiliaryUsd=values.has('--aux-max-usd') ? Number(values.get('--aux-max-usd')) : undefined;
  if (auxiliaryUsd!==undefined && (!Number.isFinite(auxiliaryUsd)||auxiliaryUsd<0.000001||auxiliaryUsd>10000)) throw bad();
  return { args:rest,allowance:{requestId:requestId.toLowerCase(),maxAttempts:attempts,maxTurns:turns,deadline,...auxiliaryUsd!==undefined?{auxiliaryUsd}:{}} };
}
