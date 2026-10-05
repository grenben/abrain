import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BrainEngine } from '../src/core/engine.ts';

let workerConstructions = 0;
let workerConnects = 0;
let importEngines: BrainEngine[] = [];

mock.module('../src/core/postgres-engine.ts', () => ({
  PostgresEngine: class {
    constructor() { workerConstructions++; }
    async connect(): Promise<void> { workerConnects++; }
    async disconnect(): Promise<void> {}
  },
}));

mock.module('../src/core/import-file.ts', () => ({
  importFile: async (engine: BrainEngine) => {
    importEngines.push(engine);
    return { status: 'imported', slug: 'people/selected', chunks: 1 };
  },
  importFromContent: async () => ({ status: 'skipped' }),
  importFromFile: async () => ({ status: 'skipped' }),
  importCodeFile: async () => ({ status: 'skipped' }),
  importImageFile: async () => ({ status: 'skipped' }),
  isImageFilePath: () => false,
  withImportTransaction: async (_engine: BrainEngine, work: () => Promise<unknown>) => work(),
  pLimit: () => (work: () => Promise<unknown>) => work(),
  MAX_FILE_SIZE: 5_000_000,
  SUPPORTED_IMAGE_EXTS: [],
  MAX_IMAGE_BYTES: 20 * 1024 * 1024,
  _resetOcrRunBudgetForTests: () => {},
  _getOcrRunBudgetForTests: () => ({ images: 0, estUsd: 0, warned: false }),
}));

let root: string;
let repoPath: string;
let previousHome: string | undefined;
let runImportsPhase: typeof import('../src/commands/sync/imports.ts').runImportsPhase;
let createSyncRun: typeof import('../src/commands/sync/sync-run.ts').createSyncRun;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-sync-managed-selection-'));
  repoPath = join(root, 'repo');
  mkdirSync(join(repoPath, 'people'), { recursive: true });
  writeFileSync(join(repoPath, 'people/selected.md'), 'content');
  mkdirSync(join(root, '.gbrain'));
  writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'postgres',
    managed_postgres: {
      manager_id: 'gbrain-managed-postgres',
      cluster_id: '00000000-0000-4000-8000-000000000123',
    },
  }));
  previousHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = root;
  ({ runImportsPhase } = await import('../src/commands/sync/imports.ts'));
  ({ createSyncRun } = await import('../src/commands/sync/sync-run.ts'));
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

test('managed global config drains a parallel sync request serially on its selected Postgres engine', async () => {
  workerConstructions = 0;
  workerConnects = 0;
  importEngines = [];
  const selectedMount = {
    kind: 'postgres',
    getConfig: async () => null,
    executeRaw: async () => [],
    executeRawDirect: async () => [],
  } as unknown as BrainEngine;
  const opts = { concurrency: 2, noEmbed: true, signal: undefined } as any;
  const run = createSyncRun(selectedMount, {
    ckptPaths: { op: 'sync-import', fingerprint: 'selected-mount-test' },
    onProgress: undefined,
    completedPaths: [],
    checkpointEvery: 100,
    swept: 0,
  });
  const filtered = {
    added: ['people/selected.md'], modified: [], deleted: [], renamed: [],
  } as any;
  const plan = {
    opts,
    filtered,
    lastCommit: 'before',
    pin: 'after',
    company: null,
    gitContextRoot: repoPath,
    syncImportRoot: repoPath,
    syncActivePack: undefined,
  } as any;
  const progress = { start() {}, tick() {}, finish() {} } as any;

  await runImportsPhase(run, plan, progress, true);

  expect(importEngines).toEqual([selectedMount]);
  expect(run.filesImported).toBe(1);
  expect(workerConstructions).toBe(0);
  expect(workerConnects).toBe(0);
});
