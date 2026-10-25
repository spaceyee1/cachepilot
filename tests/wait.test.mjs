import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedLocalRead } from '../api/wait.mjs';
import { createApiRuntime } from '../api/runtime.mjs';
import { randomUUID } from 'node:crypto';

test('metadata timeout returns without waiting for the underlying read', async () => {
  let release;
  const pending = boundedLocalRead(() => new Promise(r => { release = r; }), undefined, 20);
  await assert.rejects(pending, { code: 'API_METADATA_TIMEOUT' });
  release('discarded');
});
test('metadata cancellation discards a late value', async () => {
  const c = new AbortController(); let release;
  const pending = boundedLocalRead(() => new Promise(r => { release = r; }), c.signal);
  await new Promise(r => setImmediate(r)); c.abort();
  await assert.rejects(pending, { code: 'API_CANCELLED' }); release('discarded');
});
test('already cancelled read does not start the operation', async () => {
  const c = new AbortController(); c.abort(); let calls = 0;
  await assert.rejects(boundedLocalRead(() => { calls++; }, c.signal), { code: 'API_CANCELLED' });
  assert.equal(calls, 0);
});
test('metadata read error remains fixed and does not become a success', async () => {
  await assert.rejects(boundedLocalRead(() => { throw Error('offline failure'); }), /offline failure/);
});
const profile = () => ({ version:1,id:'offline',label:'Offline',protocol:'openai-chat',baseUrl:'https://api.provider.com/v1',model:'fixture-model',credentialGeneration:randomUUID(),networkEnabled:true,
  limits:{maxRequests:1,maxInputBytes:1024,maxTotalInputBytes:2048,maxOutputTokens:16,maxTotalOutputTokens:32,timeoutMs:1000} });
const body = { model:'fixture-model',messages:[{role:'user',content:'offline'}],max_completion_tokens:8 };
test('request metadata timeout releases its slot and never approves or sends a late result', async () => {
  let release, approved = 0, sent = 0, pending = true; const p = profile();
  const runtime = createApiRuntime({source:'offline_fixture',metadataTimeoutMs:20,
    getProfile:()=>pending ? new Promise(r=>{release=r;}) : Promise.resolve({...p,networkEnabled:false}),listProfiles:async()=>[],
    helpers:{approve:async()=>{approved++;return true;}},transport:async()=>{sent++;} });
  await assert.rejects(runtime.callTool('cachepilot_api_request',{profileId:p.id,body}),{code:'API_METADATA_TIMEOUT'});
  pending=false; release(p); await new Promise(r=>setImmediate(r));
  assert.equal((await runtime.callTool('cachepilot_api_status',{})).active,false);
  await assert.rejects(runtime.callTool('cachepilot_api_request',{profileId:p.id,body}),{code:'API_NETWORK_DISABLED'});
  assert.equal(approved,0);assert.equal(sent,0);await runtime.close();
});
test('status metadata reads have the same finite wait', async () => {
  const runtime = createApiRuntime({source:'offline_fixture',metadataTimeoutMs:20,listProfiles:()=>new Promise(()=>{})});
  await assert.rejects(runtime.callTool('cachepilot_api_status',{}),{code:'API_METADATA_TIMEOUT'});await runtime.close();
});
test('finishing an old stop cannot erase a concurrently opened gateway handle', async () => {
  const p=profile();let releaseOld, index=0, latest;
  const runtime=createApiRuntime({source:'offline_fixture',getProfile:async()=>p,listProfiles:async()=>[],helpers:{showGateway:async()=>true},
    openGateway:async()=>{
      const n=++index;let listening=true;
      const h={address:'http://127.0.0.1:'+(10000+n),token:'offline-token',expiresAt:'2099-01-01T00:00:00Z',status:()=>({listening}),
        close:()=>{listening=false;return n===1 ? new Promise(r=>{releaseOld=r;}) : Promise.resolve();}};
      latest=h;return h;
    }});
  await runtime.callTool('cachepilot_api_gateway_start',{profileId:p.id});
  const stopping=runtime.callTool('cachepilot_api_gateway_stop',{});
  await runtime.callTool('cachepilot_api_gateway_start',{profileId:p.id});
  releaseOld();await stopping;
  const status=await runtime.callTool('cachepilot_api_status',{});
  assert.equal(status.gateway.enabled,true);assert.equal(status.gateway.address,latest.address);
  await runtime.close();assert.equal(latest.status().listening,false);
});
