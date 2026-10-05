import { describe, expect, test } from 'bun:test';
import { ConfigPublicationCommittedCleanupError, ConfigPublicationUncertainError } from '../src/core/config-publication.ts';
import {
  createManagedInitCancellationScope,
  runManagedInitCoordinator,
  type ManagedInitCoordinatorDependencies,
  type ManagedInitEngine,
  type ManagedInitOutcome,
} from '../src/commands/init-managed-postgres.ts';
import type { ManagedInitFlagSelection } from '../src/commands/init-flags.ts';
import type { ManagedPostgresReference } from '../src/core/types.ts';
import type { ManagedInitCommandEligibility } from '../src/core/managed-postgres/init-preflight-observer.ts';
import type { ManagedInitPreflightResult } from '../src/core/managed-postgres/init-preflight.ts';
import type { ProvisionPlan } from '../src/core/managed-postgres.ts';
import type { SchemaDiagnosticContext } from '../src/core/schema-diagnostics.ts';
import { verifySchema, parseExpectedColumns } from '../src/core/schema-verify.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PassThrough } from 'node:stream';
import { getEventListeners } from 'node:events';
import { promptYesNo } from '../src/core/confirm-prompt.ts';
import { ProcessTerminationUnconfirmedError } from '../src/core/managed-postgres/process.ts';

const reference: ManagedPostgresReference = { manager_id: 'gbrain-managed-postgres', cluster_id: '01234567-89ab-cdef-0123-456789abcdef' };
const fingerprint = 'a'.repeat(64);
const readyPlan = (): ProvisionPlan => ({
  ready: true, root: '/private/path/that-must-not-escape', installPackages: false,
  packages: { ready: true, missing: [], incompatible: [], brew: '/hidden', prefix: '/hidden', formulaPrefix: '/hidden', formulaVersion: '17', pgvectorPrefix: '/hidden', pgvectorVersion: '0.8', sharedir: '/hidden', pkglibdir: '/hidden', binaries: {}, installArgv: [] },
  commands: [],
});
const installPlan = (): ProvisionPlan => ({
  ...readyPlan(), ready: false, installPackages: true, packagePlanFingerprint: fingerprint,
  packages: { ...readyPlan().packages, ready: false, missing: ['postgresql@17'] },
  packageImpact: { known: true, fingerprint, formulaInstalls: ['postgresql@17'], dependencyInstalls: ['private-name'], upgrades: [], reinstalls: [], lines: ['private command output'] },
});
function selection(overrides: Partial<ManagedInitFlagSelection> = {}): ManagedInitFlagSelection {
  return { lane: 'managed-postgres', yes: true, nonInteractive: true, json: true, noEmbedding: true, dbOnly: true, consent: { installPackages: false }, ...overrides };
}
function resume(kind: 'owned-resume' | 'published-resume'): ManagedInitPreflightResult {
  return { kind, phase: 'provisioned', evidence: 'structural-only', reference };
}
function command(kind: 'unpublished' | 'published'): ManagedInitCommandEligibility {
  return kind === 'published' ? { kind, reference } : { kind };
}

