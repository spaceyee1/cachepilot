import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApiRuntime } from '../api/runtime.mjs';
import { SemanticResponseCache } from '../api/semantic-cache.mjs';

// All identities, secrets, vectors and provider responses below are synthetic.
// Run with --import ./tests/offline-guard.mjs; no model or provider is contacted.
const query = 'Explain how leaves transform sunlight into nourishment';
const paraphrase = 'Describe how plants turn sunlight into nourishment';
const secret = 'synthetic-credential-never-a-provider-key';
const native = (text = query, extra = {}) => ({ model: 'fixture-model',
  messages: [{ role: 'user', content: text }], temperature: 0,
  max_completion_tokens: 16, ...extra });
const makeProfile = () => ({ version: 1, id: 'semantic-fixture', label: 'offline fixture',
  protocol: 'openai-chat', baseUrl: 'https://api.provider.com/v1', model: 'fixture-model',
  credentialGeneration: randomUUID(), networkEnabled: true,
  limits: { maxRequests: 20, maxInputBytes: 65536, maxTotalInputBytes: 1048576,
    maxOutputTokens: 64, maxTotalOutputTokens: 1024, timeoutMs: 1000 } });
const answer = () => ({ data: { model: 'fixture-model', choices: [{
  finish_reason: 'stop', message: { role: 'assistant', content: 'Synthetic textual explanation.' } }],
  usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110,
    prompt_tokens_details: { cached_tokens: 60 } } },
  timing: { dnsMs: 1, tlsMs: 2, firstByteMs: 3, totalMs: 4 } });
const tick = () => new Promise(resolve => setImmediate(resolve));
test('native gateway bypasses semantic lookup while cache provenance cannot be exposed', async () => {
  const profile = makeProfile(); let execute, sent = 0, lookups = 0;
  const cache = { status: () => ({ epoch: 0 }), clear() {}, lookup() { lookups++; throw Error('must not run'); } };
  const runtime = createApiRuntime({ semanticCache: cache, source: 'offline_fixture',
    getProfile: async () => profile, listProfiles: async () => [profile],
    helpers: { approve: async () => true, credential: async () => secret, showGateway: async () => true },
    openGateway: async options => { execute = options.execute; return { address: 'http://127.0.0.1:9999', token: 'synthetic',
      expiresAt: Date.now() + 1000, status: () => ({ listening: true }), close: async () => {} }; },
    transport: async () => { sent++; return answer(); } });
  try {
    await runtime.callTool('cachepilot_api_gateway_start', { profileId: profile.id });
    await execute(JSON.stringify(native()), {}); await execute(JSON.stringify(native()), {});
    assert.equal(lookups, 0); assert.equal(sent, 2);
  } finally { await runtime.close(); }
});
function setup(t, { embed = async () => [1, 0, 0], cacheOptions = {}, cache: suppliedCache,
  helpers: customHelpers = {}, transport: customTransport, withoutCache = false } = {}) {
  let selected = makeProfile(), currentSecret = secret, approvals = 0, credentials = 0, encodes = 0;
  const submissions = [];
  const cache = withoutCache ? null : suppliedCache ?? new SemanticResponseCache({
    embed: async (...args) => { encodes++; return embed(...args); },
    encoderId: 'synthetic-offline-encoder', ...cacheOptions });
  const helpers = {
    approve: async (...args) => { approvals++; return customHelpers.approve ? customHelpers.approve(...args) : true; },
    credential: async (...args) => { credentials++; return customHelpers.credential ? customHelpers.credential(...args) : currentSecret; },
  };
  const runtime = createApiRuntime({ source: 'offline_fixture', semanticCache: cache,
    getProfile: async () => selected, listProfiles: async () => [selected], helpers,
    transport: async params => { submissions.push(params.request.body); await params.beforeSubmit();
      return customTransport ? customTransport(params) : answer(); } });
  t.after(() => runtime.close());
  return { runtime, cache, submissions,
    get profile() { return selected; }, replace(value) { selected = value; },
    setSecret(value) { currentSecret = value; },
    get approvals() { return approvals; }, get credentials() { return credentials; },
    get encodes() { return encodes; },
    run: (body = native(), signal) => runtime.callTool('cachepilot_api_request', { profileId: selected.id, body }, { signal }),
    status: () => runtime.callTool('cachepilot_api_status', {}),
    clear: () => runtime.callTool('cachepilot_api_cache_clear', {}),
  };
}
async function seed(s) { const first = await s.run(); assert.equal(first.sent, true); assert.equal(s.submissions.length, 1); return first; }
function localHit(value) {
  assert.equal(value.sent, false); assert.equal(value.source, 'local_semantic_cache');
  assert.equal(value.localResponseCache.hit, true);
  assert.equal(value.cacheUsageFieldsReported, false); assert.equal(value.providerCacheMeasured, false);
  assert.equal(value.usage.inputTokens, null); assert.equal(value.usage.cachedInputTokens, null);
  assert.equal(value.usage.outputTokens, null); assert.equal(value.usage.source, 'local_semantic_cache');
  assert.equal(Object.hasOwn(value.response, 'usage'), false);
  assert.equal(value.automaticRetries, 0); assert.equal(value.normalizationEnabled, false);
  assert.equal(value.promptModified, false); assert.equal(value.optimizationGainMeasured, false);
  assert.equal(value.identityStatus, 'unverified'); assert.equal(value.actualTenantVerified, false);
  assert.equal(value.actualModelVersionVerified, false); assert.equal(value.includesHostChatUsage, false);
}

