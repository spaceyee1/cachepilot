import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApiRuntime } from '../api/runtime.mjs';

function fixture({ show = true, approve = true } = {}) {
  let p = { version:1,id:'offline',label:'Offline',protocol:'openai-chat',baseUrl:'https://api.provider.com/v1',model:'fixture-model',credentialGeneration:randomUUID(),networkEnabled:true,
    limits:{maxRequests:5,maxInputBytes:65536,maxTotalInputBytes:1048576,maxOutputTokens:64,maxTotalOutputTokens:256,timeoutMs:1000} };
  let local, approved=0, sent=0;
  const runtime=createApiRuntime({source:'offline_fixture',getProfile:async()=>p,listProfiles:async()=>[p],
    helpers:{approve:async()=>{approved++;return approve;},credential:async()=> 'offline-fixture-not-a-real-key',showGateway:async value=>{local=value;return show;}},
    transport:async ({beforeSubmit})=>{await beforeSubmit();sent++;return {data:{model:p.model,choices:[{message:{content:'offline answer'}}],usage:{prompt_tokens:100,completion_tokens:4,total_tokens:104,prompt_tokens_details:{cached_tokens:60}}},timing:{}};} });
  return {runtime,get local(){return local;},get approved(){return approved;},get sent(){return sent;},replace(){p={...p,credentialGeneration:randomUUID()};}};
}
const body=()=>({model:'fixture-model',messages:[{role:'user',content:'offline body'}],max_completion_tokens:16});
async function httpCall(f, text=JSON.stringify(body())) {
  const response=await fetch(f.local.address+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+f.local.token},body:text});
  return {status:response.status,body:await response.json()};
}
test('gateway and native tool share approval, ledger and limits without exposing local token through MCP',async()=>{
  const f=fixture();
  try {
    const start=await f.runtime.callTool('cachepilot_api_gateway_start',{profileId:'offline'});
    assert.equal(start.enabled,true);assert.ok(!JSON.stringify(start).includes(f.local.token));
    const v=await httpCall(f);assert.equal(v.status,200);assert.equal(v.body.choices[0].message.content,'offline answer');
    assert.equal(f.approved,1);assert.equal(f.sent,1);
    const status=await f.runtime.callTool('cachepilot_api_status',{});assert.equal(status.networkAttempts,1);assert.equal(status.scopes[0].source,'offline_fixture');assert.equal(status.scopes[0].cacheReadTokens,60);assert.ok(!JSON.stringify(status).includes(f.local.token));
    await f.runtime.callTool('cachepilot_api_gateway_stop',{});assert.equal((await f.runtime.callTool('cachepilot_api_status',{})).gateway.enabled,false);
  } finally {await f.runtime.close();}
});
test('local denial is a complete 403 with no credential transport attempt',async()=>{
  const f=fixture({approve:false});try{await f.runtime.callTool('cachepilot_api_gateway_start',{profileId:'offline'});const v=await httpCall(f);assert.equal(v.status,403);assert.equal(f.sent,0);}finally{await f.runtime.close();}
});
test('duplicate body members are rejected before approval rather than silently overwritten',async()=>{
  const f=fixture();try{await f.runtime.callTool('cachepilot_api_gateway_start',{profileId:'offline'});const v=await httpCall(f,'{"model":"fixture-model","model":"other","messages":[],"max_completion_tokens":16}');assert.equal(v.status,400);assert.equal(f.approved,0);assert.equal(f.sent,0);}finally{await f.runtime.close();}
});
test('binding replacement invalidates an existing gateway client token for submissions',async()=>{
  const f=fixture();try{await f.runtime.callTool('cachepilot_api_gateway_start',{profileId:'offline'});f.replace();const v=await httpCall(f);assert.equal(v.status,409);assert.equal(f.approved,0);assert.equal(f.sent,0);}finally{await f.runtime.close();}
});
test('local token dialog failure closes the newly allocated listener',async()=>{
  const f=fixture({show:false});try{await assert.rejects(f.runtime.callTool('cachepilot_api_gateway_start',{profileId:'offline'}),{code:'API_CANCELLED'});await assert.rejects(fetch(f.local.address+'/v1/models'));assert.equal((await f.runtime.callTool('cachepilot_api_status',{})).gateway.enabled,false);}finally{await f.runtime.close();}
});
test('stop invalidates a gateway start whose profile read is still pending',async()=>{
  let release, shown=0;
  const p={version:1,id:'offline',label:'Offline',protocol:'openai-chat',baseUrl:'https://api.provider.com/v1',model:'fixture-model',credentialGeneration:randomUUID(),networkEnabled:false,
    limits:{maxRequests:1,maxInputBytes:1024,maxTotalInputBytes:2048,maxOutputTokens:16,maxTotalOutputTokens:32,timeoutMs:1000}};
  const runtime=createApiRuntime({source:'offline_fixture',getProfile:()=>new Promise(r=>{release=()=>r(p);}),listProfiles:async()=>[],helpers:{showGateway:async()=>{shown++;return true;}}});
  try{
    const starting=runtime.callTool('cachepilot_api_gateway_start',{profileId:'offline'});
    await new Promise(r=>setImmediate(r));await runtime.callTool('cachepilot_api_gateway_stop',{});release();
    await assert.rejects(starting,{code:'API_CANCELLED'});assert.equal(shown,0);assert.equal((await runtime.callTool('cachepilot_api_status',{})).gateway.enabled,false);
  }finally{await runtime.close();}
});
test('close during the local token dialog invalidates and releases its listener',async()=>{
  let local, resolveShown;
  const p={version:1,id:'offline',label:'Offline',protocol:'openai-chat',baseUrl:'https://api.provider.com/v1',model:'fixture-model',credentialGeneration:randomUUID(),networkEnabled:false,
    limits:{maxRequests:1,maxInputBytes:1024,maxTotalInputBytes:2048,maxOutputTokens:16,maxTotalOutputTokens:32,timeoutMs:1000}};
  const runtime=createApiRuntime({source:'offline_fixture',getProfile:async()=>p,listProfiles:async()=>[],helpers:{showGateway:async details=>{local=details;return new Promise(r=>{resolveShown=r;});}}});
  const starting=runtime.callTool('cachepilot_api_gateway_start',{profileId:'offline'});
  while(!resolveShown)await new Promise(r=>setImmediate(r));await runtime.close();resolveShown(true);
  await assert.rejects(starting,{code:'API_CANCELLED'});await assert.rejects(fetch(local.address+'/v1/models'));
});