function fixture(options: {
  initial?: ManagedInitPreflightResult;
  latest?: ManagedInitCommandEligibility;
  state?: 'fresh' | 'owned-resume';
  plan?: ProvisionPlan;
  promptAnswer?: boolean;
  acceptedEnv?: boolean;
  directOverride?: boolean;
  failure?: 'create' | 'connect' | 'profile' | 'schema' | 'publish' | 'uncertain' | 'committed-cleanup' | 'disconnect' | 'termination';
  disconnectFailure?: boolean;
  disconnectTermination?: boolean;
  promptFailure?: 'cluster' | 'package';
  schemaGate?: { promise: Promise<void>; finish(): void };
  abortAt?: 'preflight' | 'confirm' | 'plan' | 'beforeMutation' | 'create' | 'connect' | 'profile' | 'schema' | 'publish' | 'disconnect';
  lifecycleReference?: ManagedPostgresReference;
  schemaHook?: (context?: SchemaDiagnosticContext) => Promise<void>;
} = {}) {
  const events: string[] = [];
  const controller = new AbortController();
  const activeReference = options.lifecycleReference ?? (options.latest?.kind === 'published' ? options.latest.reference : reference);
  const engine: ManagedInitEngine = {
    async connect() { events.push('connect'); if (options.abortAt === 'connect') controller.abort(); if (options.failure === 'termination') throw new ProcessTerminationUnconfirmedError(); if (options.failure === 'connect') throw new Error('postgresql://SECRET/socket=/private/uuid'); },
    async initSchema(context) { events.push('schema'); await options.schemaHook?.(context); if (options.schemaGate) await options.schemaGate.promise; if (options.abortAt === 'schema') controller.abort(); if (options.failure === 'schema') throw new Error('password=SECRET uuid=01234567'); },
    async disconnect() { events.push('disconnect'); if (options.abortAt === 'disconnect') controller.abort(); if (options.disconnectTermination) throw new ProcessTerminationUnconfirmedError(); if (options.failure === 'disconnect' || options.disconnectFailure) throw new Error('secret cleanup path'); },
  };
  const deps: ManagedInitCoordinatorDependencies = {
    context: { configDir: '/private/fake/.gbrain', root: '/private/fake/.gbrain/postgres/17', uid: 501, platform: 'darwin', arch: 'arm64' },
    acceptedEnvironmentUrl: () => options.acceptedEnv ?? false,
    directDatabaseOverride: () => options.directOverride ?? false,
    canonicalPgliteArtifactPaths: ['/private/fake/.gbrain/brain.pglite'],
    inspectFull(input) { expect(input.acceptedEnvironmentUrl).toBe(false); events.push('preflight'); return options.initial ?? { kind: 'fresh' }; },
    inspectCommand(input) { expect(input.acceptedEnvironmentUrl).toBe(false); events.push('command-check'); return options.latest ?? command('unpublished'); },
    async confirm(message) {
      events.push('confirm');
      if ((options.promptFailure === 'cluster' && message.startsWith('Create/resume')) || (options.promptFailure === 'package' && message.startsWith('Install packages'))) throw new Error('postgresql://SECRET/private');
      if (options.abortAt === 'confirm') controller.abort();
      return options.promptAnswer ?? true;
    },
    async plan() { events.push('plan'); if (options.abortAt === 'plan') controller.abort(); return options.plan ?? readyPlan(); },
    async withProvisioned(_context, callback, _consent, hooks) {
      events.push('lifecycle');
      const state = options.state ?? (options.initial?.kind === 'fresh' || !options.initial ? 'fresh' : 'owned-resume');
      events.push('beforeMutation');
      await hooks.beforeMutation({ kind: state, reference: activeReference });
      if (options.abortAt === 'beforeMutation') controller.abort();
      events.push('callback');
      try { return await callback(activeReference); }
      catch (error) {
        if (error instanceof ProcessTerminationUnconfirmedError) events.push('termination-retention-observed');
        throw error;
      }
    },
    async createEngine() { events.push('engine-create'); if (options.abortAt === 'create') controller.abort(); if (options.failure === 'create') throw new Error('path /private/private SECRET'); return engine; },
    configureFixedSchemaProfile() { events.push('profile'); if (options.abortAt === 'profile') controller.abort(); if (options.failure === 'profile') throw new Error('provider key secret'); },
    publish() {
      events.push('publish');
      if (options.abortAt === 'publish') controller.abort();
      if (options.failure === 'uncertain') throw new ConfigPublicationUncertainError();
      if (options.failure === 'committed-cleanup') throw new ConfigPublicationCommittedCleanupError();
      if (options.failure === 'publish') throw new Error('raw path /hidden password=SECRET');
    },
    cancellationScope() { events.push('scope'); return { signal: controller.signal, dispose: () => events.push('dispose') }; },
    writeStdout(line) { events.push(`stdout:${line}`); },
    writeStderr(line) { events.push(`stderr:${line}`); },
  };
  if (options.abortAt === 'preflight') controller.abort();
  return { deps, events, controller };
}

