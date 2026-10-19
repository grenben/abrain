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
});

describe('private Codex allowance flags', () => {
  test('parses a separate subscription allowance and auxiliary USD cap', () => {
    expect(parseFlags(['run', '--query', 'Acme revenue', '--codex-max-attempts', '3',
      '--codex-max-turns', '2', '--codex-deadline', '2026-10-20T10:00:00Z', '--max-usd', '1']).codex)
      .toEqual({ maxAttempts: '3', maxTurns: '2', deadline: '2026-10-20T10:00:00Z', maxUsd: '1' });
  });
  test('rejects duplicate allowances and read-only subcommand allowances', () => {
    expect(() => parseFlags(['--codex-max-turns', '2', '--codex-max-turns', '3'])).toThrow();
    expect(() => parseFlags(['trend', '--codex-max-turns', '2'])).toThrow();
  });
});
