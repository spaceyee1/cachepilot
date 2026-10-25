import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SemanticResponseCache } from '../api/semantic-cache.mjs';

// These are explicitly synthetic mechanism tests, not a semantic model quality
// benchmark. Identical vectors intentionally make every unguarded approximate
// candidate maximally similar, so a threshold alone cannot reject a bad pair.
// No real-model positive or negation cosine observations are aggregated here.
const coreSource = readFileSync(new URL('../api/semantic-cache.mjs', import.meta.url), 'utf8');
const plain = 'Explain how the service restarts';
const plainParaphrase = 'Describe restarting the service';
const request = (query, scope = 'guard-order-fixture-partition') => ({ scope, protocol: 'openai-chat',
  body: JSON.stringify({ model: 'fixture-model', temperature: 0, messages: [{ role: 'user', content: query }], max_tokens: 32 }) });
const response = () => ({ model: 'fixture-model', choices: [{ index: 0,
  message: { role: 'assistant', content: 'A complete synthetic fixture answer' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 20, completion_tokens: 4 } });
function fixture(options = {}) {
  let calls = 0, throwing = false;
  const cache = new SemanticResponseCache({ encoderId: 'synthetic-guard-order-vectors', ...options,
    embed: () => { calls++; if (throwing) throw Error('guard must run before encoder'); return [1, 0]; } });
  return { cache, get calls() { return calls; }, throwOnCall() { throwing = true; } };
}
async function seed(cache, query) {
  const miss = await cache.lookup(request(query)); assert.equal(miss.hit, false); assert.ok(miss.ticket);
  assert.equal(await cache.store(miss.ticket, response()), true); return miss;
}
async function guardedMiss(state, query) {
  const beforeCalls = state.calls, beforeHits = state.cache.status().semanticHits;
  const result = await state.cache.lookup(request(query));
  assert.equal(result.hit, false); assert.equal(result.reason, 'literal_guard_exact_only');
  assert.equal(result.similarity, undefined); assert.equal(result.match, undefined); assert.ok(result.ticket);
  assert.equal(state.calls, beforeCalls, 'guarded query must not call the encoder');
  assert.equal(state.cache.status().semanticHits, beforeHits, 'guarded query must not increment approximate hits');
  assert.equal(state.cache.status().pendingEmbeddings, 0);
  return result;
}

test('read-only source evidence: exact lookup, guarded return, embedding, then cosine occur in that order', () => {
  const start = coreSource.indexOf('async lookup(');
  const exact = coreSource.indexOf('if (exact)', start);
  const guard = coreSource.indexOf('const limited = exactOnly(parts.text)', start);
  const guardReturn = coreSource.indexOf("return this.#miss('literal_guard_exact_only'", guard);
  const embedding = coreSource.indexOf('await this.#embedding(parts.text, signal)', guard);
  const cosine = coreSource.indexOf('const score = cosine(vector, entry.vector)', embedding);
  assert.ok(start >= 0 && exact > start && guard > exact && guardReturn > guard && embedding > guardReturn && cosine > embedding);
  assert.match(coreSource.slice(guardReturn, embedding), /vector: null[\s\S]*exactOnly: true[\s\S]*\}\)\);[\s\S]*\}/);
});
test('read-only source evidence: exact-only seeds are excluded before cosine evaluation', () => {
  const scan = coreSource.indexOf('for (const [entryKey, entry] of this.#entries)');
  const exclusion = coreSource.indexOf('if (entry.group !== group || entry.exactOnly) continue;', scan);
  const cosine = coreSource.indexOf('const score = cosine(vector, entry.vector)', scan);
  assert.ok(scan >= 0 && exclusion > scan && cosine > exclusion);
});
test('default threshold remains 0.97 and language policy explicitly reports English-only approximation', () => {
  const s = fixture(); assert.equal(s.cache.status().threshold, 0.97);
  assert.equal(s.cache.status().semanticLanguage, 'en'); assert.equal(s.cache.status().nonEnglishPolicy, 'exact_only');
  assert.equal(s.cache.status().semanticEquivalenceGuaranteed, false); assert.equal(s.calls, 0);
});

const englishPairs = [
  ['Do not restart the service', 'Restart the service'],
  ['Never restart the service', 'Restart the service'],
  ['The service cannot restart', 'The service can restart'],
  ['The service is unable to restart', 'The service is able to restart'],
  ['Restart the service without a delay', 'Restart the service with a delay'],
  ['Deny service restart', 'Allow service restart'],
  ['Restarting the service is forbidden', 'Restarting the service is permitted'],
  ['Restart no service', 'Restart a service'],
];
for (const [negative, positive] of englishPairs) {
  test(`English negation is rejected before embedding: ${negative}`, async () => {
    const s = fixture(); await seed(s.cache, positive); assert.equal(s.calls, 1); s.throwOnCall();
    const denied = await guardedMiss(s, negative);
    assert.equal(await s.cache.store(denied.ticket, response()), true);
    const exact = await s.cache.lookup(request(negative)); assert.equal(exact.hit, true); assert.equal(exact.match, 'exact');
    assert.equal(exact.response.usage, undefined); assert.equal(s.calls, 1); assert.equal(s.cache.status().semanticHits, 0);
  });
}