describe('managed PostgreSQL init coordinator', () => {
  test('passes managed-safe diagnostics to real schema verifier helper without schema stdout', async () => {
    const expected = parseExpectedColumns().filter(column => column.table === 'pages' && column.column !== 'content_hash');
    let capturedContext: SchemaDiagnosticContext | undefined;
    const fixtureState = fixture({ schemaHook: async context => {
      capturedContext = context;
      const engine = {
        executeRaw: async (sql: string) => sql.includes('information_schema.tables')
          ? [{ table_name: 'pages' }]
          : expected.map(column => ({ table_name: 'pages', column_name: column.column })),
        runMigration: async () => {},
      } as unknown as BrainEngine;
      await verifySchema(engine, context);
    } });
    const outcome = await runManagedInitCoordinator(selection(), fixtureState.deps);
    expect(outcome.status).toBe('ok');
    expect(capturedContext?.managedSafe).toBe(true);
    expect(fixtureState.events.filter(event => event.startsWith('stderr:')).join(' ')).not.toMatch(/pages|content_hash|private|01234567/);
    expect(fixtureState.events.filter(event => event.startsWith('stdout:'))).toEqual([]);
    const finalJson = JSON.stringify({ status: outcome.status, reason: outcome.reason, stage: outcome.stage, message: outcome.message });
    expect(JSON.parse(finalJson)).toMatchObject({ status: 'ok', reason: 'managed_init_completed' });
  });

  test('complete successful transcript is ordered and contains no forbidden setup paths', async () => {
    const f = fixture();
    const result = await runManagedInitCoordinator(selection(), f.deps);
    expect(result).toMatchObject({ status: 'ok', reason: 'managed_init_completed' });
    expect(f.events).toEqual(['scope', 'preflight', 'plan', 'stderr:Package impact: already ready.', 'lifecycle', 'beforeMutation', 'command-check', 'callback', 'engine-create', 'connect', 'profile', 'schema', 'command-check', 'publish', 'disconnect', 'dispose']);
    expect(f.events.join(' ')).not.toMatch(/content|provider|login|pglite|supabase|secret|01234567|private\/fake/);
  });

  test('fresh, owned, and published initial actions require corresponding locked eligibility', async () => {
    for (const initial of [{ kind: 'fresh' } as const, resume('owned-resume'), resume('published-resume')]) {
      const f = fixture({ initial, latest: initial.kind === 'published-resume' ? command('published') : command('unpublished'), state: initial.kind === 'fresh' ? 'fresh' : 'owned-resume' });
      expect((await runManagedInitCoordinator(selection(), f.deps)).status).toBe('ok');
    }
    const drift = fixture({ initial: resume('published-resume'), latest: command('published'), state: 'owned-resume' });
    let commandChecks = 0;
    const originalCommand = drift.deps.inspectCommand;
    drift.deps.inspectCommand = (input) => { commandChecks++; return commandChecks === 1 ? originalCommand(input) : command('unpublished'); };
    expect(await runManagedInitCoordinator(selection(), drift.deps)).toMatchObject({ reason: 'state_changed', stage: 'locked_recheck' });
    expect(drift.events).not.toContain('engine-create');
    const mismatches = [
      fixture({ initial: resume('owned-resume'), latest: command('published'), state: 'owned-resume' }),
      fixture({ initial: { kind: 'fresh' }, latest: command('unpublished'), state: 'owned-resume' }),
      fixture({ initial: resume('owned-resume'), latest: command('unpublished'), state: 'owned-resume', lifecycleReference: { ...reference, cluster_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } }),
    ];
    for (const mismatch of mismatches) {
      expect((await runManagedInitCoordinator(selection(), mismatch.deps)).reason).toBe('state_changed');
      expect(mismatch.events).not.toContain('engine-create');
    }
  });

  test('published resume success says embedding settings were preserved, not deferred', async () => {
    const f = fixture({ initial: resume('published-resume'), latest: command('published'), state: 'owned-resume' });
    const result = await runManagedInitCoordinator(selection(), f.deps);
    expect(result.status).toBe('ok');
    expect(result.message).toContain('Existing embedding settings were preserved');
    expect(result.message).not.toContain('deferred');
  });

  test('environment URL and direct override refuse before planning; plan refusal is sanitized', async () => {
    for (const opts of [{ acceptedEnv: true }, { directOverride: true }]) {
      const f = fixture(opts);
      expect(await runManagedInitCoordinator(selection(), f.deps)).toMatchObject({ reason: 'preflight_refused' });
      expect(f.events).not.toContain('plan');
    }
    const f = fixture({ plan: { ...readyPlan(), refusal: 'postgresql://user:secret@host.invalid/private' } });
    const result = await runManagedInitCoordinator(selection(), f.deps);
    expect(result).toMatchObject({ reason: 'plan_refused' });
    expect(JSON.stringify(result)).not.toMatch(/postgresql|secret|host\.invalid|private/);
  });

  test('plan contradictions and malformed fingerprints are rejected before package summaries', async () => {
    const invalid: ProvisionPlan[] = [
      { ...readyPlan(), ready: false },
      { ...readyPlan(), installPackages: true, packagePlanFingerprint: fingerprint, packageImpact: { known: true, fingerprint, formulaInstalls: [], dependencyInstalls: [], upgrades: [], reinstalls: [], lines: [] } },
      { ...readyPlan(), packages: { ...readyPlan().packages, ready: false, missing: ['postgresql@17'] } },
      { ...readyPlan(), ready: false, packages: { ...readyPlan().packages, ready: false, missing: ['postgresql@17'] } },
      { ...installPlan(), packages: { ...installPlan().packages, missing: [] } },
      { ...installPlan(), packageImpact: { ...installPlan().packageImpact!, known: false } },
      { ...installPlan(), packages: { ...installPlan().packages, incompatible: ['postgresql@17'] } },
      { ...installPlan(), packages: { ...installPlan().packages, missing: ['homebrew'] } },
      { ...readyPlan(), refusal: 'private refusal detail' },
      { ...installPlan(), packagePlanFingerprint: 'NOT-A-FINGERPRINT' },
      { ...installPlan(), packageImpact: { ...installPlan().packageImpact!, fingerprint: 'b'.repeat(64) } },
    ];
    for (const plan of invalid) {
      const f = fixture({ plan });
      expect((await runManagedInitCoordinator(selection(), f.deps)).reason).toMatch(/plan_refused|package_plan_changed/);
      expect(f.events.some(event => event.startsWith('stderr:Package impact:'))).toBe(false);
      expect(f.events).not.toContain('lifecycle');
    }
    const unnecessary = fixture({ plan: readyPlan() });
    expect((await runManagedInitCoordinator(selection({ consent: { installPackages: true, packagePlanFingerprint: fingerprint } }), unnecessary.deps)).reason).toBe('package_plan_changed');
  });

  test('final eligibility is re-read after held schema and rejects override or action drift', async () => {
    for (const drift of ['environment', 'direct', 'artifact', 'published', 'reference'] as const) {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const opts: NonNullable<Parameters<typeof fixture>[0]> = {};
      const f = fixture({ schemaGate: { promise: gate, finish: () => release() }, schemaHook: async () => {
        if (drift === 'environment') opts.acceptedEnv = true;
        if (drift === 'direct') opts.directOverride = true;
        if (drift === 'artifact') opts.latest = command('published');
        if (drift === 'published') opts.latest = command('published');
        if (drift === 'reference') opts.latest = { kind: 'published', reference: { ...reference, cluster_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } };
      } });
      // Share mutable eligibility values with the injected observers.
      const originalEnv = f.deps.acceptedEnvironmentUrl;
      const originalDirect = f.deps.directDatabaseOverride;
      const originalInspect = f.deps.inspectCommand;
      f.deps.acceptedEnvironmentUrl = () => opts.acceptedEnv ?? originalEnv();
      f.deps.directDatabaseOverride = () => opts.directOverride ?? originalDirect();
      f.deps.inspectCommand = input => opts.latest ?? originalInspect(input);
      const pending = runManagedInitCoordinator(selection(), f.deps);
      while (!f.events.includes('schema')) await Promise.resolve();
      await Promise.resolve();
      release();
      const result = await pending;
      expect(result.reason).toBe('state_changed');
      expect(f.events).not.toContain('publish');
    }
  });

  test('inspectCommand exceptions at either locked eligibility check normalize to state_changed', async () => {
    for (const throwOnCall of [1, 2]) {
      const f = fixture();
      let calls = 0;
      const inspect = f.deps.inspectCommand;
      f.deps.inspectCommand = input => { calls++; if (calls === throwOnCall) throw new Error('private observer detail'); return inspect(input); };
      const result = await runManagedInitCoordinator(selection(), f.deps);
      expect(result).toMatchObject({ reason: 'state_changed' });
      expect(JSON.stringify(result)).not.toContain('private observer detail');
      expect(f.events).not.toContain('publish');
    }
  });

  test('cluster consent precedes plan and package consent is a distinct exact-fingerprint step', async () => {
    const declined = fixture({ promptAnswer: false });
    const declinedResult = await runManagedInitCoordinator(selection({ yes: false, json: false, nonInteractive: false }), declined.deps);
    expect(declinedResult.reason).toBe('cluster_consent_required');
    expect(declined.events).not.toContain('plan');

    const approved = fixture({ plan: installPlan() });
    const approvedResult = await runManagedInitCoordinator(selection({ yes: false, json: false, nonInteractive: false }), approved.deps);
    expect(approvedResult.status).toBe('ok');
    expect(approved.events).toEqual(['scope', 'preflight', 'stderr:Managed PostgreSQL will create a fresh local managed database. This is local, manual-controller, database-only setup; no login-start, provider setup, or content import will run.', 'confirm', 'plan', 'stderr:Package impact: 1 formula install(s), 1 dependency install(s), 0 upgrade(s). Package-plan fingerprint: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.', 'stderr:A separate package-install approval is required for fingerprint aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.', 'confirm', 'lifecycle', 'beforeMutation', 'command-check', 'callback', 'engine-create', 'connect', 'profile', 'schema', 'command-check', 'publish', 'disconnect', 'dispose']);

    const noConsent = fixture({ plan: installPlan() });
    const refusal = await runManagedInitCoordinator(selection(), noConsent.deps);
    expect(refusal.reason).toBe('package_consent_required');
    expect(refusal.message).toContain(fingerprint);
    expect(noConsent.events).not.toContain('lifecycle');
    const mismatch = fixture({ plan: installPlan() });
    expect((await runManagedInitCoordinator(selection({ consent: { installPackages: true, packagePlanFingerprint: 'b'.repeat(64) } }), mismatch.deps)).reason).toBe('package_plan_changed');
  });

  test('engine/schema/publication outcomes are distinct and redact hostile exceptions', async () => {
    const cases: Array<[NonNullable<Parameters<typeof fixture>[0]>['failure'], ManagedInitOutcome['reason']]> = [
      ['create', 'connect_failed'], ['connect', 'connect_failed'], ['profile', 'schema_failed'], ['schema', 'schema_failed'],
      ['publish', 'publication_failed'], ['uncertain', 'publication_uncertain'],
      ['committed-cleanup', 'publication_committed_cleanup'], ['disconnect', 'disconnect_failed'],
    ];
    for (const [failure, reason] of cases) {
      const f = fixture({ failure });
      const result = await runManagedInitCoordinator(selection(), f.deps);
      expect(result.reason).toBe(reason);
      expect(JSON.stringify(result)).not.toMatch(/SECRET|password|postgresql:|\/private|01234567/);
      if (['connect', 'profile', 'schema', 'publish', 'uncertain', 'committed-cleanup', 'disconnect'].includes(failure!)) expect(f.events).toContain('disconnect');
      if (['connect', 'profile', 'schema'].includes(failure!)) expect(f.events).not.toContain('publish');
    }
  });

  test('uncommitted cleanup failures never claim config was committed and dominate ordinary failures', async () => {
    const alone = fixture({ abortAt: 'schema', disconnectFailure: true });
    const aloneResult = await runManagedInitCoordinator(selection(), alone.deps);
    expect(aloneResult).toMatchObject({ reason: 'cleanup_failed_uncommitted', stage: 'disconnect' });
    expect(aloneResult.message).toContain('Config was not published');
    expect(aloneResult.message).toContain('retained cluster state was not removed');
    expect(aloneResult.message).not.toContain('committed');

    for (const failure of ['connect', 'schema'] as const) {
      const combined = fixture({ failure, disconnectFailure: true });
      const result = await runManagedInitCoordinator(selection(), combined.deps);
      expect(result.reason).toBe('cleanup_failed_uncommitted');
      expect(result.message).not.toContain('committed');
      expect(result.message).toContain('Config was not published');
    }
    const cancelled = fixture({ abortAt: 'connect', disconnectFailure: true });
    const cancelledResult = await runManagedInitCoordinator(selection(), cancelled.deps);
    expect(cancelledResult.reason).toBe('cleanup_failed_uncommitted');
    expect(cancelledResult.message).not.toContain('committed');
  });

  test('uncertain publication remains primary; committed publication cleanup remains truthful', async () => {
    const uncertain = fixture({ failure: 'uncertain', disconnectFailure: true });
    const uncertainResult = await runManagedInitCoordinator(selection(), uncertain.deps);
    expect(uncertainResult).toMatchObject({ reason: 'publication_uncertain', stage: 'publish' });
    expect(uncertainResult.message).toContain('uncertain');

    const committedCleanup = fixture({ failure: 'committed-cleanup', disconnectFailure: true });
    const committedResult = await runManagedInitCoordinator(selection(), committedCleanup.deps);
    expect(committedResult).toMatchObject({ reason: 'publication_committed_cleanup', stage: 'publish' });
    expect(committedResult.message).toContain('config was committed');

    for (const failure of ['uncertain', 'committed-cleanup'] as const) {
      const combined = fixture({ failure, abortAt: 'publish', disconnectFailure: true });
      const result = await runManagedInitCoordinator(selection(), combined.deps);
      expect(result.reason).toBe(failure === 'uncertain' ? 'publication_uncertain' : 'publication_committed_cleanup');
      expect(result.message).not.toContain('Config was not published');
      expect(result.message).not.toContain('uncommitted');
    }
  });

  test('unconfirmed process termination escapes the callback for lifecycle retention', async () => {
    const f = fixture({ failure: 'termination' });
    const result = await runManagedInitCoordinator(selection(), f.deps);
    expect(result).toMatchObject({ reason: 'provision_failed' });
    expect(f.events).toContain('termination-retention-observed');
    expect(f.events).toContain('disconnect');
    expect(result.message).toContain('retained state');

    for (const [failure, reason] of [
      ['uncertain', 'publication_uncertain'],
      ['committed-cleanup', 'publication_committed_cleanup'],
    ] as const) {
      const combined = fixture({ failure, disconnectTermination: true });
      expect(await runManagedInitCoordinator(selection(), combined.deps)).toMatchObject({ reason });
      expect(combined.events).toContain('termination-retention-observed');
    }
    const committed = fixture({ disconnectTermination: true });
    expect(await runManagedInitCoordinator(selection(), committed.deps)).toMatchObject({ reason: 'publication_committed_cleanup' });
    expect(committed.events).toContain('termination-retention-observed');
  });

  test('prompt exceptions fail closed as their matching consent refusal', async () => {
    const cluster = fixture({ promptFailure: 'cluster' });
    const clusterResult = await runManagedInitCoordinator(selection({ yes: false, nonInteractive: false, json: false }), cluster.deps);
    expect(clusterResult.reason).toBe('cluster_consent_required');
    expect(clusterResult.message).not.toMatch(/SECRET|postgresql|private/);
    expect(cluster.events).not.toContain('plan');

    const packages = fixture({ plan: installPlan(), promptFailure: 'package' });
    const packageResult = await runManagedInitCoordinator(selection({ yes: false, nonInteractive: false, json: false }), packages.deps);
    expect(packageResult.reason).toBe('package_consent_required');
    expect(packageResult.message).not.toMatch(/SECRET|postgresql|private/);
    expect(packages.events).not.toContain('lifecycle');
  });

  test('unresolved production prompts close on abort and coordinator reports cancellation', async () => {
    for (const packagePrompt of [false, true]) {
      const f = fixture({ plan: packagePrompt ? installPlan() : readyPlan() });
      const input = new PassThrough();
      const output = new PassThrough();
      f.deps.confirm = (message, signal) => { f.events.push('confirm'); return promptYesNo(message, { input, output, signal }); };
      const pending = runManagedInitCoordinator(selection({ yes: packagePrompt, nonInteractive: false, json: false }), f.deps);
      while (!f.events.includes('confirm')) await Promise.resolve();
      expect(getEventListeners(f.controller.signal, 'abort')).toHaveLength(1);
      f.controller.abort();
      expect((await pending).reason).toBe('cancelled');
      expect(getEventListeners(f.controller.signal, 'abort')).toHaveLength(0);
      expect(input.listenerCount('data')).toBe(0);
      expect(f.events).not.toContain('lifecycle');
      input.destroy(); output.destroy();
    }
  });

  test('production cancellation scope listens for SIGINT and SIGTERM and removes both once', () => {
    const intBefore = process.listenerCount('SIGINT');
    const termBefore = process.listenerCount('SIGTERM');
    const scope = createManagedInitCancellationScope();
    expect(process.listenerCount('SIGINT')).toBe(intBefore + 1);
    expect(process.listenerCount('SIGTERM')).toBe(termBefore + 1);
    scope.dispose();
    scope.dispose();
    expect(process.listenerCount('SIGINT')).toBe(intBefore);
    expect(process.listenerCount('SIGTERM')).toBe(termBefore);
  });

  test('cancellation during unresolved schema waits for work, disconnects, and never publishes', async () => {
    let finish!: () => void;
    const gate = { promise: new Promise<void>((resolve) => { finish = resolve; }), finish: () => finish() };
    const f = fixture({ schemaGate: gate });
    const pending = runManagedInitCoordinator(selection(), f.deps);
    while (!f.events.includes('schema')) await Promise.resolve();
    f.controller.abort();
    expect(f.events).not.toContain('publish');
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.finish();
    const result = await pending;
    expect(result.reason).toBe('cancelled');
    expect(f.events).toContain('disconnect');
    expect(f.events).not.toContain('publish');
    expect(f.events.at(-1)).toBe('dispose');
  });

  test('cancellation at each awaited boundary is observed without detached work', async () => {
    const interactive = selection({ yes: false, nonInteractive: false, json: false });
    for (const abortAt of ['preflight', 'confirm', 'plan', 'beforeMutation', 'create', 'connect', 'profile', 'schema', 'publish', 'disconnect'] as const) {
      const f = fixture({ abortAt });
      const result = await runManagedInitCoordinator(abortAt === 'confirm' ? interactive : selection(), f.deps);
      expect(result.reason).toBe(abortAt === 'publish' || abortAt === 'disconnect' ? 'publication_committed_cleanup' : 'cancelled');
      expect(f.events).toContain('dispose');
      if (['create', 'connect', 'profile', 'schema', 'publish', 'disconnect'].includes(abortAt)) expect(f.events).toContain('disconnect');
      if (abortAt !== 'publish' && abortAt !== 'disconnect') expect(f.events).not.toContain('publish');
    }
  });
});
