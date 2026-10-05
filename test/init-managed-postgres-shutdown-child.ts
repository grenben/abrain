import { createInterface } from 'node:readline';
import { installSignalHandlers } from '../src/core/process-cleanup.ts';
import {
  runManagedInitWithShutdownSettlement,
  type ManagedInitCoordinatorDependencies,
} from '../src/commands/init-managed-postgres.ts';
import type { ManagedInitFlagSelection } from '../src/commands/init-flags.ts';
import type { ManagedPostgresReference } from '../src/core/types.ts';

const reference: ManagedPostgresReference = { manager_id: 'gbrain-managed-postgres', cluster_id: '01234567-89ab-cdef-0123-456789abcdef' };
const packages = { ready: true, missing: [], incompatible: [], brew: '', prefix: '', formulaPrefix: '', formulaVersion: '', pgvectorPrefix: '', pgvectorVersion: '', sharedir: '', pkglibdir: '', binaries: {}, installArgv: [] };
const selection: ManagedInitFlagSelection = { lane: 'managed-postgres', yes: true, nonInteractive: true, json: true, noEmbedding: true, dbOnly: true, consent: { installPackages: false } };
const input = createInterface({ input: process.stdin });

const deps: ManagedInitCoordinatorDependencies = {
  context: { configDir: '/tmp/fake', root: '/tmp/fake/postgres/17', uid: -1, platform: process.platform, arch: process.arch },
  acceptedEnvironmentUrl: () => false,
  directDatabaseOverride: () => false,
  canonicalPgliteArtifactPaths: [],
  inspectFull: () => ({ kind: 'fresh' }),
  inspectCommand: () => ({ kind: 'unpublished' }),
  confirm: async () => true,
  plan: async ({ signal }) => {
    console.log('READY');
    await new Promise<void>(resolve => signal.addEventListener('abort', () => {
      console.log('ABORT_OBSERVED');
      input.once('line', () => resolve());
    }, { once: true }));
    return { ready: true, root: '/tmp/fake', installPackages: false, packages, commands: [] };
  },
  withProvisioned: async (_context, _callback) => { throw new Error('unexpected lifecycle'); },
  createEngine: async () => { throw new Error('unexpected engine'); },
  configureFixedSchemaProfile: () => {},
  publish: () => {},
  cancellationScope: () => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.on('SIGTERM', abort);
    return { signal: controller.signal, dispose: () => process.off('SIGTERM', abort) };
  },
  writeStdout: () => {},
  writeStderr: () => {},
};

installSignalHandlers();
void runManagedInitWithShutdownSettlement(selection, deps).then(() => console.log('COORDINATOR_SETTLED'));
