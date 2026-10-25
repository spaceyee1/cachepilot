import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiLedger, scopeFor } from '../api/ledger.mjs';
import { normalizeUsage } from '../api/usage.mjs';

// Interface-shaped fixtures only: no credentials, file writes or network calls.
const profile = generation => ({ id: 'offline-ledger', protocol: 'anthropic-messages',
  baseUrl: 'https://offline.invalid/v1', model: 'offline-fixture', credentialGeneration: generation ?? 'fixture-generation-0' });
const reported = () => ({ input_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 20, output_tokens: 10 });
const ledger = () => new ApiLedger({ source: 'offline_fixture' });
function complete(book, p, raw) {
  const usage = normalizeUsage('anthropic-messages', { usage: raw });
  book.attempted(p); book.completed(p, usage); return usage;
}
function assertUnknownRead(row) {
  assert.equal(row.reportedRequests, 0); assert.equal(row.cacheObservedInputTokens, 0);
  assert.equal(row.cacheReadTokens, 0); assert.equal(row.unknownUsageRequests, 1);
  assert.equal(row.cacheHitRate, null); assert.equal(row.providerCacheMeasured, false);
}

test('complete Anthropic usage counts writes once and includes them only once in the denominator', () => {
  const book = ledger(), p = profile(); const usage = complete(book, p, reported());
  const row = book.snapshot()[0];
  assert.equal(usage.inputTokens, 100); assert.equal(row.inputTokens, 100);
  assert.equal(row.cacheObservedInputTokens, 100); assert.equal(row.cacheReadTokens, 60);
  assert.equal(row.cacheWriteTokens, 20); assert.equal(row.cacheHitRate, 0.6);
  assert.equal(row.requests, 1); assert.equal(row.reportedRequests, 1); assert.equal(row.unknownUsageRequests, 0);
  assert.equal(Object.keys(book.scopes()[0]).length, 12);
});

for (const field of ['input_tokens', 'cache_read_input_tokens']) {
  for (const state of ['missing', 'null']) test(`Anthropic ${state} ${field} retains reported writes without inventing read coverage`, () => {
    const book = ledger(), p = profile(), raw = reported();
    if (state === 'missing') delete raw[field]; else raw[field] = null;
    const usage = complete(book, p, raw), row = book.snapshot()[0];
    assert.equal(usage.inputTokens, null); assert.equal(usage.cacheWriteTokens, 20);
    assert.equal(row.cacheWriteTokens, 20); assert.equal(row.inputTokens, 0); assert.equal(row.outputTokens, 10);
    assertUnknownRead(row); assert.equal(Object.keys(book.scopes()[0]).length, 12);
  });
}

test('write-only Anthropic usage remains visible while all read measurements stay unknown', () => {
  const book = ledger(); const usage = complete(book, profile(), { cache_creation_input_tokens: 23 });
  assert.equal(usage.cacheWriteTokens, 23); assert.equal(usage.inputTokens, null); assert.equal(usage.cachedInputTokens, null);
  const row = book.snapshot()[0]; assert.equal(row.cacheWriteTokens, 23); assert.equal(row.requests, 1);
  assert.equal(row.outputTokens, 0); assertUnknownRead(row);
});

test('explicit zero write permits a complete denominator; missing and null write never synthesize it', () => {
  const known = ledger(), usage = complete(known, profile(), { ...reported(), cache_creation_input_tokens: 0 });
  assert.equal(usage.cacheWriteTokens, 0); assert.equal(usage.inputTokens, 80);
  const row = known.snapshot()[0]; assert.equal(row.cacheWriteTokens, 0); assert.equal(row.cacheHitRate, 0.75);
  assert.equal(row.reportedRequests, 1);
  for (const state of ['missing', 'null']) {
    const book = ledger(), raw = reported();
    if (state === 'missing') delete raw.cache_creation_input_tokens; else raw.cache_creation_input_tokens = null;
    const unavailable = complete(book, profile(), raw);
    assert.equal(unavailable.cacheWriteTokens, null); assert.equal(unavailable.inputTokens, null);
    assert.equal(book.snapshot()[0].cacheWriteTokens, 0); assertUnknownRead(book.snapshot()[0]);
  }
  // The fixed twelve-field frame has no write-field coverage flag. A raw zero
  // is a numeric aggregate, never proof that every response reported zero writes.
});

