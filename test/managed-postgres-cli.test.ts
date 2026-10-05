/**
 * Protects observable safety and exit contracts of `gbrain postgres` before any engine is connected.
 * Credible regressions: package consent inferred from --yes, status verdict drift, secret leakage,
 * or command routing through engine/MCP dispatch. Existing core tests do not cover CLI parsing/output.
 * Narrow injected core functions avoid Homebrew and database access; no production global seam is used.
 */
import { afterEach, describe, expect, test, mock } from 'bun:test';
import { runManagedPostgresCli, POSTGRES_HELP, type ManagedPostgresCliDependencies } from '../src/cli/commands/postgres.ts';
import { findCliCommand } from '../src/cli/command-table.ts';
import { operations } from '../src/core/operations.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';

const fingerprint = 'a'.repeat(64);
const initialExitCode = process.exitCode;
const target = { host: '127.0.0.1' as const, port: 55432, database: 'gbrain', role: 'gbrain', socketPath: '/private/socket', controller: 'manual' as const };
const classifications = ['absent', 'packages_missing', 'packages_incompatible', 'allocated', 'partial', 'ownership_unknown', 'stopped', 'port_collision', 'startup_failure', 'auth_failure', 'wrong_server', 'missing_extension', 'schema_incomplete', 'ready'] as const;
function dependencies(overrides: Partial<ManagedPostgresCliDependencies> = {}): ManagedPostgresCliDependencies {
  return {
    planProvision: async () => ({ ready: false, root: '/tmp/gbrain', packages: { missing: ['postgresql@17'], incompatible: [], ready: false, brew: null, prefix: null, formulaPrefix: null, formulaVersion: null, pgvectorPrefix: null, pgvectorVersion: null, sharedir: null, pkglibdir: null, binaries: {}, installArgv: [], }, installPackages: true, packageImpact: { known: true, fingerprint, formulaInstalls: ['postgresql@17'], dependencyInstalls: ['krb5'], upgrades: ['openssl@3'], reinstalls: [], lines: ['Install formula postgresql@17', 'Upgrade dependency openssl@3'] }, packagePlanFingerprint: fingerprint, commands: [] }),
    provision: async () => target,
    status: async () => ({ classification: 'ready', target }),
    start: async () => ({ classification: 'ready', target }),
    stop: async () => ({ classification: 'stopped', target }),
    ...overrides,
  };
}
async function capture(args: string[], deps = dependencies(), context: { signal?: AbortSignal } = {}, afterStart?: (before: Function[]) => Promise<void> | void) {
  const stdout: string[] = [], stderr: string[] = [];
  const sigintBefore = process.listeners('SIGINT');
  const out = mock((...values: unknown[]) => { stdout.push(values.join(' ')); });
  const err = mock((...values: unknown[]) => { stderr.push(values.join(' ')); });
  const oldOut = console.log, oldErr = console.error;
  console.log = out; console.error = err;
  try {
    const pending = runManagedPostgresCli(args, deps, context as Parameters<typeof runManagedPostgresCli>[2]);
    await afterStart?.(sigintBefore);
    const code = await pending;
    return { code, stdout, stderr };
  } finally {
    expect(process.listeners('SIGINT')).toEqual(sigintBefore);
    console.log = oldOut; console.error = oldErr;
  }
}

