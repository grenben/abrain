import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runProviders } from '../src/commands/providers.ts';
import {
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

const privateModel = 'codex-cli:gpt-5-codex';
const unknownModel = 'not-a-public-provider:model';
let home: string;
let transportCalls: number;
const originalExit = process.exit;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-providers-public-model-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  transportCalls = 0;
  __setChatTransportForTests(async () => {
    transportCalls++;
    throw new Error('private/unknown model reached chat transport');
  });
  __setEmbedTransportForTests(async () => {
    transportCalls++;
    throw new Error('private/unknown model reached embed transport');
  });
  process.exit = (() => { throw new Error('providers rejected model'); }) as never;
});

afterEach(() => {
  process.exit = originalExit;
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
  rmSync(home, { recursive: true, force: true });
});

describe('providers test public model boundary', () => {
  for (const [model, touchpoint, env] of [
    ['OPENAI/gpt-4o-mini', 'chat', { OPENAI_API_KEY: 'test-key' }],
    ['openai : gpt-4o-mini', 'chat', { OPENAI_API_KEY: 'test-key' }],
    ['openai/text-embedding-3-small', 'embedding', { OPENAI_API_KEY: 'test-key' }],
    ['openrouter:anthropic/claude-sonnet-4.6', 'chat', { OPENROUTER_API_KEY: 'test-key' }],
  ] as const) {
    test(`allows normalized public model ${model} to reach gateway transport`, async () => {
      await withEnv({ GBRAIN_HOME: home, ...env }, async () => {
        await expect(runProviders('test', ['--touchpoint', touchpoint, '--model', model]))
          .rejects.toThrow('providers rejected model');
      });
      expect(transportCalls).toBe(1);
    });
  }

  for (const gate of ['0', '1']) {
    for (const model of [privateModel, unknownModel]) {
      test(`rejects explicit ${model} with private CLI gate=${gate} before gateway transport`, async () => {
        await withEnv({ GBRAIN_HOME: home, GBRAIN_PRIVATE_CODEX_CLI: gate }, async () => {
          await expect(runProviders('test', ['--touchpoint', 'chat', '--model', model]))
            .rejects.toThrow('providers rejected model');
        });
        expect(transportCalls).toBe(0);
      });

      test(`rejects configured ${model} with private CLI gate=${gate} before gateway transport`, async () => {
        writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ chat_model: model }));
        await withEnv({ GBRAIN_HOME: home, GBRAIN_PRIVATE_CODEX_CLI: gate }, async () => {
          await expect(runProviders('test', ['--touchpoint', 'chat']))
            .rejects.toThrow('providers rejected model');
        });
        expect(transportCalls).toBe(0);
      });
    }
  }
});