test('explicit zero write on a partial record does not fabricate a cache-read measurement', () => {
  const book = ledger(), usage = complete(book, profile(), { cache_creation_input_tokens: 0 });
  assert.equal(usage.cacheWriteTokens, 0); assert.equal(usage.cachedInputTokens, null);
  const row = book.snapshot()[0]; assert.equal(row.cacheWriteTokens, 0); assertUnknownRead(row);
});

test('mixed complete and partial records sum writes but restrict the read ratio to matched records', () => {
  const book = ledger(), p = profile();
  complete(book, p, reported());
  complete(book, p, { cache_read_input_tokens: 60, cache_creation_input_tokens: 30, output_tokens: 5 });
  complete(book, p, { input_tokens: 20, cache_read_input_tokens: 15, output_tokens: 2 });
  const row = book.snapshot()[0];
  assert.equal(row.requests, 3); assert.equal(row.reportedRequests, 1); assert.equal(row.unknownUsageRequests, 2);
  assert.equal(row.cacheWriteTokens, 50); assert.equal(row.outputTokens, 17);
  assert.equal(row.inputTokens, 100); assert.equal(row.cacheObservedInputTokens, 100);
  assert.equal(row.cacheReadTokens, 60); assert.equal(row.cacheHitRate, 0.6); assert.equal(row.reportingCoverage, 1 / 3);
});

test('snapshot refreshes and mutations of returned rows cannot recount one reported write', () => {
  const book = ledger(), p = profile(); complete(book, p, { cache_creation_input_tokens: 7 });
  const expected = book.scopes();
  for (let i = 0; i < 50; i++) {
    const raw = book.scopes(), view = book.snapshot();
    assert.equal(raw[0].cacheWriteTokens, 7); assert.equal(view[0].cacheWriteTokens, 7);
    assert.equal(view[0].requests, 1); assert.equal(view[0].unknownUsageRequests, 1);
    raw[0].cacheWriteTokens = 999; view[0].cacheWriteTokens = 999;
  }
  assert.deepEqual(book.scopes(), expected);
});

for (const counter of ['input', 'output', 'write']) test(`${counter} accumulation overflow rejects the whole completion without a partial commit`, () => {
  const book = ledger(), p = profile(), max = Number.MAX_SAFE_INTEGER;
  let first, second;
  if (counter === 'input') {
    first = { input_tokens: max, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };
    second = { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };
  } else if (counter === 'output') {
    first = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: max };
    second = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 };
  } else {
    first = { cache_creation_input_tokens: max, output_tokens: 0 };
    second = { cache_creation_input_tokens: 1, output_tokens: 5 };
  }
  complete(book, p, first); const usage = normalizeUsage('anthropic-messages', { usage: second });
  book.attempted(p); const before = book.scopes();
  assert.throws(() => book.completed(p, usage), { code: 'API_COUNTER_LIMIT' });
  assert.deepEqual(book.scopes(), before); assert.equal(book.scopes()[0].requests, 2);
  assert.ok(book.scopes().every(row => Object.values(row).every(value => typeof value !== 'number' || Number.isSafeInteger(value))));
});

test('sixteen binding scopes remain intact after the seventeenth is rejected; an existing scope remains usable', () => {
  const book = ledger(), profiles = Array.from({ length: 17 }, (_, i) => profile(`fixture-generation-${i}`));
  for (let i = 0; i < 16; i++) complete(book, profiles[i], { cache_creation_input_tokens: i });
  const before = book.scopes(); assert.equal(before.length, 16);
  assert.equal(new Set(before.map(row => row.scopeId)).size, 16);
  assert.throws(() => book.attempted(profiles[16]), { code: 'API_SCOPE_LIMIT' });
  assert.throws(() => book.completed(profiles[16], normalizeUsage('anthropic-messages', { usage: reported() })), { code: 'API_SCOPE_LIMIT' });
  assert.deepEqual(book.scopes(), before);
  complete(book, profiles[0], { cache_creation_input_tokens: 9 });
  const after = book.scopes(); assert.equal(after.length, 16);
  assert.equal(after.find(row => row.scopeId === scopeFor(profiles[0])).cacheWriteTokens, 9);
  assert.deepEqual(after.filter(row => row.scopeId !== scopeFor(profiles[0])), before.filter(row => row.scopeId !== scopeFor(profiles[0])));
});
