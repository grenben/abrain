import { CodexProposalError } from '../ai/providers/codex-contract.ts';
import { digest } from '../persistence/digest.ts';
import { canonicalTimestamp } from './llm-timestamp.ts';

/** Validate the whole request before the first chunk can consume an attempt. */
export function validatePrivateParserBounds(body: string, sampleLines?: number, date?: string): void {
  const size = sampleLines ?? 100;
  if (Buffer.byteLength(body) > 262144 || !Number.isSafeInteger(size) || size < 1 || size > 1000 ||
    date !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !canonicalTimestamp(`${date}T00:00:00Z`))) throw new CodexProposalError('invalid_input');
  const lines = body.split(/\r?\n/).filter(line => line.trim().length > 0);
  const stride = size - (size >= 10 ? Math.min(20, Math.floor(size / 5)) : 0);
  let count = 0;
  for (let start = 0; start < lines.length; start += stride) {
    if (++count > 16 || Buffer.byteLength(lines.slice(start, start + size).join('\n')) > 65536) throw new CodexProposalError('invalid_input');
    if (start + size >= lines.length) break;
  }
}

/** Bind native JSON to this chunk and preserve verbatim source text. No salvage of bad rows. */
export function privateFallbackContract(body: string, content: string, legacySystem: string, date?: string) {
  const version = 'codex-parser-fallback-v1';
  const evidenceHash = digest({ version, content, system: legacySystem });
  const schema = { type: 'object', additionalProperties: false, required: ['evidence_hash', 'messages'], properties: {
    evidence_hash: { type: 'string', enum: [evidenceHash] },
    messages: { type: 'array', maxItems: 200, items: { type: 'object', additionalProperties: false,
      required: ['speaker', 'timestamp', 'text'], properties: {
        speaker: { type: 'string', minLength: 1, maxLength: 300 },
        timestamp: { type: 'string', minLength: 20, maxLength: 29 },
        text: { type: 'string', minLength: 1, maxLength: 16000 },
      } } },
  } };
  const system = legacySystem.replace('Return a JSON array of message objects.', 'Return an object with evidence_hash and messages (an array of message objects).')
    .replace('return [].', 'return an empty messages array.')
    .replace('Output ONLY the JSON array. No prose, no markdown fences.', 'Output ONLY the schema object. No prose or markdown fences. Copy each message text verbatim from the visible source; do not paraphrase, invent, or join non-contiguous excerpts.');
  return { version, schema, system, parse: (raw: string) => {
    const value = JSON.parse(raw) as { evidence_hash: string; messages: Array<{speaker:string;timestamp:string;text:string}> };
    if (value.evidence_hash !== evidenceHash) throw new CodexProposalError('invalid_output');
    return value.messages.map(message => {
      const speaker = message.speaker.trim(), text = message.text.trim(), timestamp = canonicalTimestamp(message.timestamp);
      if (!speaker || !text || !timestamp || !groundedTimestamp(message.timestamp, body, date) || !body.includes(text) || !body.toLowerCase().includes(speaker.toLowerCase()) ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(speaker + text)) throw new CodexProposalError('invalid_output');
      return { message: { speaker, text, timestamp: timestamp.iso }, epochMs: timestamp.epochMs };
    });
  } };
}

/** Dates come from the chunk or host metadata; visible clock times cannot be invented. */
function groundedTimestamp(value: string, body: string, date?: string): boolean {
  const day = value.slice(0, 10), clock = value.slice(11, 19);
  if (day !== (date ?? '1970-01-01') && !body.includes(day)) return false;
  const times = [...body.matchAll(/\b(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\s*(am|pm)?\b/gi)];
  if (!times.length) return clock === '00:00:00';
  return times.some(match => {
    let hour = Number(match[1]);
    if (match[4]) hour = hour % 12 + (match[4].toLowerCase() === 'pm' ? 12 : 0);
    return clock === `${String(hour).padStart(2, '0')}:${match[2]}:${match[3] ?? '00'}`;
  });
}
