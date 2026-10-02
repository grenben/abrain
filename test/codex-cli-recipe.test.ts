/**
 * Deterministic fake-binary coverage for the staged, unregistered codex-cli adapter.
 * A shell stub captures argv/env/cwd/stdin and emits Codex exec JSONL; no real
 * Codex login, network call, or account quota is used.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import { AIConfigError, AITransientError } from '../src/core/ai/errors.ts';
import { withEnv } from './helpers/with-env.ts';

const root = join(tmpdir(), `gbrain-codex-cli-test-${process.pid}`);
const stubBin = join(root, 'codex');
const argsPath = join(root, 'args.txt');
const cwdPath = join(root, 'cwd.txt');
const envPath = join(root, 'env.txt');
const promptPath = join(root, 'prompt.txt');
const startedPath = join(root, 'started');
const modePath = join(root, 'mode');
const sideEffectPath = join(root, 'side-effect');
const descendantReadyPath = join(root, 'descendant-ready');
const parentEndedPath = join(root, 'parent-ended');

beforeAll(() => {
  mkdirSync(root, { recursive: true });
  const stub = [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > "${argsPath}"`,
    `pwd > "${cwdPath}"`,
    `env | sort > "${envPath}"`,
    `cat > "${promptPath}"`,
    `touch "${startedPath}"`,
    `case "$(cat "${modePath}")" in`,
    '  success)',
    `    printf '%s\\n' '{"type":"thread.started","thread_id":"thread-test"}' '{"type":"turn.started"}' '{"type":"item.completed","item":{"id":"item-1","type":"agent_message","text":"hello from codex"}}' '{"type":"turn.completed","usage":{"input_tokens":21,"cached_input_tokens":8,"cache_write_input_tokens":2,"output_tokens":13,"reasoning_output_tokens":3}}'`,
    '    ;;',
    '  missing-usage|negative-usage|bad-cached-usage)',
    `    printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"usable answer"}}'`,
    '    case "$(cat "' + modePath + '")" in',
    `      missing-usage) printf '%s\\n' '{"type":"turn.completed"}' ;;`,
    `      negative-usage) printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":-1,"output_tokens":2}}' ;;`,
    `      *) printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":2,"output_tokens":3,"cached_input_tokens":3}}' ;;`,
    '    esac',
    '    ;;',
    '  unknown-event)',
    `    printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}' '{"type":"turn.started.future"}'`,
    '    ;;',
    '  unknown-field)',
    `    printf '%s\\n' '{"type":"turn.started","tool_command":"do-not-run"}'`,
    '    ;;',
    '  unknown-item)',
    `    printf '%s\\n' '{"type":"item.started","item":{"type":"future_tool","payload":"activity"}}'`,
    '    ;;',
    '  todo-list)',
    `    printf '%s\\n' '{"type":"item.started","item":{"type":"todo_list","id":"todo-1"}}'`,
    '    ;;',
    '  framing)',
    `    printf '%b' '{"type":"item.completed","item":{"type":"agent_message","text":"CRLF and final"}}\\r\\n{"type":"turn.completed","usage":{"input_tokens":4,"output_tokens":5}}'`,
    '    ;;',
    '  final-diagnostic)',
    `    printf '%s' '{"type":"item.completed","item":{"type":"error","message":"Not logged in. access_token=final-secret"}}'`,
    '    ;;',
    '  duplicate-completion)',
    `    printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"duplicate"}}' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'`,
    '    ;;',
    '  stdout-overflow)',
    '    yes x | head -c 4194305',
    '    ;;',
    '  stderr-overflow)',
    '    head -c 262145 /dev/zero >&2',
    '    ;;',
    '  success-descendant)',
    `    (trap '' TERM; touch "${descendantReadyPath}"; sleep 3.5; touch "${sideEffectPath}") </dev/null >/dev/null 2>&1 &`,
    `    for i in 1 2 3 4 5 6 7 8 9 10; do [ -f "${descendantReadyPath}" ] && break; sleep 0.02; done`,
    `    printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"finished"}}' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'`,
    `    touch "${parentEndedPath}"`,
    '    ;;',
    '  closed-desc-invalid|closed-desc-nonzero|closed-desc-protocol|closed-desc-abort)',
    `    (trap '' TERM; touch "${descendantReadyPath}"; sleep 3.5; touch "${sideEffectPath}") </dev/null >/dev/null 2>&1 &`,
    '    for i in 1 2 3 4 5 6 7 8 9 10; do',
    `      [ -f "${descendantReadyPath}" ] && break`,
    '      sleep 0.02',
    '    done',
    '    case "$(cat "' + modePath + '")" in',
    `      closed-desc-invalid) printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"invalid usage"}}' '{"type":"turn.completed","usage":{"input_tokens":-1,"output_tokens":1}}' ;;`,
    `      closed-desc-nonzero) printf '%s\\n' '{"type":"turn.started"}'; exit 7 ;;`,
    `      closed-desc-protocol) printf '%s\\n' '{"type":"turn.unknown"}' ;;`,
    `      closed-desc-abort) printf '%s\\n' '{"type":"turn.started"}'; wait ;;`,
    '    esac',
    '    ;;',
    '  item-ignore|item-success-after-error)',
    `    printf '%s\\n' '{"type":"item.started","item":{"type":"error","message":"unknown config setting model_max_output_tokens was ignored private-token=fixture"}}' '{"type":"item.started","item":{"type":"error","message":"unknown config setting model_max_output_tokens was ignored private-token=fixture"}}' '{"type":"turn.started"}'`,
    '    if [ "$(cat "' + modePath + '")" = item-success-after-error ]; then',
    `      printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"late success"}}' '{"type":"turn.completed"}'`,
    '    fi',
    '    ;;',
    '  item-auth|item-billing|item-model|item-rate|item-unknown)',
    '    case "$(cat "' + modePath + '")" in',
    `      item-auth) message='Not logged in. access_token=fixture-secret' ;;`,
    `      item-billing) message='billing_not_active: spend limit reached secret=fixture-secret' ;;`,
    `      item-model) message='model_not_found: unknown model secret=fixture-secret' ;;`,
    `      item-rate) message='HTTP 429 rate limit secret=fixture-secret' ;;`,
    `      *) message='provider item failed secret=fixture-secret' ;;`,
    '    esac',
    `    printf '{"type":"item.completed","item":{"type":"error","message":"%s"}}\\n' "$message"`,
    '    ;;',
    '  diagnostic-stubborn)',
    `    (trap '' TERM; touch "${descendantReadyPath}"; sleep 4; touch "${sideEffectPath}") &`,
    '    for i in 1 2 3 4 5 6 7 8 9 10; do',
    `      [ -f "${descendantReadyPath}" ] && break`,
    '      sleep 0.02',
    '    done',
    `    printf '%s\\n' '{"type":"item.started","item":{"type":"error","message":"unknown config setting model_max_output_tokens ignored"}}' '{"type":"turn.started"}'`,
    '    wait',
    '    ;;',
    '  auth)',
    `    printf '%s\\n' '{"type":"error","message":"Not logged in. Run codex login. access_token=fake-secret"}'`,
    '    exit 1',
    '    ;;',
    '  rate)',
    `    printf '%s\\n' '{"type":"turn.failed","error":{"message":"HTTP 429 rate limit fake-secret"}}'`,
    '    exit 1',
    '    ;;',
    '  billing)',
    `    printf '%s\\n' '{"type":"turn.failed","error":{"message":"billing_not_active: spend limit reached"}}'`,
    '    exit 1',
    '    ;;',
    '  model)',
    `    printf '%s\\n' '{"type":"error","message":"model_not_found: unknown model"}'`,
    '    exit 1',
    '    ;;',
    '  unsupported)',
    `    printf '%s\\n' '{"type":"error","message":"unknown option --ignore-rules"}'`,
    '    exit 1',
    '    ;;',
    '  unicode)',
    `    printf '%b' '{"type":"item.completed","item":{"type":"agent_message","text":"h\\303'`,
    '    sleep 0.03',
    `    printf '%b' '\\251llo 🌍"}}\\n{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}\\n'`,
    '    ;;',
    '  forbidden)',
    `    printf '%s\\n' '{"type":"item.completed","item":{"type":"command_execution","command":"touch bad"}}' '{"type":"turn.completed"}'`,
    '    ;;',
    '  early-forbidden)',
    `    printf '%s\\n' '{"type":"item.started","item":{"type":"command_execution","command":"touch forbidden"}}'`,
    '    sleep 0.2',
    `    touch "${sideEffectPath}"`,
    '    ;;',
    '  malformed)',
    `    printf '%s\\n' 'not-json'`,
    '    ;;',
    '  hang)',
    "    trap '' TERM",
    '    sleep 30',
    '    ;;',
    '  stubborn)',
    "    trap '' TERM",
    "    (trap '' TERM; exec sleep 30) &",
    '    wait',
    '    ;;',
    'esac',
  ].join('\n');
  writeFileSync(stubBin, stub);
  chmodSync(stubBin, 0o755);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function cleanCaptures(): void {
  for (const path of [argsPath, cwdPath, envPath, promptPath, startedPath, modePath, sideEffectPath, descendantReadyPath, parentEndedPath]) rmSync(path, { force: true });
}

function withStub<T>(mode: string, fn: () => T | Promise<T>, enabled = true): Promise<T> {
  cleanCaptures();
  writeFileSync(modePath, mode);
  return withEnv({
    GBRAIN_CODEX_CLI_BIN: stubBin,
    GBRAIN_PRIVATE_CODEX_CLI: enabled ? '1' : undefined,
    OPENAI_API_KEY: 'sk-must-not-reach-child',
    CODEX_API_KEY: 'codex-must-not-reach-child',
    CODEX_HOME: '/trusted/codex-home',
    HTTPS_PROXY: 'https://proxy.invalid:8443',
    NO_PROXY: 'localhost,.example.invalid',
    NODE_EXTRA_CA_CERTS: '/trusted/ca.pem',
    ANTHROPIC_API_KEY: 'should-not-inherit',
    AWS_SECRET_ACCESS_KEY: 'should-not-inherit',
    NODE_OPTIONS: '--require=/hostile/preload.js',
  }, fn);
}

function userMessage(text: string): LanguageModelV2CallOptions['prompt'][number] {
  return { role: 'user', content: [{ type: 'text', text }] };
}

describe('codex-cli recipe', () => {
  test('staged recipe stays out of public registry and model resolution', async () => {
    const { getRecipe, listRecipes } = await import('../src/core/ai/recipes/index.ts');
    const { codexCli } = await import('../src/core/ai/recipes/codex-cli.ts');
    expect(codexCli.id).toBe('codex-cli');
    expect(codexCli.touchpoints.chat).toBeDefined();
    expect(codexCli.touchpoints.expansion).toBeDefined();
    expect(getRecipe('codex-cli')).toBeUndefined();
    expect(listRecipes().some(recipe => recipe.id === 'codex-cli')).toBe(false);
    const { resolveRecipe } = await import('../src/core/ai/model-resolver.ts');
    expect(() => resolveRecipe('codex-cli:gpt-5.6-sol')).toThrow(AIConfigError);
  });

  test('keeps its adapter staged for direct deterministic testing', async () => {
    const { codexCli } = await import('../src/core/ai/recipes/codex-cli.ts');
    const recipe = codexCli;
    expect(recipe!.implementation).toBe('codex-cli');
    expect(recipe!.touchpoints.chat?.supports_tools).toBe(false);
    expect(recipe!.touchpoints.chat?.supports_subagent_loop).toBe(false);
    expect(recipe!.touchpoints.chat?.models).toContain('gpt-5.6-sol');
    expect(recipe!.touchpoints.expansion?.models).toContain('gpt-5.6-luna');
    expect(recipe!.touchpoints.embedding).toBeUndefined();
    expect(recipe!.aliases?.codex).toBe('gpt-5.6-sol');
  });

});

describe('CodexCliLanguageModel', () => {
  test('normalizes a successful JSONL turn and enforces the isolated argv/env/cwd contract', async () => {
    await withStub('success', async () => {
      const { CodexCliLanguageModel, CODEX_CLI_SCRATCH_PREFIX } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      const model = new CodexCliLanguageModel('codex-cli:gpt-5.6-sol');
      const result = await model.doGenerate({
        prompt: [
          { role: 'system', content: 'Be concise.' },
          userMessage('Say hello'),
        ],
        maxOutputTokens: 1,
      } as LanguageModelV2CallOptions);

      expect(model.modelId).toBe('gpt-5.6-sol');
      expect(result.content).toEqual([{ type: 'text', text: 'hello from codex' }]);
      expect(result.finishReason).toBe('stop');
      expect(result.content[0]?.type === 'text' ? result.content[0].text.length : 0).toBeGreaterThan(1);
      expect(result.usage).toEqual({
        inputTokens: 21,
        outputTokens: 13,
        totalTokens: 34,
        cachedInputTokens: 8,
        reasoningTokens: 3,
      });
      expect(result.usage).not.toHaveProperty('cacheWriteInputTokens');

      const args = readFileSync(argsPath, 'utf8').split(/\r?\n/).filter(Boolean);
      for (const flag of ['--no-daemon', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check']) {
        expect(args).toContain(flag);
      }
      expect(args).toContain('read-only');
      expect(args).toContain('shell_tool');
      expect(args).toContain('web_search="disabled"');
      expect(args).not.toContain('model_max_output_tokens=77');
      expect(result.warnings).toContainEqual(expect.objectContaining({
        type: 'unsupported-setting', setting: 'maxOutputTokens',
      }));
      const childEnv = readFileSync(envPath, 'utf8');
      expect(childEnv).toContain('PATH=');
      expect(childEnv).toContain('HOME=');
      expect(childEnv).not.toContain('OPENAI_API_KEY');
      expect(childEnv).not.toContain('CODEX_API_KEY');
      expect(childEnv).not.toContain('CODEX_STUB_MODE');
      expect(childEnv).toContain('CODEX_HOME=/trusted/codex-home');
      expect(childEnv).toContain('HTTPS_PROXY=https://proxy.invalid:8443');
      expect(childEnv).toContain('NO_PROXY=localhost,.example.invalid');
      expect(childEnv).toContain('NODE_EXTRA_CA_CERTS=/trusted/ca.pem');
      expect(childEnv).not.toContain('ANTHROPIC_API_KEY');
      expect(childEnv).not.toContain('AWS_SECRET_ACCESS_KEY');
      expect(childEnv).not.toContain('NODE_OPTIONS');
      expect(readFileSync(cwdPath, 'utf8')).toContain(CODEX_CLI_SCRATCH_PREFIX);
      const prompt = readFileSync(promptPath, 'utf8');
      expect(prompt).toContain('Be concise.');
      expect(prompt).toContain('User: Say hello');
      expect(prompt).toContain('Do not invoke shell commands');
    });
  });

  test('rejects GBrain tools before spawning Codex', async () => {
    await withStub('success', async () => {
      const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      const model = new CodexCliLanguageModel('gpt-5.6-sol');
      await expect(model.doGenerate({
        prompt: [userMessage('search')],
        tools: [{ type: 'function', name: 'search', inputSchema: { type: 'object' } }],
      } as LanguageModelV2CallOptions)).rejects.toBeInstanceOf(AIConfigError);
      expect(existsSync(startedPath)).toBe(false);
    });
  });

  test('rejects structured output and reports a missing executable', async () => {
    await withStub('success', async () => {
      const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      await expect(new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({
        prompt: [userMessage('hi')], responseFormat: { type: 'json', schema: { type: 'object' } },
      } as LanguageModelV2CallOptions)).rejects.toBeInstanceOf(AIConfigError);
      expect(existsSync(startedPath)).toBe(false);
    });
    await withEnv({ GBRAIN_CODEX_CLI_BIN: join(root, 'missing-codex'), GBRAIN_PRIVATE_CODEX_CLI: '1' }, async () => {
      const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      let caught: unknown;
      try { await new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({ prompt: [userMessage('hi')] } as LanguageModelV2CallOptions); }
      catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(AIConfigError);
      expect((caught as AIConfigError & { codexCliFailureKind?: string }).codexCliFailureKind).toBe('not_installed');
    });
  });

  test('disabled private gate rejects before scratch creation or subprocess spawn', async () => {
    await withStub('success', async () => {
      const { CodexCliLanguageModel, CODEX_CLI_SCRATCH_PREFIX } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      const scratchBefore = readdirSync(tmpdir()).filter(name => name.startsWith(CODEX_CLI_SCRATCH_PREFIX)).sort();
      let caught: unknown;
      try {
        await new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({
          prompt: [userMessage('hi')],
        } as LanguageModelV2CallOptions);
      } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(AIConfigError);
      expect((caught as AIConfigError & { codexCliFailureKind?: string }).codexCliFailureKind).toBe('private_disabled');
      expect(existsSync(startedPath)).toBe(false);
      expect(existsSync(cwdPath)).toBe(false);
      expect(readdirSync(tmpdir()).filter(name => name.startsWith(CODEX_CLI_SCRATCH_PREFIX)).sort()).toEqual(scratchBefore);
    }, false);
  });

  test('does not pass CODEX_HOME assigned by a cwd dotenv file', async () => {
    const previousCwd = process.cwd();
    writeFileSync(join(root, '.env'), 'CODEX_HOME=/planted/codex-home\n');
    process.chdir(root);
    try {
      await withStub('success', async () => {
        const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
        await new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({ prompt: [userMessage('hi')] } as LanguageModelV2CallOptions);
        expect(readFileSync(envPath, 'utf8')).not.toContain('CODEX_HOME=');
      });
    } finally {
      process.chdir(previousCwd);
      rmSync(join(root, '.env'), { force: true });
    }
  });

  test('classifies logged-out failures as secret-free config errors with Codex-owned remediation', async () => {
    await withStub('auth', async () => {
      const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      let caught: unknown;
      try {
        await new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({ prompt: [userMessage('hi')] } as LanguageModelV2CallOptions);
      } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(AIConfigError);
      const error = caught as AIConfigError;
      expect(error.message).toContain('not authenticated');
      expect(error.fix).toContain('codex login');
      expect(JSON.stringify(error)).not.toContain('fake-secret');
      expect(error.cause).toBeUndefined();
    });
  });

  test('classifies rate limits as transient without exposing provider output', async () => {
    await withStub('rate', async () => {
      const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      let caught: unknown;
      try {
        await new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({ prompt: [userMessage('hi')] } as LanguageModelV2CallOptions);
      } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(AITransientError);
      const error = caught as AITransientError;
      expect(error.apiErrorStatus).toBe(429);
      expect(JSON.stringify(error)).not.toContain('fake-secret');
      expect(error.cause).toBeUndefined();
    });
  });

  test('classifies structured billing, model, and unsupported-CLI errors', async () => {
    const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
    for (const [mode, status, kind] of [['billing', 402, 'billing'], ['model', 404, 'model'], ['unsupported', undefined, 'unsupported_cli']] as const) {
      await withStub(mode, async () => {
        let caught: unknown;
        try { await new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({ prompt: [userMessage('hi')] } as LanguageModelV2CallOptions); }
        catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(AIConfigError);
        expect((caught as AIConfigError & { apiErrorStatus?: number; codexCliFailureKind?: string }).apiErrorStatus).toBe(status);
        expect((caught as AIConfigError & { codexCliFailureKind?: string }).codexCliFailureKind).toBe(kind);
      });
    }
  });

  test('treats JSONL error items as fatal, secret-free diagnostics and preserves the first classification', async () => {
    const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
    for (const [mode, kind, errorClass] of [
      ['item-ignore', 'unsupported_cli', AIConfigError],
      ['item-success-after-error', 'unsupported_cli', AIConfigError],
      ['item-auth', 'not_logged_in', AIConfigError],
      ['item-billing', 'billing', AIConfigError],
      ['item-model', 'model', AIConfigError],
      ['item-rate', 'rate_limit', AITransientError],
      ['item-unknown', 'transport', AITransientError],
    ] as const) {
      await withStub(mode, async () => {
        let caught: unknown;
        try { await new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({ prompt: [userMessage('hi')] } as LanguageModelV2CallOptions); }
        catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(errorClass);
        expect((caught as AIConfigError & { codexCliFailureKind?: string }).codexCliFailureKind).toBe(kind);
        expect(JSON.stringify(caught)).not.toContain('fixture-secret');
        expect(JSON.stringify(caught)).not.toContain('private-token');
        if (mode === 'item-success-after-error') expect((caught as Error).message).not.toContain('late success');
      });
    }
  });

  test('diagnostic failure terminates a stubborn descendant before its delayed side effect', async () => {
    await withStub('diagnostic-stubborn', async () => {
      const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      let caught: unknown;
      try { await new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({ prompt: [userMessage('hi')] } as LanguageModelV2CallOptions); }
      catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(AIConfigError);
      expect((caught as AIConfigError & { codexCliFailureKind?: string }).codexCliFailureKind).toBe('unsupported_cli');
      expect(existsSync(descendantReadyPath)).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 4_300));
      expect(existsSync(sideEffectPath)).toBe(false);
    });
  }, 10_000);

  test('requires complete valid token usage on a successful turn', async () => {
    const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
    for (const mode of ['missing-usage', 'negative-usage', 'bad-cached-usage']) {
      await withStub(mode, async () => {
        let caught: unknown;
        try { await new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({ prompt: [userMessage('hi')] } as LanguageModelV2CallOptions); }
        catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(AITransientError);
        expect((caught as AITransientError & { codexCliFailureKind?: string }).codexCliFailureKind).toBe('protocol');
      });
    }
    await withStub('duplicate-completion', async () => {
      let caught: unknown;
      try { await new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({ prompt: [userMessage('hi')] } as LanguageModelV2CallOptions); }
      catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(AITransientError);
      expect((caught as AITransientError & { codexCliFailureKind?: string }).codexCliFailureKind).toBe('protocol');
    });
  });

  test('accepts split UTF-8, CRLF framing, final unterminated JSONL, and final diagnostics', async () => {
    const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
    await withStub('framing', async () => {
      const result = await new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({ prompt: [userMessage('hi')] } as LanguageModelV2CallOptions);
      expect(result.content).toEqual([{ type: 'text', text: 'CRLF and final' }]);
      expect(result.usage).toMatchObject({ inputTokens: 4, outputTokens: 5 });
    });
    await withStub('final-diagnostic', async () => {
      let caught: unknown;
      try { await new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({ prompt: [userMessage('hi')] } as LanguageModelV2CallOptions); }
      catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(AIConfigError);
      expect((caught as AIConfigError & { codexCliFailureKind?: string }).codexCliFailureKind).toBe('not_logged_in');
      expect(JSON.stringify(caught)).not.toContain('final-secret');
    });
  });

  test('rejects unknown lifecycle events and activity-bearing item shapes', async () => {
    const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
    for (const mode of ['unknown-event', 'unknown-field', 'unknown-item', 'todo-list']) {
      await withStub(mode, async () => {
        let caught: unknown;
        try { await new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({ prompt: [userMessage('hi')] } as LanguageModelV2CallOptions); }
        catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(AITransientError);
        expect((caught as AITransientError & { codexCliFailureKind?: string }).codexCliFailureKind).toBe('protocol');
        if (mode === 'todo-list') expect((caught as Error).message).toContain('unsupported native planning activity');
      });
    }
  });

  test('bounds stdout and stderr without leaking their contents', async () => {
    const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
    for (const mode of ['stdout-overflow', 'stderr-overflow']) {
      await withStub(mode, async () => {
        let caught: unknown;
        try { await new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({ prompt: [userMessage('hi')] } as LanguageModelV2CallOptions); }
        catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(AITransientError);
        expect((caught as Error).message).not.toContain('xxxxx');
      });
    }
  });

  test('waits for stubborn descendants after successful parent stdio closes', async () => {
    await withStub('success-descendant', async () => {
      const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      const started = Date.now();
      const result = await new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({ prompt: [userMessage('hi')] } as LanguageModelV2CallOptions);
      expect(result.content).toEqual([{ type: 'text', text: 'finished' }]);
      expect(Date.now() - started).toBeGreaterThanOrEqual(2_500);
      expect(existsSync(descendantReadyPath)).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 1_300));
      expect(existsSync(sideEffectPath)).toBe(false);
    });
  }, 10_000);

  test('awaits closed-stdio descendant cleanup on invalid usage, nonzero exit, protocol failure, and abort', async () => {
    const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
    const cases = [
      ['closed-desc-invalid', 'protocol'],
      ['closed-desc-nonzero', 'transport'],
      ['closed-desc-protocol', 'protocol'],
      ['closed-desc-abort', 'aborted'],
    ] as const;
    for (const [mode, kind] of cases) {
      await withStub(mode, async () => {
        const controller = new AbortController();
        const pending = new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({
          prompt: [userMessage('hi')], ...(mode === 'closed-desc-abort' ? { abortSignal: controller.signal } : {}),
        } as LanguageModelV2CallOptions);
        if (mode === 'closed-desc-abort') {
          for (let i = 0; i < 150 && !existsSync(descendantReadyPath); i++) await new Promise(resolve => setTimeout(resolve, 10));
          expect(existsSync(descendantReadyPath)).toBe(true);
          controller.abort();
        }
        let caught: unknown;
        try { await pending; } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(AITransientError);
        expect((caught as AITransientError & { codexCliFailureKind?: string }).codexCliFailureKind).toBe(kind);
        expect(existsSync(descendantReadyPath)).toBe(true);
        await new Promise(resolve => setTimeout(resolve, 600));
        expect(existsSync(sideEffectPath)).toBe(false);
      });
    }
  }, 20_000);

  test('abort arriving during successful descendant cleanup overrides success', async () => {
    await withStub('success-descendant', async () => {
      const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      const controller = new AbortController();
      const pending = new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({
        prompt: [userMessage('hi')], abortSignal: controller.signal,
      } as LanguageModelV2CallOptions);
      for (let i = 0; i < 150 && !existsSync(parentEndedPath); i++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(existsSync(parentEndedPath)).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 50));
      controller.abort();
      let caught: unknown;
      try { await pending; } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(AITransientError);
      expect((caught as AITransientError & { codexCliFailureKind?: string }).codexCliFailureKind).toBe('aborted');
      await new Promise(resolve => setTimeout(resolve, 600));
      expect(existsSync(sideEffectPath)).toBe(false);
    });
  }, 10_000);

  test('preserves Unicode output and rejects forbidden tool activity', async () => {
    const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
    await withStub('unicode', async () => {
      expect((await new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({ prompt: [userMessage('hi')] } as LanguageModelV2CallOptions)).content)
        .toEqual([{ type: 'text', text: 'héllo 🌍' }]);
    });
    await withStub('forbidden', async () => {
      await expect(new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({ prompt: [userMessage('hi')] } as LanguageModelV2CallOptions))
        .rejects.toBeInstanceOf(AITransientError);
    });
  });

  test('immediately stops on item.started forbidden activity before later side effects', async () => {
    await withStub('early-forbidden', async () => {
      const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      let caught: unknown;
      try { await new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({ prompt: [userMessage('hi')] } as LanguageModelV2CallOptions); }
      catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(AITransientError);
      expect((caught as AITransientError & { codexCliFailureKind?: string }).codexCliFailureKind).toBe('protocol');
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(existsSync(sideEffectPath)).toBe(false);
    });
  });

  test('treats malformed JSONL as a transient protocol failure', async () => {
    await withStub('malformed', async () => {
      const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      await expect(
        new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({ prompt: [userMessage('hi')] } as LanguageModelV2CallOptions),
      ).rejects.toBeInstanceOf(AITransientError);
    });
  });

  test('a pre-aborted request never spawns or creates observable child work', async () => {
    await withStub('success', async () => {
      const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      const controller = new AbortController();
      controller.abort();
      await expect(new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({
        prompt: [userMessage('hi')],
        abortSignal: controller.signal,
      } as LanguageModelV2CallOptions)).rejects.toBeInstanceOf(AITransientError);
      expect(existsSync(startedPath)).toBe(false);
    });
  });

  test('active abort escalates process-group termination and cleans the scratch cwd', async () => {
    await withStub('stubborn', async () => {
      const { CodexCliLanguageModel } = await import('../src/core/ai/providers/codex-cli-language-model.ts');
      const controller = new AbortController();
      const pending = new CodexCliLanguageModel('gpt-5.6-sol').doGenerate({
        prompt: [userMessage('hi')], abortSignal: controller.signal,
      } as LanguageModelV2CallOptions);
      for (let i = 0; i < 100 && !existsSync(startedPath); i++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(existsSync(startedPath)).toBe(true);
      const scratch = readFileSync(cwdPath, 'utf8').trim();
      controller.abort();
      await expect(pending).rejects.toBeInstanceOf(AITransientError);
      expect(existsSync(scratch)).toBe(false);
    });
  });

});
