import { describe, expect, spyOn, test } from 'bun:test';
import { validateInitFlags, type ManagedInitFlagSelection } from '../src/commands/init-flags.ts';

const fingerprint = 'a'.repeat(64);
function invalid(args: string[]): void {
  const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
  const error = spyOn(console, 'error').mockImplementation(() => {});
  try { expect(() => validateInitFlags(args, {})).toThrow('exit:1'); }
  finally { exit.mockRestore(); error.mockRestore(); }
}
describe('managed init lane flags', () => {
  test('returns the selected lane and sanitized package-consent fields', () => {
    const basic = validateInitFlags(['--managed-postgres'], {}) as ManagedInitFlagSelection;
    expect(basic).toEqual({ lane: 'managed-postgres', yes: false, nonInteractive: false, json: false,
      noEmbedding: false, dbOnly: false, consent: { installPackages: false } });
    const configured = validateInitFlags([
      '--managed-postgres', '--yes', '--non-interactive', '--json', '--no-embedding', '--db-only',
      '--install-packages', '--package-plan-fingerprint', fingerprint,
    ], {}) as ManagedInitFlagSelection;
    expect(configured).toEqual({ lane: 'managed-postgres', yes: true, nonInteractive: true, json: true,
      noEmbedding: true, dbOnly: true, consent: { installPackages: true, packagePlanFingerprint: fingerprint } });
    expect((validateInitFlags(['--managed-postgres', '--install-packages', '--package-plan-fingerprint', fingerprint], {}) as ManagedInitFlagSelection).yes).toBe(false);
  });

  test('json and non-interactive require explicit cluster consent', () => {
    invalid(['--managed-postgres', '--json']);
    invalid(['--managed-postgres', '--non-interactive']);
    expect((validateInitFlags(['--managed-postgres', '--yes', '--json'], {}) as ManagedInitFlagSelection).yes).toBe(true);
    expect((validateInitFlags(['--managed-postgres', '--yes', '--non-interactive'], {}) as ManagedInitFlagSelection).nonInteractive).toBe(true);
  });

  test('rejects managed conflicts, unknown flags and positionals without reflecting inputs', () => {
    const conflicts = [
      ['--pglite'], ['--supabase'], ['--mcp-only'], ['--force'], ['--migrate-only'], ['--skip-embed-check'],
      ['--git'], ['--no-git'], ['--prefer-postgres'], ['--allow-docker'], ['--allow-create-db'], ['--local-postgres'],
      ['--url', 'postgresql://user:SECRET@host.invalid/db'], ['--key', 'SECRET'], ['--path', '/private/path'],
      ['--content-root', '/private/content'], ['--schema-pack', 'private'], ['--embedding-model', 'provider:model'],
      ['--model', 'provider:model'], ['--embedding-dimensions', '1536'], ['--expansion-model', 'provider:model'],
      ['--chat-model', 'provider:model'], ['--mcp-url', 'https://private.invalid'], ['--issuer-url', 'https://private.invalid'],
      ['--oauth-client-id', 'client'], ['--oauth-client-secret', 'SECRET'], ['--unknown-flag'], ['private-positional'],
    ];
    for (const conflict of conflicts) invalid(['--managed-postgres', ...conflict]);
    const json = spyOn(console, 'log').mockImplementation(() => {});
    const error = spyOn(console, 'error').mockImplementation(() => {});
    const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
    expect(() => validateInitFlags(['--managed-postgres', '--json', '--url', 'SECRET'], {})).toThrow('exit:1');
    expect(json.mock.calls.flat().join('')).not.toContain('SECRET');
    json.mockRestore(); error.mockRestore(); exit.mockRestore();
  });

  test('rejects repeated selectors and value options, missing or extra values, and malformed consent', () => {
    for (const args of [
      ['--managed-postgres', '--managed-postgres'],
      ['--managed-postgres', '--package-plan-fingerprint', fingerprint],
      ['--managed-postgres', '--install-packages'],
      ['--managed-postgres', '--install-packages', '--package-plan-fingerprint'],
      ['--managed-postgres', '--install-packages', '--package-plan-fingerprint', 'A'.repeat(64)],
      ['--managed-postgres', '--install-packages', '--package-plan-fingerprint', 'a'.repeat(63)],
      ['--managed-postgres', '--install-packages', '--package-plan-fingerprint', 'a'.repeat(65)],
      ['--managed-postgres', '--install-packages', '--package-plan-fingerprint', fingerprint, '--package-plan-fingerprint', fingerprint],
      ['--managed-postgres', '--package-plan-fingerprint', fingerprint, 'extra'],
      ['--managed-postgres', '--package-plan-fingerprint', '--json'],
      ['--managed-postgres', '--json', '--json'],
    ]) invalid(args);
  });

  test('ordinary package consent and generic yes remain rejected; help and migrate-only stay pure', () => {
    for (const args of [
      ['--install-packages'], ['--package-plan-fingerprint', fingerprint], ['--yes'],
    ]) invalid(args);
    expect(validateInitFlags(['--help', '--managed-postgres', '--unknown'])).toBe('regular');
    expect(validateInitFlags(['--migrate-only'], {})).toBe('migrate-only');
    expect(validateInitFlags(['--migrate-only', '--json'], {})).toBe('migrate-only');
    expect(validateInitFlags(['--force', '--pglite', '--no-embedding'], {})).toBe('regular');
    expect(validateInitFlags([
      '--mcp-only', '--json', '--issuer-url', 'https://issuer.invalid', '--mcp-url', 'https://host.invalid/mcp',
      '--oauth-client-id', 'client', '--oauth-client-secret', 'secret', '--force',
    ], {})).toBe('regular');
    invalid(['--migrate-only', '--managed-postgres']);
  });
});
