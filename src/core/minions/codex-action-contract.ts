import { PrivateRoutingError } from '../ai/private-policy.ts';
import { prepareCodexSchema } from '../ai/providers/codex-schema.ts';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { matchesSlugAllowList, isOpPageSlug } from '../ops/context.ts';
import { validateSourceId } from '../utils.ts';
import type { ToolDef } from './types.ts';

export const CODEX_READ_PROTOCOL = 'codex-host-read-v1';
export const CODEX_WRITE_PROTOCOL = 'codex-host-actions-v1';
export const CODEX_ACTION_LIMITS = { turns: 16, prompt: 16000, result: 16000, history: 96000, answer: 8000, content: 12000 } as const;
export interface CodexReadJob {
  action_protocol: typeof CODEX_READ_PROTOCOL | typeof CODEX_WRITE_PROTOCOL; prompt: string; source_id: string;
  allowed_tools: string[]; allowed_slug_prefixes: string[]; max_turns: number; no_self_fix: true;
  model?: string; require_writes?: boolean;
}
export type CodexAction = { kind: 'final'; answer: string } | { kind: 'tool'; name: string; arguments: { slug: string; content?: string } };
export const actionError = (code: string): never => { throw new Error(`codex_action_${code}`); };

/** Trusted job payload, immutable under the subscription binding; never inferred from a prompt. */
export function validateCodexReadJob(data: Record<string, unknown>): CodexReadJob {
  const writes = data.action_protocol === CODEX_WRITE_PROTOCOL;
  if (!writes && data.action_protocol !== CODEX_READ_PROTOCOL) throw new PrivateRoutingError('job:subagent', 'private_native_loop_unsupported');
  const fields = ['action_protocol', 'prompt', 'source_id', 'allowed_tools', 'allowed_slug_prefixes', 'max_turns', 'no_self_fix', 'model', '__param_hash', ...(writes ? ['require_writes'] : [])];
  if (Object.keys(data).some(k => !fields.includes(k))) actionError('unsupported_job_field');
  // Queue-owned coalescing metadata is bound with the full payload, never sent as model authority.
  if (data.__param_hash !== undefined && (typeof data.__param_hash !== 'string' || !/^[a-f0-9]{64}$/.test(data.__param_hash))) actionError('invalid_job');
  if (typeof data.prompt !== 'string' || !data.prompt.trim() || Buffer.byteLength(data.prompt) > CODEX_ACTION_LIMITS.prompt ||
      typeof data.source_id !== 'string' || !Number.isSafeInteger(data.max_turns) || Number(data.max_turns) < 1 || Number(data.max_turns) > CODEX_ACTION_LIMITS.turns || data.no_self_fix !== true) actionError('invalid_job');
  validateSourceId(data.source_id as string);
  if (!Array.isArray(data.allowed_tools) || !data.allowed_tools.length || new Set(data.allowed_tools).size !== data.allowed_tools.length ||
      data.allowed_tools.some(t => !['get_page', ...(writes ? ['put_page'] : [])].includes(t))) actionError('unsupported_tools');
  if (writes && (typeof data.require_writes !== 'boolean' || !(data.allowed_tools as string[]).includes('get_page') || !(data.allowed_tools as string[]).includes('put_page'))) actionError('invalid_write_job');
  if (!Array.isArray(data.allowed_slug_prefixes) || !data.allowed_slug_prefixes.length || data.allowed_slug_prefixes.length > 16 ||
      data.allowed_slug_prefixes.some(p => typeof p !== 'string' || !isOpPageSlug(p.endsWith('/*') ? p.slice(0, -2) : p))) actionError('invalid_prefixes');
  return structuredClone(data) as unknown as CodexReadJob;
}

/** Generate native union branches from the authorized operation registry, keeping original validation too. */
export function codexActionSchema(tools: ToolDef[], data: CodexReadJob) {
  const originals = new Map(tools.map(t => [t.name, new AjvJsonSchemaValidator().getValidator(t.input_schema)]));
  const schema = prepareCodexSchema({ type: 'object', additionalProperties: false, required: ['response'], properties: {
    response: { anyOf: [
      { type: 'object', additionalProperties: false, required: ['kind', 'answer'], properties: {
        kind: { type: 'string', const: 'final' }, answer: { type: 'string', minLength: 1, maxLength: CODEX_ACTION_LIMITS.answer } } },
      ...tools.map(t => ({ type: 'object', additionalProperties: false, required: ['kind', 'name', 'arguments'], properties: {
        kind: { type: 'string', const: 'tool' }, name: { type: 'string', const: t.name },
        arguments: { type: 'object', additionalProperties: false, required: t.name === 'brain_put_page' ? ['slug', 'content'] : ['slug'], properties: {
          slug: { ...(t.input_schema.properties as Record<string, object>).slug, minLength: 1, maxLength: 512 },
          ...(t.name === 'brain_put_page' ? { content: { ...(t.input_schema.properties as Record<string, object>).content, minLength: 1, maxLength: CODEX_ACTION_LIMITS.content } } : {}) } } } })),
    ] },
  } });
  const validate = (value: unknown): CodexAction => {
    if (!schema.validate(value)) actionError('invalid_proposal');
    const action = (value as { response: CodexAction }).response;
    if (action.kind === 'final') { if (!action.answer.trim()) actionError('invalid_proposal'); }
    else if (!originals.get(action.name)?.(action.arguments).valid || !isOpPageSlug(action.arguments.slug) || !matchesSlugAllowList(action.arguments.slug, data.allowed_slug_prefixes)) actionError('unauthorized_action');
    if (action.kind === 'tool' && action.arguments.content !== undefined && Buffer.byteLength(action.arguments.content) > CODEX_ACTION_LIMITS.content) actionError('invalid_proposal');
    return action;
  };
  return { schema: schema.schema, validate };
}
