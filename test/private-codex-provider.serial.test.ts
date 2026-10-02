import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateCodexEnabled } from '../src/core/ai/private-codex.ts';
import { configureGateway, __setGenerateTextTransportForTests, chat, expand, resetGateway, withBudgetTracker } from '../src/core/ai/gateway.ts';
import { resolveRecipe, knownProviderIds } from '../src/core/ai/model-resolver.ts';
import { listRecipes } from '../src/core/ai/recipes/index.ts';
import { usageCostUsd, isModelPriceable } from '../src/core/budget/reservation-cost.ts';
import { isPrivateCodexModel } from '../src/core/ai/private-codex.ts';
import { chatInvocation } from '../src/core/ai/guarded-generation.ts';
import { withAIInvocationGuard } from '../src/core/ai/invocation-guard.ts';
import { BudgetTracker, BudgetExhausted } from '../src/core/budget/budget-tracker.ts';
import { resolveEffectiveChatModel, resolveEffectiveExpansionModel } from '../src/core/model-config.ts';
import { generateText } from 'ai';
import { CodexCliLanguageModel } from '../src/core/ai/providers/codex-cli-language-model.ts';
import { maximumInvocationCents } from '../src/core/minions/delegated-spend.ts';

const oldGate = process.env.GBRAIN_PRIVATE_CODEX_CLI;
const originalCwd = process.cwd();
const publicIds = knownProviderIds();
const listed = listRecipes().map(recipe => recipe.id);
const savedEnv = new Map<string, string | undefined>();
const testDirs: string[] = [];

