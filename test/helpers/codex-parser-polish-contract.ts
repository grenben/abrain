/** Protects the real opt-in scan caller, immutable evidence and native failure/cache behavior.
 * Reverting CLI wiring fails the preview assertions; existing fallback tests never exercise polish.
 * Uses only the existing fake executable fixture and production entrypoints. */
import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { configPath } from '../../src/core/config-path.ts';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { validateCommandFlags } from '../../src/cli/main.ts';
import { runConversationParser } from '../../src/commands/conversation-parser.ts';
import { polishConversation } from '../../src/core/conversation-parser/llm-polish.ts';
import type { ParseResult } from '../../src/core/conversation-parser/types.ts';

interface Fixture {
  engine(): BrainEngine; sourceId: string;
  run<T>(fn: (id: string) => Promise<T>, hooks?: {}, maxAttempts?: number): Promise<T>;
  reply(value: unknown): void; calls(): unknown[];
}
export function codexParserPolishContract(f: Fixture) {
  describe('native presentation-only parser polish', () => {
    beforeEach(async () => { await f.engine().executeRaw('DELETE FROM conversation_parser_llm_cache'); });
    const parsed: ParseResult = { phase: 'regex_match', matched_pattern_id: 'synthetic', messages: [
      { speaker: 'Aster', timestamp: '2026-06-02T10:00:00Z', text: 'Orbit  launched. The quote was "keep  this".' },
    ] };
    const presentation = [{ message_index: 0, prose: 'Orbit launched.\nThe quote was "keep  this".' }];
    const polish = (input: ParseResult = parsed, enabled = true, signal?: AbortSignal) => polishConversation({
      enabled, parsed: input, engine: f.engine(), model: 'codex-cli:gpt-test', signal,
    });
    test('disabled and empty calls need no model or allowance and preserve evidence', async () => {
      const count = f.calls().length;
      expect(await polish(parsed, false)).toEqual({ parsed, presentation: [] });
      expect(await polish({ phase: 'no_match', messages: [] })).toEqual({ parsed: { phase: 'no_match', messages: [] }, presentation: [] });
      expect(f.calls().length).toBe(count);
    });
    test('formatting keeps exact canonical evidence and revalidates cached presentation', async () => {
      f.reply({ presentation }); const count = f.calls().length;
      await f.run(async id => {
        const first = await polish();
        expect(first).toEqual({ parsed, presentation });
        expect(first.parsed).not.toBe(parsed);
        expect(await polish()).toEqual(first);
        const [row] = await f.engine().executeRaw<{ accepted_turns: number }>('SELECT accepted_turns FROM codex_subscription_runs WHERE run_id=$1', [id]);
        expect(Number(row!.accepted_turns)).toBe(1);
      });
      expect(f.calls().length - count).toBe(1);
    });
    test.each([
      { presentation: [{ message_index: 0, prose: 'Orbit failed. The quote was "keep  this".' }] },
      { presentation: [{ message_index: 0, prose: 'Orbit launched. The quote was "keep this".' }] },
      { presentation: [{ message_index: 0, prose: presentation[0]!.prose, speaker: 'forged' }] },
      { presentation: [] }, { raw: 'malformed' }, { refusal: true }, { missingCompletion: true },
    ])('rejects changed evidence, identity fields and provider failures', async value => {
      f.reply(value);
      await f.run(async id => {
        await expect(polish()).rejects.toMatchObject({ reason: 'refusal' in value ? 'refusal' : 'missingCompletion' in value ? 'missing_completion' : 'invalid_output' });
        const [row] = await f.engine().executeRaw<{ accepted_turns: number }>('SELECT accepted_turns FROM codex_subscription_runs WHERE run_id=$1', [id]);
        expect(Number(row!.accepted_turns)).toBe(0);
        expect(parsed.messages[0]!.speaker).toBe('Aster');
      });
    });
    test('aborted cached reads and exhausted fresh calls fail without a second attempt', async () => {
      f.reply({ presentation });
      await expect(polish(parsed, true, AbortSignal.abort())).rejects.toThrow();
      await f.run(async () => {
        const input = structuredClone(parsed); input.messages[0]!.timestamp = '2027-06-02T10:00:00Z';
        await polish(input);
        input.messages[0]!.timestamp = '2026-06-03T10:00:00Z';
        await expect(polish(input)).rejects.toMatchObject({ code: 'subscription_exhausted' });
      }, {}, 1);
    });
    test('actual scan is deterministic unless explicitly opted in and displays separate prose', async () => {
      const slug = `conversations/polish-${randomUUID()}`;
      await f.engine().putPage(slug, { type: 'conversation', title: 'Synthetic preview', compiled_truth: '**Aster:** Orbit  launched.', frontmatter: { date: '2026-06-02' } }, { sourceId: f.sourceId });
      const writes: string[] = [], out = spyOn(process.stdout, 'write').mockImplementation((chunk: any) => { writes.push(String(chunk)); return true; });
      const count = f.calls().length;
      try {
        await runConversationParser(f.engine(), ['scan', slug, '--json']);
        expect(f.calls().length).toBe(count);
        expect(JSON.parse(writes.join('')).presentation).toBeUndefined(); writes.length = 0;
        f.reply({ presentation: [{ message_index: 0, prose: 'Orbit launched.' }] });
        await f.run(() => runConversationParser(f.engine(), ['scan', slug, '--polish', '--json']));
        const result = JSON.parse(writes.join(''));
        expect(result.first_3_messages[0].text_preview).toBe('Orbit  launched.');
        expect(result.presentation).toEqual([{ message_index: 0, prose: 'Orbit launched.' }]);
      } finally { out.mockRestore(); }
      expect((await f.engine().getPage(slug, { sourceId: f.sourceId }))!.compiled_truth).toBe('**Aster:** Orbit  launched.');
    });
    test('a revoked polish role cannot use cached presentation, including revocation during authority checks', async () => {
      const path = configPath(), saved = readFileSync(path, 'utf8');
      const revoke = () => { const value = JSON.parse(saved); value.private_codex.enabled_roles = value.private_codex.enabled_roles.filter((role: string) => role !== 'parser-polish'); writeFileSync(path, JSON.stringify(value)); };
      f.reply({ presentation }); await f.run(() => polish()); const count = f.calls().length;
      try {
        revoke(); await expect(polish()).rejects.toMatchObject({ code: 'private_role_disabled' });
        writeFileSync(path, saved);
        let checks = 0;
        // Revoke at the final cache-return fence; an earlier revocation would be
        // caught by the next pre-check even without the post-await recheck.
        await f.run(async () => { await expect(polish()).rejects.toMatchObject({ reason: 'invalid_input' }); }, { checkAuthority: async () => { if (++checks === 2) revoke(); } });
        expect(f.calls().length).toBe(count);
      } finally { writeFileSync(path, saved); }
    });
    test('foreground CLI allowance binds request to original evidence and cannot be repurposed', async () => {
      const slug = `conversations/polish-local-${randomUUID()}`;
      await f.engine().putPage(slug, { type: 'conversation', title: 'Synthetic local preview', compiled_truth: '**Aster:** Orbit   launched.', frontmatter: { date: '2026-06-02' } }, { sourceId: f.sourceId });
      const args = ['scan', slug, '--json', '--polish', '--codex-request-id', randomUUID(), '--codex-max-attempts', '1', '--codex-max-turns', '1', '--codex-deadline', new Date(Date.now() + 600000).toISOString()];
      expect(validateCommandFlags('conversation-parser', args)).toBeNull();
      f.reply({ presentation: [{ message_index: 0, prose: 'Orbit launched.' }] });
      const out = spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        await runConversationParser(f.engine(), args);
        const count = f.calls().length;
        await runConversationParser(f.engine(), args);
        expect(f.calls().length).toBe(count);
        await f.engine().putPage(slug, { type: 'conversation', title: 'Changed', compiled_truth: '**Aster:** Changed evidence.' }, { sourceId: f.sourceId });
        await expect(runConversationParser(f.engine(), args)).rejects.toMatchObject({ code: 'subscription_identity_conflict' });
        expect(f.calls().length).toBe(count);
      } finally { out.mockRestore(); }
    });
  });
}