const chinesePairs = [
  ['不要重启服务', '可以重启服务'],
  ['不可重启', '可以重启'],
  ['不能重启服务', '能够重启服务'],
  ['别重启服务', '重启服务'],
  ['禁止重启服务', '允许重启服务'],
  ['不得重启服务', '允许重启服务'],
  ['不应重启服务', '应该重启服务'],
];
for (const [negative, positive] of chinesePairs) {
  test(`Chinese non-ASCII gate, not Chinese semantic understanding: ${negative} / ${positive}`, async () => {
    const s = fixture(); s.throwOnCall();
    const first = await guardedMiss(s, negative); assert.equal(await s.cache.store(first.ticket, response()), true);
    await guardedMiss(s, positive);
    const exact = await s.cache.lookup(request(negative)); assert.equal(exact.hit, true); assert.equal(exact.match, 'exact');
    assert.equal(s.calls, 0); assert.equal(s.cache.status().semanticHits, 0);
    assert.equal(s.cache.status().nonEnglishPolicy, 'exact_only');
  });
}

const numericPairs = [
  ['Use 5 workers', 'Use 6 workers'],
  ['Wait 0.5 seconds', 'Wait 0.6 seconds'],
  ['Transfer 1e3 units', 'Transfer 1e4 units'],
  ['Accept version v1', 'Accept version v2'],
  ['Use one worker', 'Use two workers'],
  ['保留一项数据', '保留两项数据'],
];
for (const [original, changed] of numericPairs) {
  test(`numeric or quantity guard is before embedding: ${original} / ${changed}`, async () => {
    const s = fixture(); s.throwOnCall();
    const miss = await guardedMiss(s, original); assert.equal(await s.cache.store(miss.ticket, response()), true);
    await guardedMiss(s, changed);
    const exact = await s.cache.lookup(request(original)); assert.equal(exact.match, 'exact'); assert.equal(s.calls, 0);
    assert.equal(s.cache.status().semanticHits, 0);
  });
}

for (const threshold of [0.95, 0.97, 1]) {
  test(`guards remain independent of threshold ${threshold}`, async () => {
    const s = fixture({ threshold }); await seed(s.cache, plain); assert.equal(s.calls, 1);
    const control = await s.cache.lookup(request(plainParaphrase)); assert.equal(control.hit, true); assert.equal(control.match, 'semantic');
    assert.equal(control.similarity, 1); assert.equal(s.calls, 2); const controlHits = s.cache.status().semanticHits;
    s.throwOnCall();
    for (const guarded of ['Do not restart the service', 'Use 5 workers', '不要重启服务', '可以重启服务', '不可重启']) await guardedMiss(s, guarded);
    assert.equal(s.calls, 2); assert.equal(s.cache.status().semanticHits, controlHits);
    assert.equal(s.cache.status().threshold, threshold, 'the test does not lower or mutate the configured threshold');
  });
}
test('a normal English seed cannot answer guarded Chinese or numeric requests even if its vector would match', async () => {
  const s = fixture(); await seed(s.cache, plain); assert.equal(s.calls, 1); s.throwOnCall();
  for (const query of [...englishPairs.map(pair => pair[0]), ...chinesePairs.flat(), ...numericPairs.flat()]) await guardedMiss(s, query);
  assert.equal(s.calls, 1); assert.equal(s.cache.status().semanticHits, 0);
});
test('guarded seeds never become approximate candidates for an ordinary English request', async () => {
  for (const guarded of ['Do not restart the service', 'Use 5 workers', '不要重启服务', '可以重启服务', '不可重启']) {
    const s = fixture(); await seed(s.cache, guarded); assert.equal(s.calls, 0);
    const normal = await s.cache.lookup(request(plain)); assert.equal(s.calls, 1);
    assert.equal(normal.hit, false); assert.equal(normal.reason, 'no_semantic_match'); assert.ok(normal.ticket);
    assert.equal(s.cache.status().semanticHits, 0); assert.equal(s.cache.status().entries, 1);
  }
});
test('guarded exact reuse preserves original text bytes and does not normalize whitespace or punctuation', async () => {
  const s = fixture(); s.throwOnCall(); const query = 'Do not restart the service'; await seed(s.cache, query);
  for (const changed of [` ${query}`, `${query} `, `${query}!`]) await guardedMiss(s, changed);
  assert.equal((await s.cache.lookup(request(query))).match, 'exact');
  assert.equal(s.calls, 0); assert.equal(s.cache.status().semanticHits, 0);
});
