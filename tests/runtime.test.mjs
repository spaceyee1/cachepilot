import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApiRuntime } from '../api/runtime.mjs';

const key = 'offline-fixture-never-a-real-key';
const profile = () => ({ version: 1, id: 'offline-fixture', label: 'offline fixture', protocol: 'openai-chat', baseUrl: 'https://api.provider.com/v1', model: 'fixture-model', credentialGeneration: randomUUID(), networkEnabled: true,
  limits: { maxRequests: 5, maxInputBytes: 65536, maxTotalInputBytes: 1048576, maxOutputTokens: 64, maxTotalOutputTokens: 256, timeoutMs: 1000 } });
const body = () => ({ model: 'fixture-model', messages: [{ role: 'user', content: 'synthetic offline text' }], max_completion_tokens: 16 });
const result = () => ({ data: { model: 'fixture-model', choices: [{ message: { content: 'synthetic answer' } }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 60 } } }, timing: { dnsMs: 1, tlsMs: 2, firstByteMs: 3, totalMs: 4 } });
function setup(options = {}) {
  let selected = profile(), calls = 0, approvals = 0, credentials = 0;
  const runtime = createApiRuntime({ source: 'offline_fixture', getProfile: async () => selected, listProfiles: async () => [selected],
    helpers: { approve: async () => { approvals++; return true; }, credential: async () => { credentials++; return key; }, ...options.helpers },
    transport: async params => { calls++; await params.beforeSubmit(); return result(); }, ...options });
  return { runtime, selected, replace(p) { selected = p; }, get calls() { return calls; }, get approvals() { return approvals; }, get credentials() { return credentials; },
    run: (signal, input = body()) => runtime.callTool('cachepilot_api_request', { profileId: selected.id, body: input }, { signal }), status: () => runtime.callTool('cachepilot_api_status', {}) };
}
test('preview never reads a key, asks for approval, or sends', async () => {
  const s = setup(); const value = await s.runtime.callTool('cachepilot_api_preview', { profileId: s.selected.id, body: body() });
  assert.equal(value.sent, false); assert.equal(value.promptModified, false); assert.match(value.bodyHash, /^[a-f0-9]{64}$/);
  assert.equal(s.calls, 0); assert.equal(s.credentials, 0); assert.equal(s.approvals, 0);
});
test('disabled profile cannot ask for approval or send', async () => {
  const s = setup(); s.replace({ ...s.selected, networkEnabled: false });
  await assert.rejects(s.run(), { code: 'API_NETWORK_DISABLED' }); assert.equal(s.calls, 0); assert.equal(s.credentials, 0);
});
test('local denial cannot decrypt credentials or submit', async () => {
  const s = setup({ helpers: { approve: async () => false, credential: async () => { throw Error('must not run'); } } });
  await assert.rejects(s.run(), { code: 'API_APPROVAL_DENIED' }); assert.equal(s.calls, 0);
});
test('one approved request commits one usage record; status refresh does not add usage', async () => {
  const s = setup(), original = body(); const v = await s.run(undefined, original);
  assert.equal(v.source, 'offline_fixture'); assert.equal(v.usage.cacheHitRate, 0.6); assert.equal(v.identityStatus, 'unverified'); assert.equal(v.optimizationGainMeasured, false);
  assert.equal(v.budget.outputTokensReserved, 16); assert.equal(s.calls, 1); assert.equal(s.approvals, 1); assert.equal(s.credentials, 1);
  for (let i = 0; i < 5; i++) { const st = await s.status(); assert.equal(st.scopes[0].requests, 1); assert.equal(st.scopes[0].inputTokens, 100); assert.equal(st.scopes[0].cacheReadTokens, 60); }
  assert.equal(original.messages[0].content, 'synthetic offline text');
});
test('busy bridge rejects a concurrent request before another approval or reservation', async () => {
  let allow; const s = setup({ helpers: { approve: () => new Promise(r => { allow = r; }), credential: async () => key } });
  const run = s.run(); await new Promise(r => setImmediate(r));
  await assert.rejects(s.run(), { code: 'API_BUSY' }); allow(true); await run;
  assert.equal((await s.status()).networkAttempts, 1);
});
test('request cap is reserved before transport and cannot be overrun', async () => {
  const s = setup(); s.replace({ ...s.selected, limits: { ...s.selected.limits, maxRequests: 1 } });
  await s.run(); await assert.rejects(s.run(), { code: 'API_BUDGET_EXHAUSTED' }); assert.equal(s.calls, 1);
});
test('failed network attempt is not refunded; unknown cost pauses later requests', async () => {
  let sent = 0; const s = setup({ transport: async () => { sent++; throw Error(key); } });
  await assert.rejects(s.run(), error => error.code === 'API_OPERATION_REJECTED' && !error.message.includes(key));
  await assert.rejects(s.run(), { code: 'API_BUDGET_EXHAUSTED' });
  const st = await s.status(); assert.equal(sent, 1); assert.equal(st.networkAttempts, 1); assert.equal(st.scopes[0].unknownUsageRequests, 1);
});
test('missing cache usage stays unmeasured without guessing zero hits', async () => {
  const s = setup({ transport: async () => ({ data: { usage: { prompt_tokens: 100, completion_tokens: 10 } }, timing: {} }) });
  const v = await s.run(); assert.equal(v.usage.cachedInputTokens, null); assert.equal(v.providerCacheMeasured, false);
  const st = await s.status(); assert.equal(st.scopes[0].cacheHitRate, null); assert.equal(st.scopes[0].reportingCoverage, 0);
});
test('zero input with explicit cache counters reports fields but never invents a rate',async()=>{
  const s=setup({transport:async()=>({data:{usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0,prompt_tokens_details:{cached_tokens:0}}},timing:{}})});
  const v=await s.run();assert.equal(v.cacheUsageFieldsReported,true);assert.equal(v.providerCacheMeasured,false);assert.equal(v.usage.cacheHitRate,null);
  const row=(await s.status()).scopes[0];assert.equal(row.cacheUsageFieldsReported,true);assert.equal(row.providerCacheMeasured,false);assert.equal(row.cacheHitRate,null);
});
test('missing billing usage pauses future sends', async () => {
  const s = setup({ transport: async () => ({ data: { choices: [] }, timing: {} }) });
  const v = await s.run(); assert.equal(v.budget.paused, true); await assert.rejects(s.run(), { code: 'API_BUDGET_EXHAUSTED' });
});
test('known key echoed by an interface is redacted before any tool result', async () => {
  const s = setup({ transport: async () => { const r = result(); r.data.echo = key; r.data.encoded = Buffer.from(key).toString('base64'); return r; } });
  const v = await s.run(); assert.ok(!JSON.stringify(v).includes(key)); assert.equal(v.response.echo, '[REDACTED]'); assert.equal(v.response.encoded, '[REDACTED]');
});
test('credential generation changed while reading credentials refuses submission', async () => {
  let s; s = setup({ helpers: { approve: async () => true, credential: async () => { s.replace({ ...s.selected, credentialGeneration: randomUUID() }); return key; } } });
  await assert.rejects(s.run(), { code: 'API_PROFILE_CHANGED' }); assert.equal(s.calls, 0); assert.equal((await s.status()).networkAttempts, 0);
});
test('generation changed in flight discards response and never attributes to new scope', async () => {
  let s; s = setup({ transport: async () => { s.replace({ ...s.selected, credentialGeneration: randomUUID() }); return result(); } });
  await assert.rejects(s.run(), { code: 'API_PROFILE_CHANGED' });
  const st = await s.status(); assert.equal(st.scopes.length, 1); assert.equal(st.scopes[0].reportedRequests, 0); assert.equal(st.successful, 0);
});
for (const changed of ['model','protocol','baseUrl','networkEnabled']) test(`${changed} changed in flight invalidates the result`, async () => {
  let s; s = setup({ transport: async () => { s.replace({ ...s.selected, [changed]: changed === 'networkEnabled' ? false : changed === 'baseUrl' ? 'https://other.provider.com/v1' : 'different' }); return result(); } });
  await assert.rejects(s.run(), { code: 'API_PROFILE_CHANGED' }); assert.equal((await s.status()).successful, 0);
});
test('abort during final profile await cannot commit a success', async () => {
  const p = profile(), c = new AbortController(); let reads = 0, release;
  const s = setup({ getProfile: async () => { reads++; if (reads === 4) return new Promise(r => { release = () => r(p); }); return p; }, transport: async () => result() });
  const run = s.run(c.signal); await new Promise(r => setImmediate(r)); assert.ok(release); c.abort(); release();
  await assert.rejects(run, { code: 'API_CANCELLED' }); const st = await s.status(); assert.equal(st.successful, 0); assert.equal(st.scopes[0].reportedRequests, 0);
});
test('abort before budget reservation cannot submit even if credentials arrive later', async () => {
  const p = profile(), c = new AbortController(); let reads = 0, release;
  const s = setup({ getProfile: async () => { reads++; if (reads === 3) return new Promise(r => { release = () => r(p); }); return p; } });
  const run = s.run(c.signal); await new Promise(r => setImmediate(r)); c.abort(); release();
  await assert.rejects(run, { code: 'API_CANCELLED' }); assert.equal(s.calls, 0); assert.equal((await s.status()).networkAttempts, 0);
});
test('close cancels underlying transport and cannot report success', async () => {
  let gotSignal; const s = setup({ transport: ({ signal }) => new Promise((_, reject) => { gotSignal = signal; signal.addEventListener('abort', () => reject(Error('abort')), { once: true }); }) });
  const run = s.run(); await new Promise(r => setImmediate(r)); await s.runtime.close(); await assert.rejects(run, { code: 'API_CANCELLED' }); assert.equal(gotSignal.aborted, true);
});
test('unconfirmed helper termination quarantines the bridge until restart', async () => {
  const s = setup({ helpers: { approve: async () => { throw Object.assign(Error('fixed'), { code: 'HELPER_TERMINATION_UNCONFIRMED' }); } } });
  await assert.rejects(s.run(), { code: 'API_OPERATION_REJECTED' }); assert.equal((await s.status()).helperQuarantined, true);
  await assert.rejects(s.run(), { code: 'API_LOCAL_HELPER_UNCONFIRMED' }); assert.equal(s.calls, 0);
});
test('outer Proxy and accessor arguments are rejected without invocation', async () => {
  const s = setup(); let invoked = 0;
  const proxy = new Proxy({}, { getPrototypeOf() { invoked++; throw Error(); } });
  await assert.rejects(s.runtime.callTool('cachepilot_api_request', proxy), { code: 'API_ARGUMENTS_REJECTED' });
  const accessor = { body: body() }; Object.defineProperty(accessor, 'profileId', { enumerable: true, get() { invoked++; return 'fixture'; } });
  await assert.rejects(s.runtime.callTool('cachepilot_api_request', accessor), { code: 'API_ARGUMENTS_REJECTED' }); assert.equal(invoked, 0);
});
