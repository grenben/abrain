import { PrivateRoutingError } from '../ai/private-policy.ts';
import { prepareCodexSchema } from '../ai/providers/codex-schema.ts';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { matchesSlugAllowList, isOpPageSlug } from '../ops/context.ts';
import { validateSourceId } from '../utils.ts';
import type { ToolDef } from './types.ts';
import { semanticJobPayload } from './admission.ts';

export const CODEX_DISCOVERY_REGISTRY = 'codex-discovery-v1';
export const CODEX_READ_PROTOCOL = 'codex-host-read-v1';
export const CODEX_WRITE_PROTOCOL = 'codex-host-actions-v1';
export const CODEX_SKILLOPT_JOB_PROTOCOL = 'codex-skillopt-rollout-v1';
export const CODEX_SKILLOPT_BATCH_JOB_PROTOCOL = 'codex-skillopt-batch-job-v1';
export const CODEX_ACTION_LIMITS = { turns: 16, prompt: 16000, result: 16000, history: 96000, answer: 8000, content: 12000 } as const;
export interface CodexReadJob {
  action_protocol: typeof CODEX_READ_PROTOCOL | typeof CODEX_WRITE_PROTOCOL; prompt: string; source_id: string;
  allowed_tools: string[]; allowed_slug_prefixes: string[]; max_turns: number; no_self_fix: true;
  model?: string; require_writes?: boolean;
  read_registry?: typeof CODEX_DISCOVERY_REGISTRY;
  optimizer_protocol?: typeof CODEX_SKILLOPT_JOB_PROTOCOL;
}
export type CodexAction = { kind: 'final'; answer: string } | { kind: 'tool'; name: string; arguments: { slug?: string; content?: string; query?: string; limit?: number; offset?: number } };
export const actionError = (code: string): never => { throw new Error(`codex_action_${code}`); };

/** Trusted job payload, immutable under the subscription binding; never inferred from a prompt. */
export function validateCodexReadJob(data: Record<string, unknown>): CodexReadJob {
  // Validate embedded queue metadata separately; it is never semantic job
  // input or authority. Queue insertion overwrites client __submitter values.
  if (data.__submitter !== undefined &&
      (typeof data.__submitter !== 'string' || !/^[\x20-\x7e]{1,128}$/.test(data.__submitter))) actionError('invalid_job_metadata');
  // Queue-owned coalescing metadata is bound with the full payload, never sent as model authority.
  if (data.__param_hash !== undefined && (typeof data.__param_hash !== 'string' || !/^[a-f0-9]{64}$/.test(data.__param_hash))) actionError('invalid_job');
  const semantic = semanticJobPayload(data);
  const writes = semantic.action_protocol === CODEX_WRITE_PROTOCOL;
  if (!writes && semantic.action_protocol !== CODEX_READ_PROTOCOL) throw new PrivateRoutingError('job:subagent', 'private_native_loop_unsupported');
  const fields = ['action_protocol', 'prompt', 'source_id', 'allowed_tools', 'allowed_slug_prefixes', 'max_turns', 'no_self_fix', 'model', 'read_registry', ...(writes ? ['require_writes'] : ['optimizer_protocol'])];
  if (Object.keys(semantic).some(k => !fields.includes(k))) actionError('unsupported_job_field');
  if (semantic.optimizer_protocol !== undefined && semantic.optimizer_protocol !== CODEX_SKILLOPT_JOB_PROTOCOL) actionError('unsupported_job_field');
  if (semantic.read_registry !== undefined && semantic.read_registry !== CODEX_DISCOVERY_REGISTRY) actionError('unsupported_read_registry');
  if (typeof semantic.prompt !== 'string' || !semantic.prompt.trim() || Buffer.byteLength(semantic.prompt) > CODEX_ACTION_LIMITS.prompt ||
      typeof semantic.source_id !== 'string' || !Number.isSafeInteger(semantic.max_turns) || Number(semantic.max_turns) < 1 || Number(semantic.max_turns) > CODEX_ACTION_LIMITS.turns || semantic.no_self_fix !== true) actionError('invalid_job');
  validateSourceId(semantic.source_id as string);
  if (!Array.isArray(semantic.allowed_tools) || !semantic.allowed_tools.length || new Set(semantic.allowed_tools).size !== semantic.allowed_tools.length ||
      semantic.allowed_tools.some(t => !['get_page', ...(semantic.read_registry === CODEX_DISCOVERY_REGISTRY ? ['list_pages', 'search'] : []), ...(writes ? ['put_page'] : [])].includes(t))) actionError('unsupported_tools');
  if (writes && (typeof semantic.require_writes !== 'boolean' || !(semantic.allowed_tools as string[]).includes('get_page') || !(semantic.allowed_tools as string[]).includes('put_page'))) actionError('invalid_write_job');
  if (!Array.isArray(semantic.allowed_slug_prefixes) || !semantic.allowed_slug_prefixes.length || semantic.allowed_slug_prefixes.length > 16 ||
      semantic.allowed_slug_prefixes.some(p => typeof p !== 'string' || !isOpPageSlug(p.endsWith('/*') ? p.slice(0, -2) : p))) actionError('invalid_prefixes');
  return structuredClone(semantic) as unknown as CodexReadJob;
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
        arguments: actionArguments(t) } })),
    ] },
  } });
  const validate = (value: unknown): CodexAction => {
    if (!schema.validate(value)) actionError('invalid_proposal');
    const action = (value as { response: CodexAction }).response;
    if (action.kind === 'final') { if (!action.answer.trim()) actionError('invalid_proposal'); }
    else {
      if (!originals.get(action.name)?.(action.arguments).valid) actionError('unauthorized_action');
      if (action.name === 'brain_get_page' || action.name === 'brain_put_page') {
        const slug = action.arguments.slug;
        if (typeof slug !== 'string' || !isOpPageSlug(slug) || !matchesSlugAllowList(slug, data.allowed_slug_prefixes)) actionError('unauthorized_action');
      } else if (data.read_registry !== CODEX_DISCOVERY_REGISTRY || !['brain_search', 'brain_list_pages'].includes(action.name) ||
        action.name === 'brain_search' && !action.arguments.query?.trim()) actionError('unauthorized_action');
    }
    if (action.kind === 'tool' && action.arguments.content !== undefined && Buffer.byteLength(action.arguments.content) > CODEX_ACTION_LIMITS.content) actionError('invalid_proposal');
    return action;
  };
  return { schema: schema.schema, validate };
}

/** Narrow model arguments from the original registry; host authority is never in this schema. */
function actionArguments(t: ToolDef) {
  const original = t.input_schema.properties as Record<string, object>;
  const properties = t.name === 'brain_list_pages' || t.name === 'brain_search'
    ? { ...(t.name === 'brain_search' ? { query: { ...original.query, minLength: 1, maxLength: 2000 } } : {}),
        limit: { ...original.limit, type: 'integer', minimum: 1, maximum: 20 }, offset: { ...original.offset, type: 'integer', minimum: 0, maximum: 1000 } }
    : { slug: { ...original.slug, minLength: 1, maxLength: 512 }, ...(t.name === 'brain_put_page' ? { content: { ...original.content, minLength: 1, maxLength: CODEX_ACTION_LIMITS.content } } : {}) };
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
}
