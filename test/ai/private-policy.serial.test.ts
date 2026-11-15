import { beforeEach, afterAll, describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPrivateCodexConfig } from '../../src/core/ai/private-policy.ts';
import { auditPrivateRoutes } from '../../src/core/ai/private-route-audit.ts';
import { runDecide, hasTypesafeKey, loadDecideConfig } from '../../src/core/ai/decide/index.ts';
import { readDecideConfig } from '../../src/core/ai/decide/config.ts';
import { resolveModelDetailed } from '../../src/core/model-config.ts';
import { configureGateway, chat, getChatModel, getExpansionModel, resetGateway, __setChatTransportForTests, __setDecideTransportForTests } from '../../src/core/ai/gateway.ts';
import { invokeAI } from '../../src/core/ai/invocation-guard.ts';
import { makeSubagentHandler } from '../../src/core/minions/handlers/subagent.ts';
import { resolveSkillOptModelRole } from '../../src/core/skillopt/models-plan.ts';
const root = mkdtempSync(join(tmpdir(), 'private-policy-'));
mkdirSync(join(root,'.gbrain'));
const oldHome = process.env.GBRAIN_HOME, oldModel = process.env.GBRAIN_MODEL;
const privateConfig = { private_codex: { mode: 'strict', model: 'codex-cli:gpt-test', bin: '/synthetic/codex' } };
function save(value: unknown) { writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify(value)); }
beforeEach(() => { process.env.GBRAIN_HOME = root; delete process.env.GBRAIN_MODEL; save(privateConfig); });
afterAll(() => {
  __setChatTransportForTests(null); __setDecideTransportForTests(null);
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
  test('a Codex CLI model cannot hide a forbidden file pin on another generative role', async () => {
    save({ ...privateConfig, embedding_image_ocr_model: 'anthropic:fixture' });
    await expect(resolveModelDetailed(null, { cliFlag: 'codex-cli:gpt-test', fallback: 'unused' })).rejects.toMatchObject({ source: 'file:embedding_image_ocr_model' });
    let calls = 0;
    await expect(invokeAI({ operation: 'fixture', kind: 'chat', model: 'codex-cli:gpt-test' }, async () => { calls++; }, () => null)).rejects.toMatchObject({ source: 'file:embedding_image_ocr_model' });
    expect(calls).toBe(0);
  });
  test('rejects environment pins and file pins with their source', async () => {
    process.env.GBRAIN_MODEL='openai:fixture';
    await expect(resolveModelDetailed(null,{fallback:'unused'})).rejects.toMatchObject({source:'env:GBRAIN_MODEL'});
    delete process.env.GBRAIN_MODEL;
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
  test('shared decision runner refuses paid providers before query or search dispatch', async () => {
    let calls = 0;
    configureGateway({ env: { TYPESAFE_API_KEY: 'synthetic' } });
    __setDecideTransportForTests(async () => { calls++; return new Response('{}'); });
    __setChatTransportForTests(async () => { calls++; throw new Error('unexpected chat transport'); });
    try {
      const config = readDecideConfig({ 'decide.provider': 'typesafe:jev-1.13.0', 'decide.slots.intent.mode': 'on' });
      for (const [provider, slot, callSite] of [
        ['typesafe:jev-1.13.0', 'intent', 'search'], ['llm:openai:gpt-test', 'answerable', 'query'],
      ] as const) {
        const question = slot === 'answerable'
          ? { id: 'q:0', kind: 'noul' as const, instructions: 'Is there evidence?' }
          : { id: 'q:0', kind: 'choice' as const, instructions: 'Classify.', options: { other: 'Other' } };
        await expect(runDecide({ slot, callSite, provider, state: { query: { class: 'query', text: 'test' } }, questions: [question] },
          { engine: null, config })).rejects.toMatchObject({ source: 'decide:provider', code: 'private_route_conflict' });
      }
      expect(calls).toBe(0);
    } finally {
      __setChatTransportForTests(null); __setDecideTransportForTests(null);
    }
  });
  test('private decision fallback cannot point to an ordinary LLM', async () => {
    const config = readDecideConfig({ 'decide.provider': 'llm:codex-cli:gpt-test', 'decide.egress_fallback': 'llm:openai:gpt-test' });
    await expect(runDecide({ slot: 'intent', callSite: 'search', state: {}, questions: [{ id: 'q', kind: 'noul', instructions: 'Check.' }] },
      { engine: null, config })).rejects.toMatchObject({ source: 'decide:provider', code: 'private_route_conflict' });
  });
  test('a leftover TypeSafe key cannot activate private default decision slots', async () => {
    configureGateway({ env: { TYPESAFE_API_KEY: 'synthetic' } });
    expect(hasTypesafeKey()).toBe(false);
    const config = await loadDecideConfig(null);
    expect(Object.values(config.slots).every(slot => slot.mode === 'off')).toBe(true);
  });
  test('DB cannot activate private mode; ordinary resolver retains its behavior', async () => {
    save({}); expect(readPrivateCodexConfig()).toBeUndefined();
    expect(await resolveModelDetailed({getConfig:async()=>null},{cliFlag:'openai:gpt-test',fallback:'unused'})).toEqual({model:'openai:gpt-test',source:'cli_flag'});
  });
  test('malformed operator configuration is never a paid-provider fallback', () => {
    writeFileSync(join(root,'.gbrain','config.json'),'{'); expect(readPrivateCodexConfig).toThrow('private_config_invalid');
    save({private_codex:{...privateConfig.private_codex,mode:'typo'}}); expect(readPrivateCodexConfig).toThrow('private_config_invalid');
  });
  // Tiered activation must select the role's model and deny unfinished callers.
  // The scalar-policy cases above cannot detect cross-tier routing or missing
  // role identity. These tests use the public resolver/gateway, without a seam.
  const tiered = { mode: 'strict', bin: '/synthetic/codex', models: {
    utility: 'codex-cli:utility-test', reasoning: 'codex-cli:reasoning-test',
    deep: 'codex-cli:deep-test', subagent: 'codex-cli:action-test',
  }, enabled_roles: ['chat', 'think', 'query-expansion', 'ocr'] };
  test('tiered configuration selects each tier through the normal resolver', async () => {
    save({ private_codex: tiered });
    for (const [tier, model] of Object.entries(tiered.models)) {
      expect(await resolveModelDetailed(null, { tier: tier as any, fallback: 'anthropic:unused' }))
        .toEqual({ model, source: 'private_default' });
    }
    configureGateway({ env: {} });
    expect(getChatModel()).toBe(tiered.models.reasoning);
    expect(getExpansionModel()).toBe(tiered.models.utility);
  });
  test('bootstrap resolves its own private role while retaining the optimizer CLI pin origin', async () => {
    save({ private_codex: { ...tiered, enabled_roles: ['skillopt-bootstrap'] } });
    expect(await resolveSkillOptModelRole(null, { optimizerModel: tiered.models.deep }, 'optimizer', 'skillopt-bootstrap'))
      .toEqual({ model: tiered.models.deep, source: 'cli_flag', origin: '--optimizer-model' });
    await expect(resolveSkillOptModelRole(null, { optimizerModel: tiered.models.deep }, 'optimizer'))
      .rejects.toMatchObject({ code: 'private_role_disabled', source: 'role:skillopt-optimizer' });
  });
  test('tier pins are checked even when a matching CLI value shadows them', async () => {
    save({ private_codex: tiered });
    const engine = { getConfig: async (key: string) => key === 'models.tier.deep' ? tiered.models.utility : null };
    await expect(resolveModelDetailed(engine, { tier: 'deep', cliFlag: tiered.models.deep, fallback: 'unused' }))
      .rejects.toMatchObject({ source: 'db:models.tier.deep', code: 'private_route_conflict' });
  });
  test('tiered gateway rejects missing identity, disabled roles and cross-tier models before admission', async () => {
    save({ private_codex: tiered });
    configureGateway({ env: {} });
    await expect(chat({ messages: [] })).rejects.toMatchObject({ code: 'private_role_required' });
    await expect(chat({ messages: [], privateRole: 'brainstorm' } as any)).rejects.toMatchObject({ code: 'private_role_disabled' });
    await expect(chat({ messages: [], privateRole: 'think', model: tiered.models.utility } as any))
      .rejects.toMatchObject({ code: 'private_route_conflict' });
    await expect(chat({ messages: [], privateRole: 'think', model: tiered.models.deep } as any))
      .rejects.toMatchObject({ code: 'subscription_required' });
  });
  test('gateway configuration can retain matching pins while every role is disabled', async () => {
    save({ private_codex: { ...tiered, enabled_roles: [] } });
    configureGateway({ env: {}, chat_fallback_chain: [tiered.models.reasoning] });
    await expect(chat({ messages: [], privateRole: 'chat' }))
      .rejects.toMatchObject({ code: 'private_role_disabled' });
    expect(() => configureGateway({ env: {}, chat_fallback_chain: [tiered.models.deep] }))
      .toThrow('config:chat_fallback_chain');
  });
  test('tiered file pins match their own role, and a global pin cannot collapse distinct tiers', async () => {
    save({ private_codex: tiered, chat_model: tiered.models.reasoning, expansion_model: tiered.models.utility });
    expect((await resolveModelDetailed(null, { tier: 'deep', fallback: 'unused' })).model).toBe(tiered.models.deep);
    save({ private_codex: tiered, expansion_model: tiered.models.reasoning });
    await expect(resolveModelDetailed(null, { tier: 'deep', fallback: 'unused' })).rejects.toMatchObject({ source: 'file:expansion_model' });
    save({ private_codex: tiered });
    process.env.GBRAIN_MODEL = tiered.models.reasoning;
    await expect(resolveModelDetailed(null, { tier: 'deep', fallback: 'unused' })).rejects.toMatchObject({ source: 'env:GBRAIN_MODEL' });
  });
  test('tiered policy refuses missing slots, unknown roles and ambiguous scalar configuration', () => {
    for (const config of [
      { ...tiered, models: { utility: tiered.models.utility } },
      { ...tiered, enabled_roles: ['missing-role'] },
      { ...tiered, enabled_roles: ['chat', 'chat'] },
      { ...tiered, enabled_roles: undefined },
      { ...tiered, model: tiered.models.reasoning },
    ]) {
      save({ private_codex: config });
      expect(readPrivateCodexConfig).toThrow('private_config_invalid');
    }
  });
  test('tiered audit separates requested activation and release scope from acceptance', async () => {
    save({ private_codex: tiered });
    const audit = await auditPrivateRoutes();
    expect(audit.model_policy).toBe('tiered');
    expect(audit.roles.filter(role => role.release === 'core')).toHaveLength(21);
    expect(audit.roles.filter(role => role.release === 'extended')).toHaveLength(18);
    expect(audit.roles.find(role => role.role === 'think')).toMatchObject({
      tier: 'deep', policy_model: tiered.models.deep, activation_requested: true,
      actual_dispatch: 'unverified', feature_acceptance: 'unverified',
    });
    expect(audit.roles.find(role => role.role === 'brainstorm')).toMatchObject({
      tier: 'deep', policy_model: tiered.models.deep, activation_requested: false,
    });
    expect(audit.activated).toBe(false); expect(audit.coverage.complete).toBe(false);
  });
});
