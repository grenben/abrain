import type { ChatOpts } from '../ai/gateway.ts';
import { readPrivateCodexConfig, PrivateRoutingError, assertPrivateRoute } from '../ai/private-policy.ts';
import { codexSubscriptionContext } from '../ai/subscription-context.ts';
import { SubscriptionAdmissionError } from '../ai/subscription-admission.ts';
import { CodexProposalError } from '../ai/providers/codex-contract.ts';
import { ATOMS_RESPONSE_SCHEMA } from './extract-atoms-schema.ts';
import { locateQuote } from './extract-atoms-grounding.ts';

export function privateAtomsFailure(error: unknown): boolean {
  return error instanceof CodexProposalError || error instanceof SubscriptionAdmissionError || error instanceof PrivateRoutingError;
}

export function privateAtomsAdmission(model: string): boolean {
  if (!model.startsWith('codex-cli:')) return false;
  const policy = readPrivateCodexConfig();
  assertPrivateRoute(model, 'extract_atoms.model', policy);
  if (!policy || !codexSubscriptionContext()) throw new SubscriptionAdmissionError('subscription_required');
  return true;
}

/** Full-batch semantics are checked before accepted-turn accounting or publication. */
export function codexAtomsResponseSchema(source: string): NonNullable<ChatOpts['responseSchema']> {
  if (!readPrivateCodexConfig()) return ATOMS_RESPONSE_SCHEMA;
  const base = ATOMS_RESPONSE_SCHEMA.schema.properties.atoms.items;
  const schema = { ...ATOMS_RESPONSE_SCHEMA.schema, properties: { atoms: {
    type: 'array', maxItems: 20, items: { ...base, properties: {
      ...base.properties,
      title: { type: 'string', minLength: 1, maxLength: 200 },
      body: { type: 'string', minLength: 1, maxLength: 8000 },
      source_quote: { type: ['string', 'null'], minLength: 1, maxLength: 2000 },
      lesson: { type: ['string', 'null'], maxLength: 2000 },
      concepts: { type: ['array', 'null'], maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 200 } },
      virality_score: { type: ['number', 'null'], minimum: 0, maximum: 100 },
      emotional_register: { type: ['string', 'null'], maxLength: 200 },
    } },
  } } };
  return { name: 'codex_atoms_v1', schema, validateCodexProposal: text => {
    const value = JSON.parse(text) as { atoms: Array<{ title: string; body: string; atom_type: string; source_quote: string | null; concepts: string[] | null }> };
    const titles = new Set<string>();
    for (const atom of value.atoms) {
      const title = atom.title.trim().toLowerCase();
      if (!title || !atom.body.trim() || titles.has(title) ||
        atom.atom_type === 'quote' && !atom.source_quote ||
        atom.source_quote !== null && !locateQuote(source, atom.source_quote) ||
        atom.concepts?.some(c => !c.trim()) || atom.concepts && new Set(atom.concepts).size !== atom.concepts.length) {
        throw new CodexProposalError('invalid_output');
      }
      titles.add(title);
    }
  } };
}