function setTestEnv(key: string, value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  resetGateway();
  __setGenerateTextTransportForTests(null);
  if (oldGate === undefined) delete process.env.GBRAIN_PRIVATE_CODEX_CLI;
  else process.env.GBRAIN_PRIVATE_CODEX_CLI = oldGate;
  process.chdir(originalCwd);
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  for (const dir of testDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('private Codex activation', () => {
  test('only literal 1 enables; public registry remains unchanged', () => {
    for (const value of [undefined, '0', 'true', ' 1', '1 ']) {
      if (value === undefined) delete process.env.GBRAIN_PRIVATE_CODEX_CLI;
      else process.env.GBRAIN_PRIVATE_CODEX_CLI = value;
      expect(privateCodexEnabled()).toBe(false);
      expect(() => resolveRecipe('codex-cli:gpt-5.6-sol')).toThrow();
    }
    process.env.GBRAIN_PRIVATE_CODEX_CLI = '1';
    expect(privateCodexEnabled()).toBe(true);
    expect(resolveRecipe('codex-cli:gpt-5.6-sol').recipe.id).toBe('codex-cli');
    expect(knownProviderIds()).toEqual(publicIds);
    expect(listRecipes().map(recipe => recipe.id)).toEqual(listed);
    expect(publicIds).not.toContain('codex-cli');
  });

  test('private model detection follows parseModelId colon-first and slash semantics', () => {
    for (const model of ['codex-cli:model', ' Codex-CLI : model ', 'CODEX-CLI/model', ' codex-cli / vendor/model']) {
      expect(isPrivateCodexModel(model)).toBe(true);
    }
    expect(isPrivateCodexModel('other:codex-cli/model')).toBe(false);
    expect(isPrivateCodexModel('codex-cli:')).toBe(false);
    expect(isPrivateCodexModel('codex-cli/model:tail')).toBe(false);
    expect(isPrivateCodexModel('codex-cli/model/tail')).toBe(true);
  });

  test('effective file/env pins stay explicit whether enabled or disabled', () => {
    for (const gate of ['1', undefined]) {
      setTestEnv('GBRAIN_PRIVATE_CODEX_CLI', gate);
      for (const pin of ['codex-cli:gpt-5.6-sol', ' Codex-CLI / gpt-5.6-sol ']) {
        expect(resolveEffectiveChatModel({ engine: 'pglite', chat_model: pin }, {}).model).toBe(pin.trim());
        expect(resolveEffectiveExpansionModel({ engine: 'pglite', expansion_model: pin }, {}).model).toBe(pin.trim());
        expect(resolveEffectiveChatModel(null, { GBRAIN_MODEL: pin }).model).toBe(pin.trim());
      }
    }
  });

  test('cwd dotenv cannot enable it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'private-codex-env-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.env'), 'GBRAIN_PRIVATE_CODEX_CLI=1\n');
    process.chdir(dir);
    setTestEnv('GBRAIN_PRIVATE_CODEX_CLI', '1');
    expect(privateCodexEnabled()).toBe(false);
    expect(() => resolveRecipe('codex-cli:gpt-5.6-sol')).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  test('chat and expansion use text generation without enforceable token limits', async () => {
    setTestEnv('GBRAIN_PRIVATE_CODEX_CLI', '1');
    configureGateway({ chat_model: 'codex-cli:gpt-5.6-sol', expansion_model: 'codex-cli:gpt-5.6-sol', env: {} });
    const seen: any[] = [];
    __setGenerateTextTransportForTests(async (options: any) => {
      seen.push(options);
      return { text: '{"queries":["one","two"]}', content: [{ type: 'text', text: 'answer' }], finishReason: 'stop', usage: { inputTokens: 7, outputTokens: 11 } } as any;
    });
    let invocation: any;
    await withAIInvocationGuard(async call => {
      invocation = call;
      return { settle: async () => {} };
    }, () => chat({ model: 'codex-cli:gpt-5.6-sol', messages: [{ role: 'user', content: 'hello' }], maxTokens: 123 }));
    expect(seen[0].model.provider).toBe('codex-cli');
    expect(seen[0].maxOutputTokens).toBe(123);
    expect(invocation.maxOutputTokens).toBeUndefined();
    expect(chatInvocation('test', 'codex-cli:gpt-5.6-sol', 123).maxOutputTokens).toBeUndefined();
    expect(maximumInvocationCents(chatInvocation('test', 'codex-cli:gpt-5.6-sol', 123))).toBeNull();
    expect(await expand('query')).toEqual(['query', 'one', 'two']);
    expect(seen[1].model.provider).toBe('codex-cli');
    expect(seen[1].maxOutputTokens).toBeDefined();
  });

  test('schema requests reject before generation; unpriced usage stays null', async () => {
    setTestEnv('GBRAIN_PRIVATE_CODEX_CLI', '1');
    configureGateway({ chat_model: 'codex-cli:gpt-5.6-sol', env: {} });
    let calls = 0;
    __setGenerateTextTransportForTests(async () => { calls++; throw new Error('unexpected'); });
    await expect(chat({ model: 'codex-cli:gpt-5.6-sol', messages: [], responseSchema: { name: 'x', schema: {} } })).rejects.toThrow(/responseSchema/);
    expect(calls).toBe(0);
    expect(usageCostUsd('codex-cli:gpt-5.6-sol', 100, 200, 'chat')).toBeNull();
    expect(isModelPriceable('codex-cli:gpt-5.6-sol', 'chat')).toBe(false);
  });

  test('finite hard tracker budgets refuse chat and expansion before transport', async () => {
    setTestEnv('GBRAIN_PRIVATE_CODEX_CLI', '1');
    configureGateway({ chat_model: 'codex-cli:gpt-5.6-sol', expansion_model: 'codex-cli:gpt-5.6-sol', env: {} });
    let calls = 0;
    __setGenerateTextTransportForTests(async () => { calls++; throw new Error('must not invoke'); });
    const tracker = new BudgetTracker({ maxCostUsd: 5, label: 'private-codex-test',
      pricingOverrides: { 'codex-cli:gpt-5.6-sol': { input: 1, output: 1 } },
      auditPath: join(tmpdir(), `private-codex-${process.pid}.jsonl`) });
    await expect(withBudgetTracker(tracker, () => chat({ model: 'codex-cli:gpt-5.6-sol', messages: [{ role: 'user', content: 'x' }] }))).rejects.toBeInstanceOf(BudgetExhausted);
    await expect(withBudgetTracker(tracker, () => expand('query'))).rejects.toBeInstanceOf(BudgetExhausted);
    expect(calls).toBe(0);
    expect(tracker.totalSpent).toBe(0);
    expect(tracker.snapshot().callsRecorded).toBe(0);
  });

  test('reconfiguration keeps explicit private file pins and slash-qualified DB models', async () => {
    const home = mkdtempSync(join(tmpdir(), 'private-codex-reconfigure-'));
    testDirs.push(home);
    setTestEnv('GBRAIN_HOME', home);
    setTestEnv('GBRAIN_MODEL_DISCOVERY', 'off');
    setTestEnv('GBRAIN_PRIVATE_CODEX_CLI', '1');
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', chat_model: ' Codex-CLI / gpt-5.6-sol ', expansion_model: 'codex-cli:gpt-5.6-sol' }));
    class StubEngine {
      readonly kind = 'pglite' as const;
      values = new Map<string, string>();
      async getConfig(key: string) { return this.values.get(key) ?? null; }
    }
    const engine = new StubEngine();
    configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', expansion_model: 'anthropic:claude-haiku-4-5-20251001', env: {} });
    const { reconfigureGatewayWithEngine, getChatModel, getExpansionModel } = await import('../src/core/ai/gateway.ts');
    await reconfigureGatewayWithEngine(engine as never);
    expect(getChatModel()).toBe('Codex-CLI / gpt-5.6-sol');
    expect(getExpansionModel()).toBe('codex-cli:gpt-5.6-sol');
    engine.values.set('models.chat', 'codex-cli/gpt-5.6-sol');
    await reconfigureGatewayWithEngine(engine as never);
    expect(getChatModel()).toBe('codex-cli/gpt-5.6-sol');
    engine.values.clear();
    configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', expansion_model: 'anthropic:claude-haiku-4-5-20251001', env: { GBRAIN_MODEL: ' Codex-CLI / gpt-5.6-sol ' } });
    await reconfigureGatewayWithEngine(engine as never);
    expect(getChatModel()).toBe('Codex-CLI / gpt-5.6-sol');
    setTestEnv('GBRAIN_PRIVATE_CODEX_CLI', undefined);
    await reconfigureGatewayWithEngine(engine as never);
    expect(getChatModel()).toBe('Codex-CLI / gpt-5.6-sol');
  });

  test('cached provider rechecks a revoked gate before transport', async () => {
    setTestEnv('GBRAIN_PRIVATE_CODEX_CLI', '1');
    configureGateway({ chat_model: 'codex-cli:gpt-5.6-sol', env: {} });
    let calls = 0;
    __setGenerateTextTransportForTests(async () => {
      calls++;
      return { text: 'ok', content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } } as any;
    });
    await chat({ model: 'codex-cli:gpt-5.6-sol', messages: [{ role: 'user', content: 'first' }] });
    expect(calls).toBe(1);
    setTestEnv('GBRAIN_PRIVATE_CODEX_CLI', undefined);
    await expect(chat({ model: 'codex-cli:gpt-5.6-sol', messages: [{ role: 'user', content: 'second' }] })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test('real AI SDK to fake adapter preserves advisory maxOutputTokens and warning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'private-codex-fake-bin-'));
    testDirs.push(dir);
    const bin = join(dir, 'codex-fake');
    writeFileSync(bin, '#!/bin/sh\ncat >/dev/null\nprintf \'%s\\n\' \'{"type":"thread.started","thread_id":"fake"}\' \'{"type":"turn.started"}\' \'{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}\' \'{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":2}}\'\n');
    chmodSync(bin, 0o755);
    setTestEnv('GBRAIN_PRIVATE_CODEX_CLI', '1');
    setTestEnv('GBRAIN_CODEX_CLI_BIN', bin);
    const result = await generateText({ model: new CodexCliLanguageModel('gpt-5.6-sol'), prompt: 'test', maxOutputTokens: 17 });
    expect(result.text).toBe('answer');
    expect(result.warnings).toContainEqual(expect.objectContaining({ setting: 'maxOutputTokens', type: 'unsupported-setting' }));
  });
});
