/**
 * v0.42.11.0 (#1784) — suspected-contradictions budget-default detection.
 *
 * The TTY-derived budget default ($5 TTY / $1 non-TTY) is overwritten in-place,
 * so the banner needs an explicit `budgetUsdExplicit` flag to know whether to
 * annotate the value as the silent non-interactive default. These run non-TTY
 * (bun test pipes stdout), so the default resolves to $1.
 */
import { describe, test, expect } from 'bun:test';
import { parseFlags } from '../src/commands/eval-suspected-contradictions.ts';

describe('parseFlags budgetUsdExplicit', () => {
  test('no --budget-usd → non-TTY default $1, not flagged explicit', () => {
    const f = parseFlags([]);
    expect(f.budgetUsd).toBe(1); // bun test is non-TTY
    expect(f.budgetUsdExplicit).toBe(false);
  });

  test('--budget-usd 3 → value 3, flagged explicit', () => {
    const f = parseFlags(['--budget-usd', '3']);
    expect(f.budgetUsd).toBe(3);
    expect(f.budgetUsdExplicit).toBe(true);
  });

  test('explicit value equal to the default still counts as explicit', () => {
    const f = parseFlags(['--budget-usd', '1']);
    expect(f.budgetUsd).toBe(1);
    expect(f.budgetUsdExplicit).toBe(true);
  });

  test('subcommand positional does not break flag parsing', () => {
    const f = parseFlags(['run', '--budget-usd', '2']);
    expect(f.sub).toBe('run');
    expect(f.budgetUsd).toBe(2);
    expect(f.budgetUsdExplicit).toBe(true);
  });

  test('parses explicit Codex allowance flags', () => {
    const f = parseFlags(['run', '--codex-max-attempts', '3', '--codex-max-turns', '2',
      '--codex-deadline', '2026-11-15T12:00:00Z', '--codex-request-id', '00000000-0000-4000-8000-000000000001',
      '--max-usd', '1.25']);
    expect(f.codex).toEqual({
      maxAttempts: '3', maxTurns: '2', deadline: '2026-11-15T12:00:00Z',
      requestId: '00000000-0000-4000-8000-000000000001', maxUsd: '1.25',
    });
  });

  test('rejects duplicate Codex allowance flags', () => {
    expect(() => parseFlags(['--codex-max-attempts', '2', '--codex-max-attempts', '3']))
      .toThrow('--codex-max-attempts must occur once');
  });
});
