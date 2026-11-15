import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_JUDGE_MODEL } from '../../src/eval/longmemeval/judge.ts';
import { resolveEvalModels } from '../../src/eval/longmemeval/codex-config.ts';

const originalHome = process.env.GBRAIN_HOME;
let tempHome: string | undefined;

function usePrivatePolicy(enabledRoles: string[]): void {
  tempHome = mkdtempSync(join(tmpdir(), 'codex-eval-config-'));
  process.env.GBRAIN_HOME = tempHome;
  const configDir = join(tempHome, '.gbrain');
  mkdirSync(configDir);
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    private_codex: {
      mode: 'strict',
      bin: '/usr/bin/true',
      models: {
        utility: 'codex-cli:fixture',
        reasoning: 'codex-cli:fixture',
        deep: 'codex-cli:fixture',
        subagent: 'codex-cli:fixture',
      },
      enabled_roles: enabledRoles,
    },
  }));
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = originalHome;
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = undefined;
});

describe('private LongMemEval role resolution', () => {
  test('does not resolve reader or judge roles when retrieval-only and judging is disabled', async () => {
    usePrivatePolicy([]);
    const resolved = await resolveEvalModels({
      judgeModel: '',
      judgeConcurrency: 1,
      judge: false,
      retrievalOnly: true,
    }, {});

    expect(resolved).toEqual({
      model: 'sonnet',
      judgeModel: DEFAULT_JUDGE_MODEL,
      subscriptionAuthorized: false,
    });
  });

  test('resolves the active reader role without requiring the disabled judge role', async () => {
    usePrivatePolicy(['longmemeval-reader']);
    const resolved = await resolveEvalModels({
      judgeModel: '',
      judgeConcurrency: 1,
      judge: false,
      retrievalOnly: false,
    }, {});

    expect(resolved.model).toBe('codex-cli:fixture');
    expect(resolved.judgeModel).toBe(DEFAULT_JUDGE_MODEL);
  });

  test('still requires the private judge role when judging is active', async () => {
    usePrivatePolicy(['longmemeval-reader']);
    await expect(resolveEvalModels({
      judgeModel: '',
      judgeConcurrency: 1,
      judge: true,
      retrievalOnly: true,
    }, {})).rejects.toMatchObject({ code: 'private_role_disabled', source: 'role:longmemeval-judge' });
  });

  test('rejects explicit and owner-configured model pins that conflict with private roles', async () => {
    usePrivatePolicy(['longmemeval-reader', 'longmemeval-judge']);
    const opts = { judgeModel: '', judgeConcurrency: 1, judge: true, retrievalOnly: true };
    const configEngine = {
      getConfig: async (key: string) => key === 'models.eval.longmemeval_judge' ? 'anthropic:fixture' : null,
    } as any;

    await expect(resolveEvalModels({ ...opts, judgeModel: 'openai:fixture' }, {}))
      .rejects.toMatchObject({ code: 'private_route_conflict', source: 'cli:model' });
    await expect(resolveEvalModels(opts, { configEngine }))
      .rejects.toMatchObject({ code: 'private_route_conflict', source: 'db:models.eval.longmemeval_judge' });
  });
});
