import { types } from 'node:util';

// No cache counter is synthesized. Values are vendor-interface reports, not
// proof that CachePilot caused a cache hit or saved money.
function own(object, name) {
  if (object == null) return undefined;
  if (typeof object !== 'object' || types.isProxy(object)) throw new TypeError('Invalid usage object');
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) throw new TypeError('Usage accessors are unsupported');
  return descriptor.value;
}
function count(object, field) {
  const value = own(object, field);
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid reported token counter: ${field}`);
  return value;
}
function sum(parts) {
  if (parts.some(value => value === null)) return null;
  const result = parts.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(result)) throw new TypeError('Reported token sum exceeds safe integer range');
  return result;
}
function same(left, right, name) {
  if (left !== null && right !== null && left !== right) throw new TypeError(`Conflicting reported token counters: ${name}`);
  return left ?? right;
}

export function normalizeUsage(protocol, response) {
  let usage, inputTokens = null, outputTokens = null, cachedInputTokens = null, cacheWriteTokens = null, totalTokens = null;
  if (['openai-responses', 'openai-chat', 'deepseek-chat', 'anthropic-messages'].includes(protocol)) usage = own(response, 'usage');
  else if (protocol === 'gemini') usage = own(response, 'usageMetadata');
  else throw new TypeError('Unknown explicit usage protocol');
  if (protocol === 'openai-responses') {
    inputTokens = count(usage, 'input_tokens'); outputTokens = count(usage, 'output_tokens'); totalTokens = count(usage, 'total_tokens');
    cachedInputTokens = count(own(usage, 'input_tokens_details'), 'cached_tokens');
  } else if (protocol === 'openai-chat' || protocol === 'deepseek-chat') {
    inputTokens = count(usage, 'prompt_tokens'); outputTokens = count(usage, 'completion_tokens'); totalTokens = count(usage, 'total_tokens');
    const nested = count(own(usage, 'prompt_tokens_details'), 'cached_tokens');
    const direct = protocol === 'deepseek-chat' ? count(usage, 'prompt_cache_hit_tokens') : null;
    cachedInputTokens = same(nested, direct, 'cached input');
    if (protocol === 'deepseek-chat') {
      const missed = count(usage, 'prompt_cache_miss_tokens');
      if (missed !== null && cachedInputTokens !== null && inputTokens !== null && sum([missed, cachedInputTokens]) !== inputTokens) throw new TypeError('DeepSeek hit/miss counters do not equal prompt_tokens');
    }
  } else if (protocol === 'anthropic-messages') {
    const ordinary = count(usage, 'input_tokens');
    cachedInputTokens = count(usage, 'cache_read_input_tokens'); cacheWriteTokens = count(usage, 'cache_creation_input_tokens');
    inputTokens = sum([ordinary, cachedInputTokens, cacheWriteTokens]); outputTokens = count(usage, 'output_tokens');
    // Anthropic has no top-level total_tokens; only complete components permit a total.
    totalTokens = sum([inputTokens, outputTokens]);
  } else {
    inputTokens = count(usage, 'promptTokenCount'); outputTokens = count(usage, 'candidatesTokenCount');
    cachedInputTokens = count(usage, 'cachedContentTokenCount'); totalTokens = count(usage, 'totalTokenCount');
  }
  if (inputTokens !== null && cachedInputTokens !== null && cachedInputTokens > inputTokens) throw new TypeError('Reported cached input exceeds input');
  if (totalTokens !== null && inputTokens !== null && totalTokens < inputTokens) throw new TypeError('Reported total is smaller than input');
  if (totalTokens !== null && outputTokens !== null && totalTokens < outputTokens) throw new TypeError('Reported total is smaller than output');
  if (totalTokens !== null && inputTokens !== null && outputTokens !== null && totalTokens < sum([inputTokens, outputTokens])) throw new TypeError('Reported total is smaller than input plus output');
  // Zero input has no percentage denominator; it is not a 0% or 100% observation.
  const cacheMeasured = inputTokens !== null && inputTokens > 0 && cachedInputTokens !== null;
  const cacheHitRate = cacheMeasured ? cachedInputTokens / inputTokens : null;
  const status = cacheMeasured ? 'measured' : inputTokens === null && outputTokens === null && cachedInputTokens === null ? 'unmeasured' : 'incomplete_usage';
  return { inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens, totalTokens, cacheMeasured, cacheHitRate, status, source: 'interface_reported' };
}