describe('managed postgres CLI', () => {
  afterEach(() => { mock.restore(); _resetCliExitVerdictForTests(); process.exitCode = initialExitCode; });

  test('command is engine-free, thin-client none, self-help, discoverable and absent from operations', async () => {
    const command = findCliCommand('postgres');
    expect(command).toMatchObject({ phase: 'pre-connect', thinClient: 'none', selfHelp: true });
    expect(command?.load.toString()).toContain('./commands/postgres.ts');
    expect(operations.some(operation => operation.name === 'postgres')).toBe(false);
    // The command runner has no engine context and injected functions are the only invoked APIs.
    const plan = mock(async () => ({ ready: true, root: '/tmp/gbrain', packages: { missing: [], incompatible: [], ready: true, brew: null, prefix: null, formulaPrefix: null, formulaVersion: null, pgvectorPrefix: null, pgvectorVersion: null, sharedir: null, pkglibdir: null, binaries: {}, installArgv: [] }, installPackages: false, commands: [] }));
    expect((await capture(['plan'], dependencies({ planProvision: plan }))).code).toBe(0);
    expect(plan).toHaveBeenCalledTimes(1);
  });

  test('plan does not provision/install, discloses possible Homebrew cache activity, and reports impact/fingerprint', async () => {
    const provision = mock(async () => target);
    const result = await capture(['plan', '--json'], dependencies({ provision }));
    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(1);
    const parsed = JSON.parse(result.stdout[0]!);
    expect(parsed.plan.packageImpact.upgrades).toEqual(['openssl@3']);
    expect(parsed.plan.packagePlanFingerprint).toBe(fingerprint);
    expect(result.stdout.join()).not.toContain('password');
    expect(provision).not.toHaveBeenCalled();
    const human = await capture(['plan']);
    expect(human.stdout.join('\n')).toContain('No formula was installed, no service/database was started, and no managed cluster was created.');
    expect(human.stdout.join('\n')).toContain('Homebrew may have fetched metadata/manifests and populated its cache');
    expect(human.stdout.join('\n')).toContain('auto-update disabled; no cleanup performed');
  });

  test('provision requires --yes and package consent is exact and all-or-none', async () => {
    const provision = mock(async (_context?: unknown, _consent?: unknown) => target);
    for (const args of [['provision'], ['provision', '--yes', '--install-packages'], ['provision', '--yes', '--package-plan-fingerprint', fingerprint]]) {
      expect((await capture(args, dependencies({ provision }))).code).toBe(1);
    }
    expect(provision).not.toHaveBeenCalled();
    expect((await capture(['provision', '--yes', '--install-packages', '--package-plan-fingerprint', `${fingerprint.slice(0, 63)}A`], dependencies({ provision }))).code).toBe(1);
    expect(provision).not.toHaveBeenCalled();
    expect((await capture(['provision', '--yes'], dependencies({ provision }))).code).toBe(0);
    expect(provision.mock.calls.at(-1)?.[1]).toEqual({});
    expect((await capture(['provision', '--yes', '--install-packages', '--package-plan-fingerprint', fingerprint], dependencies({ provision }))).code).toBe(0);
    expect(provision.mock.calls.at(-1)?.[1]).toEqual({ installPackages: true, packagePlanFingerprint: fingerprint });
  });

  test('JSON output is one secret-free object and human output names the target', async () => {
    const json = await capture(['provision', '--yes', '--json']);
    expect(json.stdout).toHaveLength(1);
    expect(JSON.parse(json.stdout[0]!).target).toEqual(target);
    expect(json.stdout[0]).not.toContain('secret');
    const human = await capture(['provision', '--yes']);
    expect(human.stdout[0]).toContain('127.0.0.1:55432/gbrain');
    expect(human.stdout[0]).not.toContain('password');
  });

  test('status probe is successful only for ready; informational status is always successful', async () => {
    for (const classification of classifications) {
      const deps = dependencies({ status: async () => ({ classification, target }) });
      expect((await capture(['status'], deps)).code).toBe(0);
      const result = await capture(['status', '--probe', '--json'], deps);
      expect(result.code).toBe(classification === 'ready' ? 0 : 1);
      expect(result.stdout).toHaveLength(1);
      expect(JSON.parse(result.stdout[0]!).classification).toBe(classification);
    }
  });

  test('start succeeds only ready and stop succeeds only stopped for every classification', async () => {
    for (const classification of classifications) {
      expect((await capture(['start'], dependencies({ start: async () => ({ classification, target }) }))).code).toBe(classification === 'ready' ? 0 : 1);
      expect((await capture(['stop'], dependencies({ stop: async () => ({ classification, target }) }))).code).toBe(classification === 'stopped' ? 0 : 1);
    }
  });

  test('help, unknown commands, unknown flags and missing values are actionable', async () => {
    const help = await capture(['--help']);
    expect(help.stdout[0]).toBe(POSTGRES_HELP);
    expect(help.stdout[0]).toContain('Homebrew may fetch metadata/manifests and cache them');
    expect(help.stdout[0]).toContain('HOMEBREW_NO_AUTO_UPDATE=1');
    for (const args of [['unknown'], ['plan', '--wat'], ['plan', '--package-plan-fingerprint'], ['provision', '--yes', '--package-plan-fingerprint', 'bad']]) {
      const result = await capture([...args, '--json']);
      expect(result.code).toBe(1);
      expect(result.stdout).toHaveLength(1);
      const report = JSON.parse(result.stdout[0]!);
      expect(report.status).toBe('error');
      expect(result.stderr).toHaveLength(1);
    }
    expect(JSON.parse((await capture(['provision', '--json'])).stdout[0]!).message).toContain('requires --yes');
    expect(JSON.parse((await capture(['plan', '--invalid', '--json'])).stdout[0]!).message).toContain('Unknown flag');
  });

  test('unexpected core errors are generic in human and JSON output', async () => {
    const hostile = 'postgres://db-user:DB_PASSWORD_SECRET@db.example.invalid:5432/gbrain\nraw-password-token\nInjected log line';
    const deps = dependencies({ planProvision: async () => { throw new Error(hostile); } });
    for (const args of [['plan'], ['plan', '--json']]) {
      const result = await capture(args, deps);
      expect(result.code).toBe(1);
      const output = `${result.stdout.join('\n')}\n${result.stderr.join('\n')}`;
      expect(output).not.toContain('DB_PASSWORD_SECRET');
      expect(output).not.toContain('raw-password-token');
      expect(output).not.toContain('Injected log line');
      expect(output).not.toContain('postgres://');
      if (args.includes('--json')) {
        expect(result.stdout).toHaveLength(1);
        expect(JSON.parse(result.stdout[0]!)).toEqual({ status: 'error', reason: 'operation_failed', message: 'Managed PostgreSQL operation failed; sensitive diagnostics were suppressed.' });
      } else {
        expect(result.stdout).toEqual([]);
        expect(result.stderr).toEqual(['[postgres] Managed PostgreSQL operation failed; sensitive diagnostics were suppressed.']);
      }
    }
  });

  test('every action receives a composed abort signal and releases SIGINT listeners', async () => {
    const caller = new AbortController();
    const received: AbortSignal[] = [];
    const observe = async (context?: unknown) => {
      const signal = (context as { signal?: AbortSignal } | undefined)?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal).not.toBe(caller.signal);
      received.push(signal!);
    };
    const deps = dependencies({
      planProvision: async context => { await observe(context); return (await dependencies().planProvision()); },
      provision: async context => { await observe(context); return target; },
      status: async context => { await observe(context); return { classification: 'ready', target }; },
      start: async context => { await observe(context); return { classification: 'ready', target }; },
      stop: async context => { await observe(context); return { classification: 'stopped', target }; },
    });
    for (const args of [['plan'], ['provision', '--yes'], ['status'], ['start'], ['stop']]) {
      expect((await capture(args, deps, { signal: caller.signal })).code).toBe(0);
    }
    expect(received).toHaveLength(5);
    expect(received.every(signal => !signal.aborted)).toBe(true);
  });

  test('SIGINT aborts a pending action and emits one secret-free cancellation object', async () => {
    let actionSignal: AbortSignal | undefined;
    const deps = dependencies({ planProvision: async context => {
      actionSignal = (context as { signal?: AbortSignal } | undefined)?.signal;
      return new Promise((_resolve, reject) => actionSignal!.addEventListener('abort', () => {
        const error = new Error('postgres://user:SECRET@host/db\nraw-password-token');
        error.name = 'ProcessCancelledError';
        reject(error);
      }, { once: true }));
    } });
    const result = await capture(['plan', '--json'], deps, {}, before => {
      const added = process.listeners('SIGINT').filter(listener => !before.includes(listener));
      expect(added).toHaveLength(1);
      (added[0] as () => void)();
    });
    expect(actionSignal?.aborted).toBe(true);
    expect(result.code).toBe(1);
    expect(result.stdout).toHaveLength(1);
    expect(JSON.parse(result.stdout[0]!)).toEqual({ status: 'error', reason: 'cancelled', message: 'Managed PostgreSQL operation cancelled.' });
    expect(`${result.stdout.join()}\n${result.stderr.join()}`).not.toContain('SECRET');
    expect(`${result.stdout.join()}\n${result.stderr.join()}`).not.toContain('raw-password-token');
  });

  test('an externally pre-aborted context refuses to invoke the action', async () => {
    const controller = new AbortController(); controller.abort();
    const plan = mock(async () => ({ ready: true, root: '/tmp/gbrain', packages: { missing: [], incompatible: [], ready: true, brew: null, prefix: null, formulaPrefix: null, formulaVersion: null, pgvectorPrefix: null, pgvectorVersion: null, sharedir: null, pkglibdir: null, binaries: {}, installArgv: [] }, installPackages: false, commands: [] }));
    const result = await capture(['plan', '--json'], dependencies({ planProvision: plan }), { signal: controller.signal });
    expect(plan).not.toHaveBeenCalled();
    expect(result.code).toBe(1);
    expect(result.stdout).toHaveLength(1);
    expect(JSON.parse(result.stdout[0]!).reason).toBe('cancelled');
  });
});
