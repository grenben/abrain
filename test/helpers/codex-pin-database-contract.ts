/** Protect transactional pin cutover/rollback on real config storage. Removing CAS or
 * atomic receipt coupling must fail; prior routing tests never mutated pins. No new seam. */
import { beforeAll, beforeEach, afterAll, test, expect, spyOn } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { previewDatabasePins, applyDatabasePins, rollbackDatabasePins } from '../../src/core/ai/private-pin-database.ts';

export function codexPinDatabaseContract(factory: () => Promise<{ engine: BrainEngine; cleanup?: () => Promise<void> }>, ownsEngine = true) {
  let engine: BrainEngine, cleanup: (() => Promise<void>) | undefined;
  const target = 'codex-cli:gpt-fixture';
  beforeAll(async () => { ({ engine, cleanup } = await factory()); await engine.initSchema(); });
  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM codex_upgrade_receipts');
    for (const [key, value] of Object.entries({ 'models.default': 'anthropic:fixture', 'models.tier.utility': 'haiku',
      chat_fallback_chain: 'anthropic:fixture,openai:fixture', embedding_model: 'voyage:fixture', 'search.reranker.model': 'cohere:fixture',
      anthropic_api_key: 'SYNTHETIC_CREDENTIAL_CANARY', 'cycle.max_usd': '3' })) await engine.setConfig(key, value);
  });
  afterAll(async () => { if (ownsEngine) await engine?.disconnect(); await cleanup?.(); });
  test('database preview changes nothing and excludes credentials and auxiliary inference', async () => {
    const p = await previewDatabasePins(engine, target);
    expect(p.changes.map(c => c.key)).toEqual(['chat_fallback_chain','models.default','models.tier.utility']);
    expect(JSON.stringify(p)).not.toContain('SYNTHETIC_CREDENTIAL_CANARY');
    expect(await engine.getConfig('models.default')).toBe('anthropic:fixture');
    expect(await engine.executeRaw('SELECT id FROM codex_upgrade_receipts')).toHaveLength(0);
  });
  test('apply and rollback retain one atomic receipt and preserve unrelated settings', async () => {
    const p = await previewDatabasePins(engine, target), applied = await applyDatabasePins(engine, target, p.plan_hash);
    expect(applied.state).toBe('applied'); expect(await engine.getConfig('models.default')).toBe(target);
    expect(await engine.getConfig('chat_fallback_chain')).toBe(target);
    expect(await engine.getConfig('embedding_model')).toBe('voyage:fixture');
    expect(await engine.getConfig('search.reranker.model')).toBe('cohere:fixture');
    expect(await engine.getConfig('anthropic_api_key')).toBe('SYNTHETIC_CREDENTIAL_CANARY');
    expect(await engine.getConfig('cycle.max_usd')).toBe('3');
    expect(await applyDatabasePins(engine, target, p.plan_hash)).toEqual(applied);
    expect((await rollbackDatabasePins(engine, applied.id, p.plan_hash)).state).toBe('rolled_back');
    expect(await engine.getConfig('models.default')).toBe('anthropic:fixture');
    expect(await engine.getConfig('chat_fallback_chain')).toBe('anthropic:fixture,openai:fixture');
    expect((await rollbackDatabasePins(engine, applied.id, p.plan_hash)).state).toBe('rolled_back');
    expect(await engine.executeRaw('SELECT id FROM codex_upgrade_receipts')).toHaveLength(1);
    expect((await previewDatabasePins(engine, target)).plan_hash).not.toBe(p.plan_hash);
  });
  test('pin drift before apply and rollback cannot overwrite another configuration change', async () => {
    const p = await previewDatabasePins(engine, target);
    await engine.setConfig('models.tier.utility', 'openai:changed');
    await expect(applyDatabasePins(engine, target, p.plan_hash)).rejects.toThrow('preview_changed');
    expect(await engine.getConfig('models.default')).toBe('anthropic:fixture');
    const next = await previewDatabasePins(engine, target), r = await applyDatabasePins(engine, target, next.plan_hash);
    await engine.setConfig('models.default', 'openai:operator-change');
    await expect(rollbackDatabasePins(engine, r.id, next.plan_hash)).rejects.toThrow('configuration_changed');
    expect(await engine.getConfig('models.default')).toBe('openai:operator-change');
  });
  test('failure while recording the receipt rolls back every changed pin', async () => {
    const p = await previewDatabasePins(engine, target), transaction = engine.transaction.bind(engine);
    const fault = spyOn(engine, 'transaction').mockImplementation(run => transaction(async tx => {
      const execute = tx.executeRaw.bind(tx), failure = spyOn(tx, 'executeRaw').mockImplementation((sql, ...args) => {
        if (sql.startsWith('INSERT INTO codex_upgrade_receipts')) throw new Error('synthetic receipt failure');
        return execute(sql, ...args);
      });
      try { return await run(tx); } finally { failure.mockRestore(); }
    }));
    try { await expect(applyDatabasePins(engine, target, p.plan_hash)).rejects.toThrow('synthetic receipt failure'); } finally { fault.mockRestore(); }
    expect(await engine.getConfig('models.default')).toBe('anthropic:fixture');
    expect(await engine.getConfig('chat_fallback_chain')).toBe('anthropic:fixture,openai:fixture');
    expect(await engine.executeRaw('SELECT id FROM codex_upgrade_receipts')).toHaveLength(0);
  });
  test('concurrent applications of the same reviewed plan return the same receipt', async () => {
    const p = await previewDatabasePins(engine, target);
    const [a, b] = await Promise.all([applyDatabasePins(engine, target, p.plan_hash), applyDatabasePins(engine, target, p.plan_hash)]);
    expect(a.id).toBe(b.id); expect(await engine.executeRaw('SELECT id FROM codex_upgrade_receipts')).toHaveLength(1);
  });
  test('malformed model values and non-Codex targets fail without echoing values', async () => {
    await engine.setConfig('models.default', 'SYNTHETIC_PRIVATE_INVALID_VALUE');
    try { await previewDatabasePins(engine, target); throw new Error('expected refusal'); }
    catch (error) { expect(String(error)).toContain('invalid_pin:models.default'); expect(String(error)).not.toContain('SYNTHETIC_PRIVATE_INVALID_VALUE'); }
    await expect(previewDatabasePins(engine, 'openai:fixture')).rejects.toThrow('invalid_target');
    expect(await engine.executeRaw('SELECT id FROM codex_upgrade_receipts')).toHaveLength(0);
  });
  // Real config deletion/replay is the regression: one scalar models.default
  // cannot serve distinct tiers, and rollback must restore the retired pin.
  test('tiered plans map role pins and reversibly retire the conflicting global default', async () => {
    const tiers = { utility: 'codex-cli:utility', reasoning: 'codex-cli:reasoning', deep: 'codex-cli:deep', subagent: 'codex-cli:subagent' };
    const keys = { 'models.dream.synthesize': 'reasoning', 'models.think': 'deep', 'models.subagent': 'subagent',
      'contextual_retrieval.haiku_model': 'utility', 'embedding_image_ocr_model': 'reasoning' } as const;
    try {
      for (const key of Object.keys(keys)) await engine.setConfig(key, 'anthropic:fixture');
      const p = await previewDatabasePins(engine, tiers); expect(p.version).toBe(2);
      expect(p.changes.find(c => c.key === 'models.default')!.after).toBeNull();
      const applied = await applyDatabasePins(engine, tiers, p.plan_hash);
      expect(await engine.getConfig('models.default')).toBeNull();
      for (const [key, tier] of Object.entries(keys)) expect(await engine.getConfig(key)).toBe(tiers[tier]);
      expect((await applyDatabasePins(engine, { ...tiers }, p.plan_hash)).id).toBe(applied.id);
      expect(await engine.getConfig('embedding_model')).toBe('voyage:fixture');
      await rollbackDatabasePins(engine, applied.id, p.plan_hash);
      expect(await engine.getConfig('models.default')).toBe('anthropic:fixture');
      for (const key of Object.keys(keys)) expect(await engine.getConfig(key)).toBe('anthropic:fixture');
    } finally { await engine.executeRaw('DELETE FROM config WHERE key=ANY($1::text[])', [Object.keys(keys)]); }
  });
  test('restoring a global default after a tiered apply prevents rollback from overwriting it', async () => {
    const tiers = { utility: 'codex-cli:u', reasoning: 'codex-cli:r', deep: 'codex-cli:d', subagent: 'codex-cli:s' };
    const p = await previewDatabasePins(engine, tiers), applied = await applyDatabasePins(engine, tiers, p.plan_hash);
    await engine.setConfig('models.default', 'openai:operator-change');
    await expect(rollbackDatabasePins(engine, applied.id, p.plan_hash)).rejects.toThrow('configuration_changed');
    expect(await engine.getConfig('models.default')).toBe('openai:operator-change');
  });
}
