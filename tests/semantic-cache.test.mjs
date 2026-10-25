import test from 'node:test';
import assert from 'node:assert/strict';
import { SemanticResponseCache, createSemanticCache } from '../api/semantic-cache.mjs';

// These labelled vectors test cache mechanics only. They are not measurements
// of a real encoder's semantic accuracy, hit rate, or cloud cache behaviour.
const first = 'Explain the purpose of photosynthesis';
const paraphrase = 'Describe why photosynthesis matters';
const source = text => JSON.stringify({ model: 'fixture-model', temperature: 0, messages: [{ role: 'user', content: text }], max_tokens: 32 });
const request = (text = first, extra = {}) => ({ scope: 'opaque-local-credential-model-partition', protocol: 'openai-chat', body: source(text), ...extra });
const response = (text = 'A complete fixture answer') => ({ id: 'original-request', created: 1, model: 'fixture-model',
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5 } });
const degrees = n => [Math.cos(n * Math.PI / 180), Math.sin(n * Math.PI / 180)];
const cache = options => new SemanticResponseCache({ encoderId: 'fixture-encoder-sha256', embed: async () => [1, 0], ...options });
async function seed(c, req = request(), value = response()) {
  const result = await c.lookup(req); assert.equal(result.hit, false); assert.ok(result.ticket); assert.equal(await c.store(result.ticket, value), true); return result;
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('exact response reuse is local, cloned, and does not replay provider usage or request identity', async () => {
  const c = cache(); const input = response(); await seed(c, request(), input); input.choices[0].message.content = 'mutated';
  const result = await c.lookup(request()); assert.equal(result.hit, true); assert.equal(result.match, 'exact');
  assert.equal(result.response.choices[0].message.content, 'A complete fixture answer');
  assert.equal(result.response.usage, undefined); assert.equal(result.response.id, undefined); assert.equal(result.response.created, undefined);
  result.response.choices[0].message.content = 'caller mutation';
  assert.equal((await c.lookup(request())).response.choices[0].message.content, 'A complete fixture answer');
  assert.equal(result.ticket, undefined); assert.equal(result.lookupEpoch, 0);
  const status = c.status(); assert.equal(status.providerCacheMeasured, false); assert.equal(status.semanticEquivalenceGuaranteed, false);
  assert.equal(status.exactHits, 2); assert.equal(status.semanticHits, 0); assert.equal(status.statisticsScope, 'this_process_local_response_reuse_only');
  assert.ok(!JSON.stringify(status).includes(first));
});
test('cosine retrieval uses actual vectors rather than text similarity and never creates transitive aliases', async () => {
  const third = 'Outline how plants use light', vectors = new Map([[first, degrees(0)], [paraphrase, degrees(5)], [third, degrees(10)]]);
  const c = cache({ threshold: 0.99, embed: async text => vectors.get(text) }); await seed(c);
  const b = await c.lookup(request(paraphrase)); assert.equal(b.match, 'semantic'); assert.equal(b.hit, true); assert.equal(b.ticket, undefined);
  assert.equal(c.status().entries, 1); const thirdResult = await c.lookup(request(third)); assert.equal(thirdResult.hit, false);
  assert.ok(thirdResult.ticket); assert.equal(c.status().entries, 1);
});
test('visually similar queries with dissimilar fixture vectors do not match', async () => {
  const c = cache({ embed: async text => text === first ? [1, 0] : [0, 1] }); await seed(c);
  assert.equal((await c.lookup(request(first + ' please'))).hit, false);
});
test('high similarity with ambiguous neighbours is a miss', async () => {
  const middle = 'Summarize the role of photosynthesis', vectors = new Map([[first, degrees(0)], [paraphrase, degrees(20)], [middle, degrees(10)]]);
  const c = cache({ embed: async text => vectors.get(text) }); await seed(c); await seed(c, request(paraphrase), response('Different complete answer'));
  const result = await c.lookup(request(middle)); assert.equal(result.hit, false); assert.equal(result.reason, 'ambiguous_neighbours'); assert.equal(c.status().ambiguous, 1);
});
test('scope and protocol are strict isolated partitions, including simulated identity metadata changes', async () => {
  const c = cache(); await seed(c);
  for (const part of ['tenant-changed', 'credential-generation-changed', 'endpoint-changed', 'model-revision-changed', 'encoder-fingerprint-changed']) {
    assert.equal((await c.lookup(request(first, { scope: `opaque-${part}` }))).hit, false, part);
  }
  assert.equal((await c.lookup(request(first, { protocol: 'deepseek-chat' }))).hit, false);
  // Fixture scopes only test isolation. Actual host tenant/revision discovery is
  // outside this module and remains unverified if the host does not expose it.
});
test('history, role, message order, model and generation parameters bind the exact envelope', async () => {
  const base = JSON.parse(source(first)); base.messages.unshift({ role: 'system', content: 'Stable fixture instructions' }, { role: 'assistant', content: 'Earlier complete reply' });
  const c = cache(); await seed(c, request(first, { body: JSON.stringify(base) }));
  const variants = [
    b => { b.messages[0].content = 'Changed fixture instructions'; },
    b => { b.messages[0].role = 'developer'; },
    b => { b.messages[1].content = 'Changed earlier reply'; },
    b => { [b.messages[0], b.messages[1]] = [b.messages[1], b.messages[0]]; },
    b => { b.model = 'different-fixture-model'; },
    b => { b.max_tokens = 64; },
    b => { b.top_p = 0.9; },
    b => { b.messages.at(-1).name = 'another-user'; },
  ];
  for (const mutate of variants) { const b = structuredClone(base); mutate(b); assert.equal((await c.lookup(request(first, { body: JSON.stringify(b) }))).hit, false); }
});
test('final text content representation is not normalized across string and block forms', async () => {
  const c = cache(); await seed(c); const b = JSON.parse(source(first)); b.messages[0].content = [{ type: 'text', text: first }];
  assert.equal((await c.lookup(request(first, { body: JSON.stringify(b) }))).hit, false);
});
test('temperature must explicitly equal zero and no tools or non-text final input are eligible', async () => {
  const c = cache(); const mutations = [
    b => { delete b.temperature; }, b => { b.temperature = 0.1; }, b => { b.temperature = '0'; },
    b => { b.tools = [{ type: 'function', function: { name: 'fixture' } }]; },
    b => { b.tool_choice = 'none'; }, b => { b.parallel_tool_calls = true; },
    b => { b.messages[0].role = 'assistant'; }, b => { b.messages[0].content = [{ type: 'text', text: first }, { type: 'text', text: 'extra' }]; },
    b => { b.messages[0].content = [{ type: 'image_url', image_url: { url: 'https://invalid.example/image' } }]; },
    b => { b.messages.unshift({ role: 'tool', content: 'result', tool_call_id: 'fixture' }); },
    b => { b.stream = true; }, b => { b.store = true; }, b => { b.background = true; },
  ];
  for (const mutate of mutations) { const b = JSON.parse(source(first)); mutate(b); const result = await c.lookup(request(first, { body: JSON.stringify(b) })); assert.equal(result.reason, 'request_ineligible'); assert.equal(result.ticket, undefined); }
});
test('empty, missing, object, malformed, oversized and dangerous-key request inputs fail closed', async () => {
  const c = cache();
  for (const body of ['', '{', '{}', JSON.parse(source(first)), ' '.repeat(65_537), '{"__proto__":{"polluted":true}}']) {
    const result = await c.lookup(request(first, { body })); assert.equal(result.reason, 'request_ineligible'); assert.equal(result.ticket, undefined);
  }
  for (const scope of ['', ' ', null, undefined, 'x'.repeat(4_097)]) assert.equal((await c.lookup(request(first, { scope }))).reason, 'scope_unverified');
  assert.equal(({}).polluted, undefined);
});
test('dangerous literals allow exact-only reuse and reject approximate changed or unchanged literal queries', async () => {
  for (const query of ['Explain page 12', 'Read https://invalid.example/path', 'Explain "literal text"', 'Explain `sample`',
    'Do not omit context', 'Explain why plants cannot turn sunlight into nourishment', 'Explain why plants are unable to grow',
    'Explain neither growth nor decline', 'Deny access', 'Forbidden action', '禁止修改', '不能遗漏',
    'Compare larger and smaller items', 'Read C:\\local\\file', '至少保留全部内容', 'Tell me the latest news']) {
    const c = cache(); await seed(c, request(query)); assert.equal((await c.lookup(request(query))).match, 'exact');
    const result = await c.lookup(request(query + ' please')); assert.equal(result.hit, false); assert.equal(result.reason, 'literal_guard_exact_only');
    assert.equal((await c.lookup(request(paraphrase))).hit, false, 'guarded seed cannot supply an unguarded semantic answer');
  }
});
test('English-only encoder never approximates non-ASCII queries even with identical fixture embeddings', async () => {
  const c = cache(); await seed(c, request('解释光合作用的作用'));
  assert.equal((await c.lookup(request('解释光合作用的作用'))).match, 'exact');
  const different = await c.lookup(request('解释如何关闭进程')); assert.equal(different.hit, false); assert.equal(different.reason, 'literal_guard_exact_only');
  assert.equal((await c.lookup(request(paraphrase))).hit, false); assert.equal(c.status().semanticLanguage, 'en'); assert.equal(c.status().nonEnglishPolicy, 'exact_only');
  assert.throws(() => cache({ semanticLanguage: 'zh' }), TypeError);
});
test('guarded or unsupported-language text reuses exact responses without starting an unavailable encoder', async () => {
  for (const query of ['解释光合作用的作用', 'Explain why plants cannot grow', 'Read page 12', 'Read https://invalid.example/path']) {
    let calls = 0; const c = cache({ embed: () => { calls++; throw Error('offline encoder unavailable'); } });
    const miss = await c.lookup(request(query)); assert.equal(miss.reason, 'literal_guard_exact_only'); assert.ok(miss.ticket);
    assert.equal(c.status().ticketBytes, 256); assert.equal(await c.store(miss.ticket, response()), true);
    assert.equal((await c.lookup(request(query))).match, 'exact');
    const changed = await c.lookup(request(query + ' please')); assert.equal(changed.hit, false);
    assert.equal(changed.reason, 'literal_guard_exact_only'); assert.equal(calls, 0); assert.equal(c.status().pendingEmbeddings, 0);
  }
});
test('TTL expires at the boundary, and an expired answer is not returned', async () => {
  let tick = 0; const c = cache({ now: () => tick, ttlMs: 100 }); await seed(c); tick = 99; assert.equal((await c.lookup(request())).hit, true);
  tick = 100; assert.equal((await c.lookup(request())).hit, false); assert.equal(c.status().expired, 1); assert.equal(c.status().entries, 0);
});
test('LRU entry bound keeps recently accessed responses and evicts older entries', async () => {
  const c = cache({ maxEntries: 2 }); await seed(c, request('fixture 1')); await seed(c, request('fixture 2'));
  assert.equal((await c.lookup(request('fixture 1'))).hit, true); await seed(c, request('fixture 3'));
  assert.equal((await c.lookup(request('fixture 2'))).hit, false); assert.equal((await c.lookup(request('fixture 1'))).hit, true);
  assert.equal(c.status().entries, 2); assert.equal(c.status().evicted, 1);
});
test('response byte bound rejects an oversized item and memory accounting returns to zero on clear', async () => {
  const c = cache({ maxBytes: 512 }); const miss = await c.lookup(request());
  assert.equal(await c.store(miss.ticket, response('x'.repeat(1_000))), false); assert.equal(c.status().entries, 0);
  await seed(c); assert.ok(c.status().bytes > 0); c.clear(); assert.equal(c.status().bytes, 0); assert.equal(c.status().ticketBytes, 0); assert.equal(c.status().epoch, 1);
});
test('pending tickets have independent count and memory bounds and expire', async () => {
  let tick = 0; const c = cache({ maxEntries: 2, ticketTtlMs: 20, now: () => tick });
  const old = await c.lookup(request('fixture 1')); await c.lookup(request('fixture 2')); await c.lookup(request('fixture 3'));
  assert.equal(c.status().pendingTickets, 2); assert.equal(c.status().evictedTickets, 1); assert.equal(await c.store(old.ticket, response()), false);
  tick = 20; assert.equal(c.status().pendingTickets, 0); assert.equal(c.status().ticketBytes, 0);
});
test('tickets cannot be forged, reused, mutated or used across cache instances', async () => {
  const a = cache(), b = cache(), miss = await a.lookup(request()); assert.equal(Object.isFrozen(miss.ticket), true); assert.deepEqual(Object.keys(miss.ticket), []);
  assert.equal(await a.store({}, response()), false); assert.equal(await b.store(miss.ticket, response()), false);
  assert.equal(await a.store(miss.ticket, response()), true); assert.equal(await a.store(miss.ticket, response()), false);
});
test('clear invalidates previously issued tickets and increments epoch', async () => {
  const c = cache(), miss = await c.lookup(request()); c.clear(); assert.equal(await c.store(miss.ticket, response()), false);
  assert.equal(c.status().entries, 0); assert.equal(c.status().epoch, 1);
});
test('cancellation while embedding discards late results and cannot issue a writable ticket', async () => {
  let finish; const controller = new AbortController(); const c = cache({ embed: () => new Promise(resolve => { finish = resolve; }) });
  const pending = c.lookup(request(first, { signal: controller.signal })); await turn(); controller.abort();
  const result = await pending; assert.equal(result.reason, 'cancelled'); assert.equal(result.ticket, undefined);
  finish([1, 0]); await turn(); assert.equal(c.status().entries, 0); assert.equal(c.status().pendingEmbeddings, 0);
});
test('clear during embedding cancels the old epoch without committing a late result', async () => {
  let finish; const c = cache({ embed: () => new Promise(resolve => { finish = resolve; }) }); const pending = c.lookup(request());
  await turn(); c.clear(); const result = await pending; assert.equal(result.reason, 'cache_cleared'); assert.equal(result.lookupEpoch, 0); assert.equal(result.ticket, undefined);
  finish([1, 0]); await turn(); assert.equal(c.status().entries, 0); assert.equal(c.status().epoch, 1);
});
test('cancelled store consumes its ticket and cannot submit on a later retry', async () => {
  const c = cache(), miss = await c.lookup(request()), controller = new AbortController(); controller.abort();
  assert.equal(await c.store(miss.ticket, response(), { signal: controller.signal }), false); assert.equal(await c.store(miss.ticket, response()), false);
  assert.equal(c.status().entries, 0);
});
test('embedding timeout holds the uncooperative encoder slot until actual completion', async () => {
  let finish; const c = cache({ maxPending: 1, embedTimeoutMs: 5, embed: () => new Promise(resolve => { finish = resolve; }) });
  const result = await c.lookup(request()); assert.equal(result.reason, 'embedding_timeout'); assert.equal(result.ticket, undefined);
  assert.equal(c.status().pendingEmbeddings, 1); assert.equal((await c.lookup(request(paraphrase))).reason, 'embedding_busy');
  finish([1, 0]); await turn(); assert.equal(c.status().pendingEmbeddings, 0); assert.equal(c.status().entries, 0);
});
test('pre-aborted lookup never calls the encoder', async () => {
  let called = 0; const c = cache({ embed: () => { called++; return [1, 0]; } }), controller = new AbortController(); controller.abort();
  assert.equal((await c.lookup(request(first, { signal: controller.signal }))).reason, 'cancelled'); assert.equal(called, 0);
});
test('non-finite, zero, short, huge, sparse and accessor vectors cannot produce tickets', async () => {
  let touched = false; const accessor = [1, 0]; Object.defineProperty(accessor, '1', { get() { touched = true; return 0; } });
  const proxy = new Proxy([1, 0], { get() { touched = true; throw Error('must not inspect'); }, getPrototypeOf() { touched = true; throw Error('must not inspect'); } });
  for (const bad of [[NaN, 1], [Infinity, 1], [0, 0], [1], new Array(8_193).fill(1), [1, , 0], accessor, proxy, { vector: [1, 0] }]) {
    const c = cache({ embed: () => bad }); const result = await c.lookup(request()); assert.equal(result.reason, 'embedding_failed'); assert.equal(result.ticket, undefined);
  }
  assert.equal(touched, false);
});
test('large finite vectors normalize without overflow; typed vectors are supported and cloned', async () => {
  const vector = new Float64Array([Number.MAX_VALUE, Number.MAX_VALUE]); const c = cache({ embed: async () => vector }); await seed(c);
  vector[0] = 0; vector[1] = 0; assert.equal((await c.lookup(request())).hit, true);
});
test('dimension drift is rejected for a pinned encoder identity', async () => {
  let dimension = 2; const c = cache({ embed: async () => new Array(dimension).fill(1) }); await seed(c); dimension = 3;
  const result = await c.lookup(request(paraphrase)); assert.equal(result.reason, 'embedding_dimension_changed'); assert.equal(result.ticket, undefined);
});
test('responses with refusal, tools, truncation, multiple choices, errors or non-text content are not stored', async () => {
  const variants = [
    r => { r.choices[0].finish_reason = 'length'; }, r => { r.choices[0].finish_reason = 'tool_calls'; },
    r => { r.choices[0].message.tool_calls = []; }, r => { r.choices[0].message.refusal = 'refused'; },
    r => { r.choices[0].message.content = null; }, r => { r.choices[0].message.content = [{ type: 'text', text: 'text' }]; },
    r => { r.choices[0].message.role = 'user'; }, r => { r.choices.push(structuredClone(r.choices[0])); },
    r => { r.error = { message: 'error' }; }, r => { r.choices[0].message.annotations = [{ url: 'https://invalid.example' }]; },
    r => { delete r.choices[0].finish_reason; },
  ];
  for (const mutate of variants) { const c = cache(), miss = await c.lookup(request()), value = response(); mutate(value); assert.equal(await c.store(miss.ticket, value), false); assert.equal(c.status().entries, 0); }
});
test('response objects cannot execute getters, Proxy traps or toJSON, or pollute prototypes', async () => {
  let touched = false; const value = response(); Object.defineProperty(value, 'attack', { enumerable: true, get() { touched = true; return 1; } });
  const proxy = new Proxy({}, { get() { touched = true; throw Error('unexpected'); }, getPrototypeOf() { touched = true; throw Error('unexpected'); } });
  for (const bad of [value, proxy, { ...response(), toJSON() { touched = true; return {}; } }, JSON.parse('{"__proto__":{"polluted":true}}')]) {
    const c = cache(), miss = await c.lookup(request()); assert.equal(await c.store(miss.ticket, bad), false);
  }
  assert.equal(touched, false); assert.equal(({}).polluted, undefined);
});
test('factory has no provider measurement and rejects unsafe configuration limits', () => {
  assert.equal(createSemanticCache({ encoderId: 'fixture', embed: async () => [1, 0] }).status().persistent, false);
  for (const options of [{ embed: undefined }, { encoderId: '' }, { threshold: 0.8 }, { threshold: NaN }, { margin: 0 },
    { maxEntries: 0 }, { maxBytes: Infinity }, { ttlMs: -1 }, { maxPending: 17 }, { embedTimeoutMs: 30_001 }, { ticketTtlMs: 0 }]) {
    assert.throws(() => cache(options), TypeError);
  }
});

const nativeFixtures = {
  'openai-chat': { body: JSON.parse(source(first)), response: response() },
  'deepseek-chat': { body: JSON.parse(source(first)), response: response() },
  'openai-responses': {
    body: { model: 'fixture-model', temperature: 0, input: first, max_output_tokens: 32, store: false },
    response: { id: 'fixture-id', status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Complete answer', annotations: [] }] }], usage: { input_tokens: 20 } },
  },
  'anthropic-messages': {
    body: { model: 'fixture-model', temperature: 0, messages: [{ role: 'user', content: [{ type: 'text', text: first }] }], max_tokens: 32 },
    response: { id: 'fixture-id', type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Complete answer' }], usage: { input_tokens: 20 } },
  },
  gemini: {
    body: { contents: [{ role: 'user', parts: [{ text: first }] }], generationConfig: { temperature: 0, maxOutputTokens: 32 } },
    response: { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'Complete answer' }] } }], usageMetadata: { promptTokenCount: 20 } },
  },
};
for (const [protocol, fixture] of Object.entries(nativeFixtures)) {
  test(`${protocol}: complete single-text native responses support exact and semantic retrieval with no usage replay`, async () => {
    const c = cache(); const req = request(first, { protocol, body: JSON.stringify(fixture.body) }); await seed(c, req, fixture.response);
    const exact = await c.lookup(req); assert.equal(exact.match, 'exact'); assert.equal(exact.response.usage, undefined); assert.equal(exact.response.usageMetadata, undefined);
    const body = structuredClone(fixture.body);
    if (protocol === 'gemini') body.contents[0].parts[0].text = paraphrase;
    else if (protocol === 'openai-responses') body.input = paraphrase;
    else if (Array.isArray(body.messages[0].content)) body.messages[0].content[0].text = paraphrase;
    else body.messages[0].content = paraphrase;
    const result = await c.lookup({ ...req, body: JSON.stringify(body) }); assert.equal(result.match, 'semantic'); assert.equal(result.hit, true);
  });
}
test('native incomplete Responses, Anthropic and Gemini responses remain uncached', async () => {
  const cases = [
    ['openai-responses', r => { r.status = 'incomplete'; }],
    ['openai-responses', r => { r.output[0].content[0] = { type: 'refusal', refusal: 'refused' }; }],
    ['anthropic-messages', r => { r.stop_reason = 'max_tokens'; }],
    ['anthropic-messages', r => { r.content.push({ type: 'tool_use', id: 'fixture' }); }],
    ['gemini', r => { r.candidates[0].finishReason = 'MAX_TOKENS'; }],
    ['gemini', r => { r.promptFeedback = { blockReason: 'SAFETY' }; }],
    ['gemini', r => { r.candidates[0].content.parts[0] = { functionCall: { name: 'fixture' } }; }],
  ];
  for (const [protocol, mutate] of cases) {
    const c = cache(), fixture = nativeFixtures[protocol], req = request(first, { protocol, body: JSON.stringify(fixture.body) }), miss = await c.lookup(req), value = structuredClone(fixture.response);
    mutate(value); assert.equal(await c.store(miss.ticket, value), false);
  }
});
