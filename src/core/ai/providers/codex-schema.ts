import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { CODEX_PROPOSAL_LIMITS, CodexProposalError, isRecord } from './codex-contract.ts';

const keywords = new Set(['type', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'description', 'title', 'anyOf', '$defs', '$ref',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern']);
const types = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);

/** Freeze the actual wire schema, reject unknown semantics, then compile local validation. */
export function prepareCodexSchema(input: unknown): {
  schema: Record<string, unknown>; serialized: string; validate: (value: unknown) => boolean;
} {
  const fail = (): never => { throw new CodexProposalError('unsupported_schema'); };
  let serialized: string;
  let schema: unknown;
  try { serialized = JSON.stringify(input); schema = JSON.parse(serialized); } catch { return fail(); }
  if (Buffer.byteLength(serialized) > CODEX_PROPOSAL_LIMITS.schemaBytes || !isRecord(schema) || schema.type !== 'object') return fail();
  let nodes = 0;
  const visit = (node: unknown, depth: number): void => {
    if (!isRecord(node) || depth > 32 || ++nodes > 2_000 || Object.keys(node).some(k => !keywords.has(k))) fail();
    const s = node as Record<string, unknown>;
    if (s.$ref !== undefined && (typeof s.$ref !== 'string' || !s.$ref.startsWith('#/$defs/'))) fail();
    for (const annotation of ['description', 'title']) if (s[annotation] !== undefined && typeof s[annotation] !== 'string') fail();
    if (s.enum !== undefined && (!Array.isArray(s.enum) || s.enum.length === 0)) fail();
    const declared = Array.isArray(s.type) ? s.type : s.type === undefined ? [] : [s.type];
    if (declared.some(t => typeof t !== 'string' || !types.has(t)) || new Set(declared).size !== declared.length) fail();
    if (!declared.length && s.$ref === undefined && s.anyOf === undefined) fail();
    if (declared.includes('object')) {
      if (!isRecord(s.properties) || s.additionalProperties !== false || !Array.isArray(s.required)) fail();
      const keys = Object.keys(s.properties as object);
      const required = s.required as unknown[];
      if (new Set(required).size !== required.length || keys.length !== required.length ||
        required.some(k => typeof k !== 'string' || !Object.hasOwn(s.properties as object, k))) fail();
      for (const child of Object.values(s.properties as object)) visit(child, depth + 1);
    } else if (s.properties !== undefined || s.required !== undefined || s.additionalProperties !== undefined) fail();
    if (declared.includes('array')) visit(s.items, depth + 1);
    else if (s.items !== undefined) fail();
    if (s.anyOf !== undefined) {
      if (!Array.isArray(s.anyOf) || s.anyOf.length === 0 || depth === 0) fail();
      for (const child of s.anyOf as unknown[]) visit(child, depth + 1);
    }
    if (s.$defs !== undefined) {
      if (!isRecord(s.$defs)) fail();
      for (const child of Object.values(s.$defs as object)) visit(child, depth + 1);
    }
    for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength']) {
      if (s[key] !== undefined && (!Number.isSafeInteger(s[key]) || (s[key] as number) < 0)) fail();
    }
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) {
      if (s[key] !== undefined && (typeof s[key] !== 'number' || !Number.isFinite(s[key]))) fail();
    }
    if (s.multipleOf !== undefined && (s.multipleOf as number) <= 0) fail();
    if (s.pattern !== undefined) {
      if (typeof s.pattern !== 'string' || s.pattern.length > 1_000) fail();
      try { new RegExp(s.pattern as string, 'u'); } catch { fail(); }
    }
  };
  visit(schema, 0);
  try {
    const validator = new AjvJsonSchemaValidator().getValidator(schema);
    return { schema, serialized, validate: value => { try { return validator(value).valid; } catch { return false; } } };
  } catch { return fail(); }
}
