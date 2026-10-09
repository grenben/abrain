import { beforeEach, afterAll, describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPrivateCodexConfig } from '../../src/core/ai/private-policy.ts';
import { resolveModelDetailed } from '../../src/core/model-config.ts';
import { configureGateway, chat, getChatModel, getExpansionModel, resetGateway } from '../../src/core/ai/gateway.ts';
import { invokeAI } from '../../src/core/ai/invocation-guard.ts';
import { makeSubagentHandler } from '../../src/core/minions/handlers/subagent.ts';
const root = mkdtempSync(join(tmpdir(), 'private-policy-'));
mkdirSync(join(root,'.gbrain'));
const oldHome = process.env.GBRAIN_HOME, oldModel = process.env.GBRAIN_MODEL;
const privateConfig = { private_codex: { mode: 'strict', model: 'codex-cli:gpt-test', bin: '/synthetic/codex' } };
function save(value: unknown) { writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify(value)); }
beforeEach(() => { process.env.GBRAIN_HOME = root; delete process.env.GBRAIN_MODEL; save(privateConfig); });
afterAll(() => {
  if (oldHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME=oldHome;
  if (oldModel === undefined) delete process.env.GBRAIN_MODEL; else process.env.GBRAIN_MODEL=oldModel;
  resetGateway(); rmSync(root, { recursive: true, force: true });
});
describe('strict private routing', () => {
  test('unset generative defaults select the configured Codex model without native-tool substitution', async () => {
    expect(await resolveModelDetailed(null, { tier: 'subagent', fallback: 'anthropic:claude-test' })).toEqual({model:'codex-cli:gpt-test',source:'private_default'});
    configureGateway({env:{}}); expect(getChatModel()).toBe('codex-cli:gpt-test'); expect(getExpansionModel()).toBe('codex-cli:gpt-test');
  });
  test.each(['anthropic:claude-test','openrouter:anthropic/claude-test','claude-cli:test','openai:gpt-test','proxy:gpt-test','sonnet'])('rejects explicit %s before dispatch', async model => {
    await expect(resolveModelDetailed(null,{cliFlag:model,fallback:'irrelevant'})).rejects.toMatchObject({source:'cli:model'});
    let calls=0;
    await expect(invokeAI({operation:'fixture',kind:'chat',model}, async()=>{calls++;},()=>null)).rejects.toMatchObject({source:'fixture'});
    expect(calls).toBe(0);
  });
  test('checks shadowed DB pins and does not let a CLI flag hide a conflict', async () => {
    const engine = { getConfig: async (key:string) => key==='models.default' ? 'anthropic:fixture' : null };
    await expect(resolveModelDetailed(engine,{cliFlag:'codex-cli:gpt-test',fallback:'unused'})).rejects.toMatchObject({source:'db:models.default'});
  });
  test('rejects environment pins and file pins with their source', async () => {
    process.env.GBRAIN_MODEL='openai:fixture';
    await expect(resolveModelDetailed(null,{fallback:'unused'})).rejects.toMatchObject({source:'env:GBRAIN_MODEL'});
    expect(()=>configureGateway({env:{},chat_model:'anthropic:fixture'})).toThrow('config:chat_model');
  });
  test('forbidden gateway route never reaches even a transport; legacy client is not constructed', async () => {
    configureGateway({env:{}});
    await expect(chat({model:'anthropic:fixture',messages:[]})).rejects.toMatchObject({source:'gateway.chat'});
    let constructed=0;
    const handler=makeSubagentHandler({engine:{} as any, makeAnthropic:()=>{constructed++;throw new Error('tripwire');}});
    await expect(handler({} as any)).rejects.toMatchObject({code:'private_native_loop_unsupported'});
    expect(constructed).toBe(0);
  });
  test('DB cannot activate private mode; ordinary resolver retains its behavior', async () => {
    save({}); expect(readPrivateCodexConfig()).toBeUndefined();
    expect(await resolveModelDetailed({getConfig:async()=>null},{cliFlag:'openai:gpt-test',fallback:'unused'})).toEqual({model:'openai:gpt-test',source:'cli_flag'});
  });
  test('malformed operator configuration is never a paid-provider fallback', () => {
    writeFileSync(join(root,'.gbrain','config.json'),'{'); expect(readPrivateCodexConfig).toThrow('private_config_invalid');
    save({private_codex:{...privateConfig.private_codex,mode:'typo'}}); expect(readPrivateCodexConfig).toThrow('private_config_invalid');
  });
});