test('semantic response reuse still requires fresh local approval and credential binding', async t => {
  const s = setup(t); await seed(s); const hit = await s.run(native(paraphrase));
  localHit(hit); assert.equal(hit.localResponseCache.match, 'semantic');
  assert.equal(s.submissions.length, 1); assert.equal(s.approvals, 2); assert.equal(s.credentials, 2);
});
test('local hit never replays historical provider usage or adds provider ledger counts', async t => {
  const s = setup(t); await seed(s); const before = await s.status();
  const hit = await s.run(native(paraphrase)); localHit(hit);
  const after = await s.status(); assert.deepEqual(after.scopes, before.scopes);
  assert.equal(after.networkAttempts, before.networkAttempts);
  assert.equal(hit.budget.requestsReserved, 1); assert.equal(hit.budget.outputTokensReserved, 16);
  for (let i = 0; i < 3; i++) assert.deepEqual((await s.status()).scopes, before.scopes);
});
test('exact local response reuse is labeled exact rather than a cloud cache hit', async t => {
  const s = setup(t); await seed(s); const value = await s.run();
  localHit(value); assert.equal(value.localResponseCache.match, 'exact');
});
test('denial of the second approval cannot serve an already cached response', async t => {
  let allow = true; const s = setup(t, { helpers: { approve: async () => allow } });
  await seed(s); allow = false;
  await assert.rejects(s.run(native(paraphrase)), { code: 'API_APPROVAL_DENIED' });
  assert.equal(s.submissions.length, 1); assert.equal(s.credentials, 1);
});
test('a disabled profile cannot return a cached response', async t => {
  const s = setup(t); await seed(s); s.replace({ ...s.profile, networkEnabled: false });
  await assert.rejects(s.run(), { code: 'API_NETWORK_DISABLED' });
  assert.equal(s.approvals, 1); assert.equal(s.credentials, 1); assert.equal(s.submissions.length, 1);
});
test('local reuse cannot bypass a reserved request cap', async t => {
  const s = setup(t); s.replace({ ...s.profile, limits: { ...s.profile.limits, maxRequests: 1 } });
  await seed(s); await assert.rejects(s.run(), { code: 'API_BUDGET_EXHAUSTED' });
  assert.equal(s.submissions.length, 1); assert.equal(s.approvals, 1);
});
test('unknown billing usage still pauses the profile before any local hit', async t => {
  const s = setup(t, { transport: async () => { const a = answer(); delete a.data.usage; return a; } });
  await seed(s); await assert.rejects(s.run(), { code: 'API_BUDGET_EXHAUSTED' });
  assert.equal(s.submissions.length, 1);
});
test('preview never embeds, approves, reads credentials or sends a request', async t => {
  const s = setup(t); const value = await s.runtime.callTool('cachepilot_api_preview', { profileId: s.profile.id, body: native() });
  assert.equal(value.sent, false); assert.equal(s.encodes, 0); assert.equal(s.approvals, 0);
  assert.equal(s.credentials, 0); assert.equal(s.submissions.length, 0);
});
test('without an injected semantic cache the existing request path is unchanged', async t => {
  const s = setup(t, { withoutCache: true }); await seed(s); const second = await s.run(native(paraphrase));
  assert.equal(second.sent, true); assert.equal(s.submissions.length, 2);
  assert.equal((await s.status()).networkAttempts, 2);
});
for (const field of ['id', 'credentialGeneration', 'baseUrl', 'model']) {
  test(`a different ${field} cannot read an older response`, async t => {
    const s = setup(t); await seed(s);
    const value = field === 'credentialGeneration' ? randomUUID() : field === 'baseUrl'
      ? 'https://other.provider.com/v1' : field === 'model' ? 'other-fixture-model' : 'other-fixture';
    s.replace({ ...s.profile, [field]: value });
    const result = await s.run(native(paraphrase, { model: s.profile.model }));
    assert.equal(result.sent, true); assert.equal(s.submissions.length, 2);
  });
}
test('a different decrypted credential cannot share a cache scope even with unchanged metadata', async t => {
  const s = setup(t); await seed(s); s.setSecret('different-synthetic-credential-never-real');
  const result = await s.run(native(paraphrase)); assert.equal(result.sent, true);
  assert.equal(s.submissions.length, 2);
});
for (const [label, change] of [
  ['history content', b => ({ ...b, messages: [{ role: 'user', content: 'Earlier context changed' }, ...b.messages] })],
  ['history role', b => ({ ...b, messages: [{ role: 'system', content: query }, ...b.messages] })],
  ['tool definitions', b => ({ ...b, tools: [{ type: 'function', function: { name: 'fixture_tool', parameters: { type: 'object', properties: {} } } }] })],
  ['tool choice', b => ({ ...b, tool_choice: 'none' })],
  ['sampling parameters', b => ({ ...b, top_p: 0.5 })],
  ['output bound', b => ({ ...b, max_completion_tokens: 15 })],
  ['response format', b => ({ ...b, response_format: { type: 'json_object' } })],
]) test(`changing ${label} cannot reuse the old response`, async t => {
  const s = setup(t); await seed(s); const changed = change(native(paraphrase));
  assert.equal((await s.run(changed)).sent, true); assert.equal(s.submissions.length, 2);
});
for (const [label, text] of [
  ['number', 'Explain how plants convert 12 units of light into nourishment'],
  ['negation', 'Do not explain how plants turn sunlight into nourishment'],
  ['uncontracted negation', 'Explain why plants cannot turn sunlight into nourishment'],
  ['quoted literal', 'Describe the literal phrase "plants turn sunlight into nourishment"'],
  ['URL', 'Explain https://example.invalid/photosynthesis'],
]) test(`an identical fake vector cannot bypass the ${label} guard`, async t => {
  const s = setup(t); await seed(s); assert.equal((await s.run(native(text))).sent, true);
  assert.equal(s.submissions.length, 2);
});
test('cache clear removes response reuse without rewriting provider accounting', async t => {
  const s = setup(t); await seed(s); const before = await s.status(); await s.clear();
  assert.deepEqual((await s.status()).scopes, before.scopes);
  assert.equal((await s.run(native(paraphrase))).sent, true); assert.equal(s.submissions.length, 2);
});
test('a rotating profile during embedding discards the pending hit', async t => {
  let hold = false, release; const s = setup(t, { embed: async () => {
    if (hold) return new Promise(resolve => { release = () => resolve([1, 0, 0]); }); return [1, 0, 0]; } });
  await seed(s); hold = true; const pending = s.run(native(paraphrase)); await tick(); assert.equal(typeof release, 'function');
  s.replace({ ...s.profile, credentialGeneration: randomUUID() }); release();
  await assert.rejects(pending, { code: 'API_PROFILE_CHANGED' }); assert.equal(s.submissions.length, 1);
});
test('caller cancellation during embedding cannot return a stale cached response', async t => {
  let hold = false, release; const s = setup(t, { embed: async () => {
    if (hold) return new Promise(resolve => { release = () => resolve([1, 0, 0]); }); return [1, 0, 0]; } });
  await seed(s); hold = true; const controller = new AbortController(); const pending = s.run(native(paraphrase), controller.signal);
  await tick(); assert.equal(typeof release, 'function'); controller.abort(); release();
  await assert.rejects(pending, { code: 'API_CANCELLED' }); assert.equal(s.submissions.length, 1);
});
test('cache clear during embedding cannot return the pre-clear response', async t => {
  let hold = false, release; const s = setup(t, { embed: async () => {
    if (hold) return new Promise(resolve => { release = () => resolve([1, 0, 0]); }); return [1, 0, 0]; } });
  await seed(s); hold = true; const pending = s.run(native(paraphrase)); await tick(); assert.equal(typeof release, 'function');
  await s.clear(); release(); const result = await pending;
  assert.equal(result.sent, true); assert.equal(result.localResponseCache.hit, false); assert.equal(s.submissions.length, 2);
});
test('the active lock also covers a pending local embedding lookup', async t => {
  let hold = false, release; const s = setup(t, { embed: async () => {
    if (hold) return new Promise(resolve => { release = () => resolve([1, 0, 0]); }); return [1, 0, 0]; } });
  await seed(s); hold = true; const pending = s.run(native(paraphrase)); await tick();
  await assert.rejects(s.run(), { code: 'API_BUSY' }); release(); localHit(await pending);
  assert.equal(s.submissions.length, 1); assert.equal(s.approvals, 2);
});
test('closing the runtime during embedding cannot commit or leak a local response', async t => {
  let hold = false, release; const s = setup(t, { embed: async () => {
    if (hold) return new Promise(resolve => { release = () => resolve([1, 0, 0]); }); return [1, 0, 0]; } });
  await seed(s); hold = true; const pending = s.run(native(paraphrase)); await tick();
  await s.runtime.close(); release(); await assert.rejects(pending, { code: 'API_CANCELLED' });
  assert.equal(s.submissions.length, 1);
});
for (const [label, embed] of [
  ['exception', async () => { throw Error('synthetic encoder error'); }],
  ['NaN vector', async () => [NaN, 0, 0]],
  ['empty vector', async () => []],
  ['zero norm', async () => [0, 0, 0]],
]) test(`encoder ${label} falls back to exactly one original request`, async t => {
  const s = setup(t, { embed }); const input = native(); const value = await s.run(input);
  assert.equal(value.sent, true); assert.equal(value.automaticRetries, 0); assert.equal(s.submissions.length, 1);
  assert.equal(s.submissions[0], JSON.stringify(input)); assert.equal((await s.status()).networkAttempts, 1);
});
for (const [label, mutate] of [
  ['tool calls', a => { a.data.choices[0].message.tool_calls = [{ id: 'call', type: 'function', function: { name: 'fixture', arguments: '{}' } }]; }],
  ['refusal', a => { a.data.choices[0].message.refusal = 'Synthetic refusal'; }],
  ['truncation', a => { a.data.choices[0].finish_reason = 'length'; }],
]) test(`a response containing ${label} is not reused`, async t => {
  const s = setup(t, { transport: async () => { const a = answer(); mutate(a); return a; } });
  await seed(s); assert.equal((await s.run(native(paraphrase))).sent, true); assert.equal(s.submissions.length, 2);
});
test('cache storage receives only redacted output and never exposes the credential', async t => {
  const s = setup(t, { transport: async () => { const a = answer(); a.data.choices[0].message.content += ` ${secret}`; return a; } });
  await seed(s); const hit = await s.run(native(paraphrase)); localHit(hit);
  assert.equal(JSON.stringify(hit).includes(secret), false); assert.match(hit.response.choices[0].message.content, /\[REDACTED\]/);
  assert.equal(JSON.stringify(await s.status()).includes(secret), false);
});
test('the test process keeps external network denied throughout this suite', () => {
  assert.ok(globalThis[Symbol.for('cachepilot.offline')], 'preload tests/offline-guard.mjs');
  assert.equal(globalThis[Symbol.for('cachepilot.offline')].denied, 0);
});
