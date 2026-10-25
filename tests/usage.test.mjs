import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsage } from '../api/usage.mjs';

// All usage objects are synthetic interface-shaped fixtures, not cloud evidence.
test('OpenAI Responses reports its actual cache field and denominator', () => {
  const result = normalizeUsage('openai-responses', { usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 60 } } });
  assert.deepEqual(result, { inputTokens: 100, outputTokens: 10, cachedInputTokens: 60, cacheWriteTokens: null, totalTokens: 110, cacheMeasured: true, cacheHitRate: 0.6, status: 'measured', source: 'interface_reported' });
});
test('OpenAI Chat retains absence of cache counts as unknown', () => {
  const result = normalizeUsage('openai-chat', { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
  assert.equal(result.cachedInputTokens, null); assert.equal(result.cacheHitRate, null); assert.equal(result.cacheMeasured, false);
});
test('explicit zero cache counter differs from missing cache counter', () => {
  const result = normalizeUsage('openai-chat', { usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } } });
  assert.equal(result.cacheMeasured, true); assert.equal(result.cacheHitRate, 0); assert.equal(result.cachedInputTokens, 0);
});
test('DeepSeek main counters and compatible nested counters must agree', () => {
  const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 75, prompt_cache_miss_tokens: 25, prompt_tokens_details: { cached_tokens: 75 } };
  assert.equal(normalizeUsage('deepseek-chat', { usage }).cacheHitRate, 0.75);
  assert.throws(() => normalizeUsage('deepseek-chat', { usage: { ...usage, prompt_tokens_details: { cached_tokens: 74 } } }), /Conflicting/);
  assert.throws(() => normalizeUsage('deepseek-chat', { usage: { ...usage, prompt_cache_miss_tokens: 30 } }), /hit\/miss/);
});
test('DeepSeek missing main field can use the reported nested field without guessing', () => {
  const result = normalizeUsage('deepseek-chat', { usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 50 } } });
  assert.equal(result.cachedInputTokens, 50); assert.equal(result.cacheHitRate, 0.5);
});
test('Anthropic denominator includes ordinary input, cache read and cache creation', () => {
  const result = normalizeUsage('anthropic-messages', { usage: { input_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 20, output_tokens: 10 } });
  assert.equal(result.inputTokens, 100); assert.equal(result.cachedInputTokens, 60); assert.equal(result.cacheWriteTokens, 20); assert.equal(result.totalTokens, 110); assert.equal(result.cacheHitRate, 0.6);
});
for (const missing of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
  test(`Anthropic missing ${missing} does not invent a denominator`, () => {
    const usage = { input_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 20, output_tokens: 10 }; delete usage[missing];
    const result = normalizeUsage('anthropic-messages', { usage });
    assert.equal(result.inputTokens, null); assert.equal(result.totalTokens, null); assert.equal(result.cacheMeasured, false); assert.equal(result.cacheHitRate, null);
  });
}
test('Gemini reads usageMetadata and retains separately reported total including other categories', () => {
  const result = normalizeUsage('gemini', { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, cachedContentTokenCount: 40, thoughtsTokenCount: 20, totalTokenCount: 130 } });
  assert.equal(result.inputTokens, 100); assert.equal(result.outputTokens, 10); assert.equal(result.cachedInputTokens, 40); assert.equal(result.totalTokens, 130); assert.equal(result.cacheHitRate, 0.4);
});
test('missing response, usage, fields and explicit null retain unknown values', () => {
  for (const response of [undefined, null, {}, { usage: null }, { usage: {} }, { usage: { input_tokens: null, output_tokens: null, input_tokens_details: { cached_tokens: null } } }]) {
    const result = normalizeUsage('openai-responses', response);
    assert.equal(result.inputTokens, null); assert.equal(result.outputTokens, null); assert.equal(result.cachedInputTokens, null); assert.equal(result.cacheHitRate, null); assert.equal(result.cacheMeasured, false);
  }
});
test('zero denominator produces no percentage', () => {
  const result = normalizeUsage('openai-chat', { usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } } });
  assert.equal(result.cacheMeasured, false); assert.equal(result.cacheHitRate, null);
});
test('negative, fractional, unsafe and typed string counters are rejected', () => {
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity, '100', true]) assert.throws(() => normalizeUsage('openai-chat', { usage: { prompt_tokens: value } }), /Invalid reported/);
  assert.throws(() => normalizeUsage('anthropic-messages', { usage: { input_tokens: Number.MAX_SAFE_INTEGER, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 } }), /safe integer/);
});
test('impossible cached-input and total counts are rejected', () => {
  assert.throws(() => normalizeUsage('openai-chat', { usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 11 } } }), /exceeds input/);
  assert.throws(() => normalizeUsage('gemini', { usageMetadata: { promptTokenCount: 10, totalTokenCount: 9 } }), /smaller than input/);
  assert.throws(() => normalizeUsage('openai-responses', { usage: { output_tokens: 10, total_tokens: 9 } }), /smaller than output/);
  assert.throws(() => normalizeUsage('openai-chat', { usage: { prompt_tokens: 40, completion_tokens: 30, total_tokens: 50 } }), /input plus output/);
});
test('usage getters and Proxy traps are not called', () => {
  let calls = 0;
  const response = {}; Object.defineProperty(response, 'usage', { get() { calls++; throw Error('called'); } });
  assert.throws(() => normalizeUsage('openai-chat', response), /accessors/);
  const usage = new Proxy({}, { getOwnPropertyDescriptor() { calls++; throw Error('called'); } });
  assert.throws(() => normalizeUsage('openai-chat', { usage }), /Invalid usage/);
  assert.equal(calls, 0);
});
test('protocol is explicit; unknown protocol never reads another vendor field', () => {
  assert.throws(() => normalizeUsage('auto', {}), /Unknown explicit/);
  assert.equal(normalizeUsage('gemini', { usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 90 } }).inputTokens, null);
});
