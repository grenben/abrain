import { beforeEach, describe, expect, test, spyOn } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runLlmFallback } from '../../src/core/conversation-parser/llm-fallback.ts';
import { runLlmCall, probeLlmAvailability } from '../../src/core/conversation-parser/llm-base.ts';
import { privateFallbackContract } from '../../src/core/conversation-parser/llm-codex-fallback.ts';
import { runExtractConversationFactsCore } from '../../src/commands/extract-conversation-facts.ts';
import { parseConversation } from '../../src/core/conversation-parser/parse.ts';
interface Fixture {
  engine():BrainEngine; sourceId:string;
  run<T>(fn:(id:string)=>Promise<T>,hooks?:{},maxAttempts?:number):Promise<T>;
  reply(value:unknown):void; calls():any[];
}
export function codexParserContract(f:Fixture){describe('native conversation parser',()=>{
  const messages=[{speaker:'Aster',timestamp:'2026-06-02T10:00:00Z',text:'Orbit launched.'},{speaker:'Birch',timestamp:'2026-06-02T10:01:00Z',text:'Confirmed launch.'}];
  const body='Aster ⟿ 10:00 ⟿ Orbit launched.\nBirch ⟿ 10:01 ⟿ Confirmed launch.';
  const parse=(overrides:Partial<Parameters<typeof runLlmFallback>[0]>={})=>runLlmFallback({engine:f.engine(),modelStr:'codex-cli:gpt-test',body,fallbackDate:'2026-06-02',...overrides});
  beforeEach(async()=>{await f.engine().executeRaw('DELETE FROM conversation_parser_llm_cache');await f.engine().setConfig('conversation_parser.llm_fallback_enabled','false');f.reply({messages});});
  test('native schema, validated citations to source text, durable raw cache and zero-call replay',async()=>{
    const count=f.calls().length;
    await f.run(async id=>{
      expect(await parse()).toEqual(messages);expect(await parse()).toEqual(messages);
      const [row]=await f.engine().executeRaw<{attempts:number;accepted_turns:number}>('SELECT attempts,accepted_turns FROM codex_subscription_runs WHERE run_id=$1',[id]);expect(Number(row!.attempts)).toBe(1);expect(Number(row!.accepted_turns)).toBe(1);
    });
    expect(f.calls().length-count).toBe(1);const wire=f.calls().at(-1)!;
    expect(wire.args).toContain('--output-schema');expect(wire.mode).toBe(0o600);expect(wire.schema.required).toEqual(['evidence_hash','messages']);
    expect(JSON.parse(wire.prompt).messages[0].content).toContain(body);expect(wire.envKeys.some((k:string)=>/API_KEY|TOKEN|DATABASE_URL/.test(k))).toBe(false);
    expect(await parse()).toEqual(messages);expect(f.calls().length-count).toBe(1);
    const [cache]=await f.engine().executeRaw<{value_json:any}>('SELECT value_json FROM conversation_parser_llm_cache');expect(cache!.value_json.protocol).toBe('private-parser-cache-v1');expect(JSON.parse(cache!.value_json.raw).messages).toEqual(messages);
  });
  test.each([
    {raw:'malformed'}, {messages:[{...messages[0],text:'Fabricated quote'}]}, {messages:[{...messages[0],speaker:'Forged'}]},
    {messages:[{...messages[0],timestamp:'2026-02-30T10:00:00Z'}]}, {messages:[{...messages[0],timestamp:'2026-06-03T10:00:00Z'}]}, {messages:[{...messages[0],timestamp:'2026-06-02T19:00:00Z'}]}, {messages:[{...messages[0],text:'   '}]},
    {messages:[messages[0],{speaker:'Birch',text:'Confirmed launch.'}]}, {messages,evidence_hash:'wrong'}, {messages,operation_id:'forged'},
  ])('invalid content fails the whole chunk without accepted turns or cached empty results',async value=>{
    f.reply(value);await f.run(async id=>{
      await expect(parse()).rejects.toMatchObject({reason:'invalid_output'});
      const [row]=await f.engine().executeRaw<{accepted_turns:number}>('SELECT accepted_turns FROM codex_subscription_runs WHERE run_id=$1',[id]);expect(Number(row!.accepted_turns)).toBe(0);
    });expect(await f.engine().executeRaw('SELECT * FROM conversation_parser_llm_cache')).toHaveLength(0);
  });
  test.each([{refusal:true},{missingCompletion:true}])('lifecycle failures remain explicit and unresolved',async value=>{
    f.reply(value);await f.run(async id=>{await expect(parse()).rejects.toThrow();
      const [row]=await f.engine().executeRaw<{state:string}>('SELECT state FROM codex_subscription_attempts WHERE run_id=$1',[id]);expect(row!.state).toBe('unresolved');
    });expect(await f.engine().executeRaw('SELECT * FROM conversation_parser_llm_cache')).toHaveLength(0);
  });
  test('valid empty content is cached as an explicit successful empty parse',async()=>{
    f.reply({messages:[]});const count=f.calls().length;await f.run(async()=>{expect(await parse()).toEqual([]);expect(await parse()).toEqual([]);});expect(f.calls().length-count).toBe(1);
  });
  test('corrupt cached output fails local validation without inference',async()=>{
    await f.run(async()=>{await parse();});await f.engine().executeRaw("UPDATE conversation_parser_llm_cache SET value_json='{}'::jsonb");const count=f.calls().length;
    await expect(parse()).rejects.toMatchObject({reason:'invalid_output'});expect(f.calls().length).toBe(count);
  });
  test('cache identity includes prompt, schema version and date; legacy values never satisfy it',async()=>{
    const contract=privateFallbackContract(body,'synthetic chunk','system','2026-06-02');
    const invoke=(version=contract.version,system=contract.system)=>runLlmCall({shape:'fallback',engine:f.engine(),modelStr:'codex-cli:gpt-test',content:'synthetic chunk',system,responseSchema:contract.schema,cacheVersion:version,parse:contract.parse});
    const count=f.calls().length;await f.run(async()=>{await invoke();await invoke();await invoke('parser-v2');await invoke('parser-v2','Changed system');});expect(f.calls().length-count).toBe(3);
    await f.run(async()=>{await parse();f.reply({messages:messages.map(m=>({...m,timestamp:m.timestamp.replace('06-02','06-03')}))});await parse({fallbackDate:'2026-06-03'});});expect(f.calls().length-count).toBe(5);
  });
  test('forbidden models and injected transports fail before cache or provider dispatch',async()=>{
    await f.run(async()=>{await parse();});const count=f.calls().length;
    expect(()=>probeLlmAvailability('anthropic:claude-test')).toThrow();
    await expect(parse({modelStr:'openai:gpt-test'})).rejects.toMatchObject({code:'private_route_conflict'});
    await expect(parse({chatTransport:async()=>{throw new Error('forbidden transport');}})).rejects.toMatchObject({reason:'invalid_input'});
    expect(f.calls().length).toBe(count);
  });
  test('missing native schema cannot take the legacy prompt-only path',async()=>{
    const count=f.calls().length;
    await expect(runLlmCall({shape:'polish',modelStr:'codex-cli:gpt-test',content:body,system:'system',parse:JSON.parse})).rejects.toMatchObject({reason:'invalid_input'});expect(f.calls().length).toBe(count);
  });
  test.each([{sampleLines:0},{sampleLines:1001},{sampleLines:NaN},{body:'x'.repeat(262145)},{body:'x'.repeat(65537)},{body:Array(17).fill('Aster').join('\n'),sampleLines:1},{fallbackDate:'2026-02-30'}])('preflights all bounds before the first call',async opts=>{
    const count=f.calls().length;await expect(parse(opts)).rejects.toMatchObject({reason:'invalid_input'});expect(f.calls().length).toBe(count);
  });
  test('partial chunk success is cached for bounded retry, never returned as a complete page',async()=>{
    f.reply({messages:[messages[0]]});const engine=f.engine(),original=engine.executeRaw;let changed=false;
    const fault=spyOn(engine,'executeRaw').mockImplementation(async function<T>(this:BrainEngine,sql:string,params?:unknown[],options?:Parameters<BrainEngine['executeRaw']>[2]):Promise<T[]>{
      const rows=await original.call(this,sql,params,options);if(!changed&&sql.startsWith('INSERT INTO conversation_parser_llm_cache')){changed=true;f.reply({raw:'malformed'});}return rows as T[];
    });
    try{await f.run(async()=>{await expect(parse({sampleLines:1})).rejects.toMatchObject({reason:'invalid_output'});});}finally{fault.mockRestore();}
    const count=f.calls().length;f.reply({messages:[messages[1]]});await f.run(async()=>{expect(await parse({sampleLines:1})).toEqual(messages);});expect(f.calls().length-count).toBe(1);
  });
  test('attempt exhaustion retains prior chunks and never returns a partial result',async()=>{
    f.reply({messages:[messages[0]]});await f.run(async()=>{await expect(parse({sampleLines:1})).rejects.toThrow();}, {},1);
    expect(await f.engine().executeRaw('SELECT * FROM conversation_parser_llm_cache')).toHaveLength(1);
  });
  test('aborted cached reads and fresh calls fail explicitly',async()=>{
    await f.run(async()=>{await parse();});const count=f.calls().length;
    await expect(parse({signal:AbortSignal.abort()})).rejects.toMatchObject({reason:'aborted'});expect(f.calls().length).toBe(count);
  });
  test('unsupported native schemas and unavailable cache fail before dispatch',async()=>{
    const contract=privateFallbackContract(body,'synthetic chunk','system','2026-06-02'),count=f.calls().length;
    await expect(runLlmCall({shape:'fallback',modelStr:'codex-cli:gpt-test',content:body,system:'system',cacheVersion:contract.version,responseSchema:{...contract.schema,patternProperties:{}},parse:contract.parse})).rejects.toMatchObject({reason:'unsupported_schema'});
    const fault=spyOn(f.engine(),'executeRaw').mockRejectedValue(new Error('synthetic cache unavailable'));
    try{await expect(parse()).rejects.toThrow('synthetic cache unavailable');}finally{fault.mockRestore();}
    expect(f.calls().length).toBe(count);
  });
  test('active cancellation settles the local call without caching or accepting a result',async()=>{
    f.reply({wait:true});const controller=new AbortController(),count=f.calls().length;
    await f.run(async id=>{
      const pending=parse({signal:controller.signal}).then(()=>null,error=>error);
      for(let i=0;i<200&&f.calls().length===count;i++)await Bun.sleep(5);
      controller.abort();expect(await pending).toMatchObject({reason:'aborted'});
      const [row]=await f.engine().executeRaw<{state:string}>('SELECT state FROM codex_subscription_attempts WHERE run_id=$1',[id]);expect(row!.state).toBe('unresolved');
    });expect(await f.engine().executeRaw('SELECT * FROM conversation_parser_llm_cache')).toHaveLength(0);
  });
  test('real extraction completes only after native parser and native fact extraction both succeed',async()=>{
    const engine=f.engine(),slug='conversations/parser-success';
    await engine.putPage(slug,{type:'conversation',title:'Synthetic unmatched transcript',compiled_truth:body,frontmatter:{date:'2026-06-02'}},{sourceId:f.sourceId});
    await engine.setConfig('conversation_parser.llm_fallback_enabled','true');
    const original=engine.executeRaw;let changed=false;
    const fault=spyOn(engine,'executeRaw').mockImplementation(async function<T>(this:BrainEngine,sql:string,params?:unknown[],options?:Parameters<BrainEngine['executeRaw']>[2]):Promise<T[]>{
      const rows=await original.call(this,sql,params,options);if(!changed&&sql.startsWith('INSERT INTO conversation_parser_llm_cache')){changed=true;f.reply({facts:[]});}return rows as T[];
    });
    const count=f.calls().length;
    try{await f.run(async()=>{const result=await runExtractConversationFactsCore(engine,{sourceId:f.sourceId,slugs:[slug],sleepMs:0});expect(result.pages_failed).toBe(0);expect(result.pages_processed).toBe(1);expect(result.segments_processed).toBe(1);});}finally{fault.mockRestore();}
    expect(f.calls().length-count).toBe(2);
    const rows=await engine.executeRaw<{fact:string}>('SELECT fact FROM facts WHERE source_id=$1 AND source_markdown_slug=$2',[f.sourceId,slug]);expect(rows.map(row=>row.fact)).toContain('EXTRACTION_COMPLETE');
    await f.run(async()=>{const result=await runExtractConversationFactsCore(engine,{sourceId:f.sourceId,slugs:[slug],sleepMs:0});expect(result.pages_skipped_completed).toBe(1);});expect(f.calls().length-count).toBe(2);
  });
  test('real extraction dispatcher records parser failure without a terminal fact or checkpoint',async()=>{
    expect(parseConversation(body).phase).toBe('no_match');const engine=f.engine(),slug='conversations/parser-failure';
    await engine.putPage(slug,{type:'conversation',title:'Synthetic unmatched transcript',compiled_truth:body,frontmatter:{date:'2026-06-02'}},{sourceId:f.sourceId});
    await engine.setConfig('conversation_parser.llm_fallback_enabled','true');f.reply({raw:'malformed'});
    const count=f.calls().length;
    await f.run(async()=>{const result=await runExtractConversationFactsCore(engine,{sourceId:f.sourceId,slugs:[slug],sleepMs:0});expect(result.pages_failed).toBe(1);expect(result.pages_processed).toBe(0);expect(result.pages_marked_non_extractable).toBe(0);});
    expect(f.calls().length-count).toBe(1);
    expect(await engine.executeRaw('SELECT path FROM op_checkpoint_paths WHERE path LIKE $1',[`${f.sourceId}|${slug}|%`])).toHaveLength(0);
    expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2',[f.sourceId,slug])).toHaveLength(0);
  });
});}
