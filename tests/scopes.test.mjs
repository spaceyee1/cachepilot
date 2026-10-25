import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApiRuntime } from '../api/runtime.mjs';

const profile = id => ({version:1,id,label:'Offline scope fixture',protocol:'openai-chat',baseUrl:'https://api.provider.com/v1',model:'fixture-model',credentialGeneration:randomUUID(),networkEnabled:true,
  limits:{maxRequests:1,maxInputBytes:4096,maxTotalInputBytes:32768,maxOutputTokens:8,maxTotalOutputTokens:32,timeoutMs:1000}});
const body=()=>({model:'fixture-model',messages:[{role:'user',content:'offline scope bound'}],max_completion_tokens:8});
function fixture(approve=async()=>true){
  const profiles=new Map(Array.from({length:20},(_,i)=>{const p=profile('scope-'+i);return[p.id,p];}));
  const calls={approval:0,credential:0,transport:0};
  const runtime=createApiRuntime({source:'offline_fixture',getProfile:async id=>profiles.get(id),listProfiles:async()=>[],
    helpers:{approve:async data=>{calls.approval++;return approve(data);},credential:async()=>{calls.credential++;return 'OFFLINE_SYNTHETIC_NOT_A_CREDENTIAL';}},
    transport:async ({beforeSubmit})=>{await beforeSubmit();calls.transport++;return{data:{usage:{prompt_tokens:10,completion_tokens:1,prompt_tokens_details:{cached_tokens:3}}},timing:{}};}});
  return{runtime,profiles,calls,run:(id)=>runtime.callTool('cachepilot_api_request',{profileId:id,body:body()}),status:()=>runtime.callTool('cachepilot_api_status',{})};
}
test('sixteen completed scopes work; seventeenth cannot approve, decrypt or send and oldest budget stays reserved',async()=>{
  const f=fixture();try{
    for(let i=0;i<16;i++)await f.run('scope-'+i);
    const before=await f.status();assert.deepEqual(before.scopeCapacity,{limit:16,reserved:16,recorded:16,remaining:0,eviction:'none',includesDeniedApprovals:true});
    assert.equal(before.scopes.length,16);assert.equal(before.networkAttempts,16);
    await assert.rejects(f.run('scope-16'),{code:'API_SCOPE_LIMIT'});
    assert.deepEqual(f.calls,{approval:16,credential:16,transport:16});
    await assert.rejects(f.run('scope-0'),{code:'API_BUDGET_EXHAUSTED'});
    const after=await f.status();assert.deepEqual(after.scopes,before.scopes);assert.equal(after.scopeCapacity.reserved,16);
  }finally{await f.runtime.close();}
});
test('sixteen denied approvals also reserve scope capacity without recording any provider attempt',async()=>{
  let allow=false;const f=fixture(async()=>allow);try{
    for(let i=0;i<16;i++)await assert.rejects(f.run('scope-'+i),{code:'API_APPROVAL_DENIED'});
    assert.deepEqual((await f.status()).scopeCapacity,{limit:16,reserved:16,recorded:0,remaining:0,eviction:'none',includesDeniedApprovals:true});
    await assert.rejects(f.run('scope-16'),{code:'API_SCOPE_LIMIT'});assert.deepEqual(f.calls,{approval:16,credential:0,transport:0});
    allow=true;await f.run('scope-0');assert.equal((await f.status()).networkAttempts,1);
  }finally{await f.runtime.close();}
});
for(const dimension of ['inputBytes','outputTokens'])test(`scope capacity rejection preserves the oldest ${dimension} reservation independently of its request-count limit`,async()=>{
  const f=fixture();const original=f.profiles.get('scope-0');
  const bytes=Buffer.byteLength(JSON.stringify(body()));
  const limits={...original.limits,maxRequests:2,
    ...(dimension==='inputBytes'?{maxInputBytes:bytes,maxTotalInputBytes:bytes}:{maxTotalOutputTokens:8})};
  f.profiles.set(original.id,{...original,limits});
  try{
    const first=await f.run(original.id);assert.equal(first.budget.requestsReserved,1);
    assert.equal(first.budget.inputBytesReserved,bytes);assert.equal(first.budget.outputTokensReserved,8);
    for(let i=1;i<16;i++)await f.run('scope-'+i);
    await assert.rejects(f.run('scope-16'),{code:'API_SCOPE_LIMIT'});
    await assert.rejects(f.run(original.id),{code:'API_BUDGET_EXHAUSTED'});
    assert.equal(f.calls.approval,16);assert.equal(f.calls.credential,16);assert.equal(f.calls.transport,16);
  }finally{await f.runtime.close();}
});
test('previews and status do not consume any of the sixteen sending scopes',async()=>{
  const f=fixture();try{
    for(const id of f.profiles.keys())await f.runtime.callTool('cachepilot_api_preview',{profileId:id,body:body()});
    for(let i=0;i<10;i++)assert.equal((await f.status()).scopeCapacity.reserved,0);
    assert.deepEqual(f.calls,{approval:0,credential:0,transport:0});await f.run('scope-0');assert.equal((await f.status()).scopeCapacity.reserved,1);
  }finally{await f.runtime.close();}
});
test('one profile rotated through sixteen generations cannot evade the capacity or erase original reservations',async()=>{
  const f=fixture();const original=f.profiles.get('scope-0');try{
    await f.run(original.id);
    for(let i=1;i<16;i++){f.profiles.set(original.id,{...original,credentialGeneration:randomUUID()});await f.run(original.id);}
    f.profiles.set(original.id,{...original,credentialGeneration:randomUUID()});
    await assert.rejects(f.run(original.id),{code:'API_SCOPE_LIMIT'});
    f.profiles.set(original.id,original);await assert.rejects(f.run(original.id),{code:'API_BUDGET_EXHAUSTED'});
    const status=await f.status();assert.equal(status.scopes.length,16);assert.equal(status.networkAttempts,16);assert.equal(f.calls.approval,16);
  }finally{await f.runtime.close();}
});
test('concurrent seventeenth scope is busy first, then deterministically capacity-limited after the sixteenth completes',async()=>{
  let release,wait=false;const f=fixture(async()=>wait?new Promise(r=>{release=r;}):true);try{
    for(let i=0;i<15;i++)await f.run('scope-'+i);wait=true;
    const last=f.run('scope-15');while(!release)await new Promise(r=>setImmediate(r));
    await assert.rejects(f.run('scope-16'),{code:'API_BUSY'});release(true);await last;
    await assert.rejects(f.run('scope-16'),{code:'API_SCOPE_LIMIT'});
    assert.equal((await f.status()).scopeCapacity.reserved,16);assert.equal(f.calls.transport,16);
  }finally{await f.runtime.close();}
});
test('runtime preserves reported writes from partial Anthropic usage while pausing unknown billing and hiding read rate',async()=>{
  const p={...profile('partial-write'),protocol:'anthropic-messages'};
  const runtime=createApiRuntime({source:'offline_fixture',getProfile:async()=>p,listProfiles:async()=>[],
    helpers:{approve:async()=>true,credential:async()=> 'OFFLINE_SYNTHETIC_NOT_A_CREDENTIAL'},
    transport:async()=>({data:{usage:{input_tokens:10,cache_creation_input_tokens:7,output_tokens:2}},timing:{}})});
  const args={profileId:p.id,body:{model:p.model,messages:[{role:'user',content:'offline'}],max_tokens:8}};
  try{
    const result=await runtime.callTool('cachepilot_api_request',args);assert.equal(result.usage.cacheWriteTokens,7);assert.equal(result.providerCacheMeasured,false);assert.equal(result.budget.paused,true);
    for(let i=0;i<5;i++){const s=await runtime.callTool('cachepilot_api_status',{});assert.equal(s.scopes[0].cacheWriteTokens,7);assert.equal(s.scopes[0].cacheHitRate,null);assert.equal(s.scopes[0].reportedRequests,0);assert.equal(s.scopes[0].unknownUsageRequests,1);}
    await assert.rejects(runtime.callTool('cachepilot_api_request',args),{code:'API_BUDGET_EXHAUSTED'});
  }finally{await runtime.close();}
});
