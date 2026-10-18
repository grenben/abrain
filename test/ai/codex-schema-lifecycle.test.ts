import { test, expect } from 'bun:test';
import { prepareCodexSchema } from '../../src/core/ai/providers/codex-schema.ts';
import { parseCodexLifecycle } from '../../src/core/ai/providers/codex-lifecycle.ts';
const schema={type:'object',properties:{items:{type:'array',items:{type:'string'},maxItems:3}},required:['items'],additionalProperties:false};
const events=(value:unknown)=>[
  {type:'thread.started',thread_id:'fixture'}, {type:'turn.started'},
  {type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}},
  {type:'turn.completed'},
];
const jsonl=(xs:unknown[])=>xs.map(x=>JSON.stringify(x)).join('\n');
test('closed schemas locally distinguish valid empty arrays, wrong types and extra keys',()=>{
  const prepared=prepareCodexSchema(schema);
  expect(prepared.validate({items:[]})).toBe(true);
  expect(prepared.validate({items:['a',2]})).toBe(false);
  expect(prepared.validate({items:[],extra:true})).toBe(false);
  expect(prepared.validate({items:['a','b','c','d']})).toBe(false);
});
test.each([{...schema,additionalProperties:true},{...schema,required:[]},{...schema,oneOf:[]},{...schema,properties:{items:{type:'string',format:'uri'}}},{...schema,properties:{items:{$ref:'https://invalid.example/schema'}}}])('unsupported schema fails instead of stripping semantics',value=>{
  expect(()=>prepareCodexSchema(value)).toThrow('unsupported_schema');
});
test('local refs and nullable values are validated without network resolution',()=>{
  const s=prepareCodexSchema({type:'object',properties:{value:{$ref:'#/$defs/value'}},required:['value'],additionalProperties:false,$defs:{value:{type:['string','null']}}});
  expect(s.validate({value:null})).toBe(true);expect(s.validate({value:1})).toBe(false);
});
test('lifecycle completion is independent of valid application JSON',()=>{
  expect(parseCodexLifecycle(jsonl(events({items:[]})))).toEqual({text:'{"items":[]}',usage:null});
  expect(()=>parseCodexLifecycle(jsonl(events({items:[]}).slice(0,-1)))).toThrow('missing_completion');
  expect(()=>parseCodexLifecycle('{"items":[]}')).toThrow('malformed_lifecycle');
  expect(()=>parseCodexLifecycle(jsonl([...events({}),{type:'turn.completed'}]))).toThrow('malformed_lifecycle');
});
test('invalid usage and native tool events cannot become successful application output',()=>{
  const xs=events({});xs[3]={type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:2,output_tokens:0}} as any;
  expect(()=>parseCodexLifecycle(jsonl(xs))).toThrow('malformed_lifecycle');
  expect(()=>parseCodexLifecycle(jsonl([xs[0],xs[1],{type:'item.started',item:{type:'mcp_tool_call'}}]))).toThrow('native_action');
  expect(()=>parseCodexLifecycle(jsonl([xs[0],xs[1],{type:'item.completed',item:{type:'local_shell_call'}}]))).toThrow('native_action');
  expect(()=>parseCodexLifecycle(jsonl([xs[0],xs[1],{type:'item.completed',item:{type:'custom_tool_call'}}]))).toThrow('native_action');
  expect(()=>parseCodexLifecycle(jsonl([xs[0],xs[1],{type:'item.completed',item:{type:'tool_search_call'}}]))).toThrow('native_action');
});
