import { types } from 'node:util';

// Original, deliberately limited native-JSON adapter. It neither transforms prompts
// nor retries, streams, executes tools, or contacts the network.
const PROTOCOLS = new Set(['openai-responses', 'openai-chat', 'deepseek-chat', 'anthropic-messages', 'gemini']);
const MAX_BYTES = 65_536;
const MAX_DEPTH = 20;
const MAX_NODES = 10_000;
const MAX_ARRAY = 4_096;
const FORBIDDEN_KEY = /^(?:__proto__|prototype|constructor|api[_-]?key|access[_-]?token|authorization|proxy[_-]?authorization|client[_-]?secret|secret[_-]?key|password|credentials?)$/i;
const REMOTE_ASSET_KEY = /^(?:image_url|file_url|file_id|file_data|file_uri|fileUri|audio_url|video_url|upload_id)$/;
const ROOT_FIELDS = {
  'openai-responses': ['model', 'input', 'instructions', 'max_output_tokens', 'tools', 'tool_choice', 'parallel_tool_calls', 'metadata', 'temperature', 'top_p', 'reasoning', 'text', 'truncation', 'store', 'stream', 'background', 'prompt_cache_key', 'prompt_cache_retention', 'service_tier'],
  'openai-chat': ['model', 'messages', 'max_completion_tokens', 'max_tokens', 'tools', 'tool_choice', 'parallel_tool_calls', 'metadata', 'temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'stop', 'seed', 'response_format', 'reasoning_effort', 'verbosity', 'store', 'stream', 'prompt_cache_key', 'prompt_cache_retention', 'service_tier', 'logprobs', 'top_logprobs'],
  'deepseek-chat': ['model', 'messages', 'max_tokens', 'tools', 'tool_choice', 'temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'stop', 'response_format', 'stream', 'logprobs', 'top_logprobs', 'thinking'],
  'anthropic-messages': ['model', 'messages', 'max_tokens', 'system', 'tools', 'tool_choice', 'metadata', 'temperature', 'top_p', 'top_k', 'stop_sequences', 'stream', 'thinking', 'cache_control', 'output_config', 'service_tier'],
  gemini: ['contents', 'systemInstruction', 'tools', 'toolConfig', 'safetySettings', 'generationConfig', 'labels'],
};

function fail(message) { throw new TypeError(`Invalid native request: ${message}`); }
function positive(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail(`${name} must be an explicit positive integer <= ${maximum}`);
  return value;
}

// Do not invoke getters, toJSON, or Proxy traps while inspecting caller objects.
// New null-prototype values are the only objects subsequently serialized.
function inspectJson(value, depth = 0, state = { nodes: 0, bytes: 0, seen: new Set() }) {
  if (++state.nodes > MAX_NODES || depth > MAX_DEPTH) fail('JSON complexity limit exceeded');
  if (typeof value === 'string') {
    state.bytes += Buffer.byteLength(value);
    if (state.bytes > MAX_BYTES) fail('input byte limit exceeded');
    return value;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('non-finite number'); return value; }
  if (typeof value !== 'object' || types.isProxy(value)) fail('only plain JSON data is allowed');
  if (state.seen.has(value)) fail('cyclic JSON data');
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if ((!array && prototype !== Object.prototype && prototype !== null) || (array && prototype !== Array.prototype)) fail('non-plain object');
  if (Object.getOwnPropertySymbols(value).length) fail('symbol properties');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (array && value.length > MAX_ARRAY) fail('array limit exceeded');
  const result = array ? [] : Object.create(null);
  state.seen.add(value);
  if (array) {
    const keys = Object.keys(descriptors).filter(key => key !== 'length');
    if (keys.length !== value.length) fail('sparse or augmented array');
    for (let i = 0; i < value.length; i++) {
      const d = descriptors[String(i)];
      if (!d || !('value' in d) || !d.enumerable) fail('accessor or non-JSON array element');
      result.push(inspectJson(d.value, depth + 1, state));
    }
  } else {
    for (const [key, d] of Object.entries(descriptors)) {
      state.bytes += Buffer.byteLength(key);
      if (state.bytes > MAX_BYTES) fail('input byte limit exceeded');
      if (!('value' in d) || !d.enumerable) fail('accessor or non-enumerable property');
      if (FORBIDDEN_KEY.test(key)) fail('credential or dangerous property');
      if (REMOTE_ASSET_KEY.test(key)) fail('remote/uploaded assets are unsupported');
      if (key === 'toJSON') fail('toJSON is unsupported');
      if (key === 'type' && ['image', 'input_image', 'image_url', 'input_file', 'file', 'audio', 'input_audio', 'video', 'document', 'web_search', 'web_search_preview', 'code_interpreter', 'computer', 'computer_20250124'].includes(d.value)) fail('assets and executable built-in tools are unsupported');
      result[key] = inspectJson(d.value, depth + 1, state);
    }
  }
  state.seen.delete(value);
  return result;
}

// A bounded JSON parser rejects duplicate member names instead of silently
// dropping one of the caller's fields through JSON.parse's last-value behavior.
function parseJson(source) {
  let offset = 0, nodes = 0;
  const whitespace = () => { while (offset < source.length && /[\x20\t\r\n]/.test(source[offset])) offset++; };
  const string = () => {
    const start = offset++;
    while (offset < source.length) {
      if (source[offset] === '\\') { offset += 2; continue; }
      if (source[offset++] === '"') {
        try { return JSON.parse(source.slice(start, offset)); } catch { fail('malformed string'); }
      }
    }
    fail('unterminated string');
  };
  const value = depth => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail('JSON complexity limit exceeded');
    whitespace();
    const c = source[offset];
    if (c === '"') return string();
    if (c === '{' || c === '[') {
      const array = c === '[', result = array ? [] : Object.create(null), names = new Set();
      offset++; whitespace();
      if (source[offset] === (array ? ']' : '}')) { offset++; return result; }
      while (offset < source.length) {
        if (array) {
          if (result.length >= MAX_ARRAY) fail('array limit exceeded');
          result.push(value(depth + 1));
        } else {
          whitespace(); if (source[offset] !== '"') fail('object member must be a string');
          const name = string();
          if (names.has(name)) fail('duplicate JSON member');
          names.add(name); whitespace();
          if (source[offset++] !== ':') fail('missing colon');
          result[name] = value(depth + 1);
        }
        whitespace();
        if (source[offset] === (array ? ']' : '}')) { offset++; return result; }
        if (source[offset++] !== ',') fail('missing comma');
      }
      fail('unterminated container');
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(offset));
    if (!match) fail('malformed JSON value');
    offset += match[0].length;
    const parsed = JSON.parse(match[0]);
    if (typeof parsed === 'number' && !Number.isFinite(parsed)) fail('non-finite number');
    return parsed;
  };
  const result = value(0); whitespace();
  if (offset !== source.length) fail('trailing JSON data');
  return result;
}

function nonemptyArray(value, name) { if (!Array.isArray(value) || value.length === 0) fail(`${name} must be a nonempty array`); }
function textBlocks(content, allowedTypes, name) {
  if (typeof content === 'string') return;
  nonemptyArray(content, name);
  for (const block of content) {
    if (!block || typeof block !== 'object' || !allowedTypes.has(block.type)) fail(`${name} includes an unsupported non-text block`);
    if (['text', 'input_text', 'output_text'].includes(block.type) && typeof block.text !== 'string') fail(`${name} text must be a string`);
    if (block.type === 'tool_result') textBlocks(block.content, new Set(['text']), `${name}.tool_result`);
    if (block.type === 'tool_use' && (typeof block.id !== 'string' || typeof block.name !== 'string' || !block.input || typeof block.input !== 'object' || Array.isArray(block.input))) fail('invalid Anthropic tool-use data');
  }
}
function toolDeclarations(protocol, body) {
  if (!body.tools) return;
  if (!Array.isArray(body.tools)) fail('tools must be an array');
  for (const tool of body.tools) {
    if (!tool || typeof tool !== 'object') fail('invalid tool declaration');
    if (protocol === 'gemini') {
      if (Object.keys(tool).some(key => key !== 'functionDeclarations') || !Array.isArray(tool.functionDeclarations)) fail('only Gemini function declarations are supported');
      for (const fn of tool.functionDeclarations) if (typeof fn?.name !== 'string' || !fn.name) fail('invalid function name');
    } else if (protocol === 'anthropic-messages') {
      if (tool.type !== undefined || typeof tool.name !== 'string' || !tool.name || !tool.input_schema) fail('only custom Anthropic tool declarations are supported');
    } else {
      if (tool.type !== 'function') fail('only function tool declarations are supported');
      const fn = protocol === 'openai-responses' ? tool : tool.function;
      if (typeof fn?.name !== 'string' || !fn.name) fail('invalid function name');
    }
  }
}

function validateNative(protocol, body, maximum) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('body must be an object');
  for (const key of Object.keys(body)) if (!ROOT_FIELDS[protocol].includes(key)) fail('unsupported root field');
  if ('stream' in body && body.stream !== false) fail('streaming is unsupported');
  if ('store' in body && body.store !== false) fail('stored responses are unsupported');
  if ('background' in body && body.background !== false) fail('background execution is unsupported');
  toolDeclarations(protocol, body);
  if (protocol === 'gemini') {
    nonemptyArray(body.contents, 'contents');
    for (const item of body.contents) {
      if (!item || typeof item !== 'object' || (item.role !== undefined && !['user', 'model'].includes(item.role))) fail('invalid Gemini content role');
      nonemptyArray(item.parts, 'parts');
      for (const part of item.parts) {
        if (!part || typeof part !== 'object' || Array.isArray(part) || Object.keys(part).some(key => !['text', 'functionCall', 'functionResponse', 'thought', 'thoughtSignature'].includes(key))) fail('non-text Gemini assets are unsupported');
        if (['text', 'functionCall', 'functionResponse'].filter(key => key in part).length !== 1) fail('Gemini part requires one native text/function value');
        if ('text' in part && typeof part.text !== 'string') fail('Gemini text must be a string');
        if ('functionCall' in part && (typeof part.functionCall?.name !== 'string' || !part.functionCall.name)) fail('invalid Gemini function call');
        if ('functionResponse' in part && (typeof part.functionResponse?.name !== 'string' || !part.functionResponse.name)) fail('invalid Gemini function response');
      }
    }
    if (body.systemInstruction) {
      nonemptyArray(body.systemInstruction.parts, 'systemInstruction.parts');
      for (const part of body.systemInstruction.parts) if (typeof part.text !== 'string' || Object.keys(part).some(key => key !== 'text')) fail('systemInstruction must contain text only');
    }
    return positive(body.generationConfig?.maxOutputTokens, 'generationConfig.maxOutputTokens', maximum);
  }
  if (protocol === 'openai-responses') {
    if (body.store !== false) fail('Responses requires explicit store:false');
    if (typeof body.input !== 'string') {
      nonemptyArray(body.input, 'input');
      for (const item of body.input) {
        if (item?.type === 'function_call') {
          if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string') fail('invalid Responses function call');
          continue;
        }
        if (item?.type === 'function_call_output') {
          if (typeof item.call_id !== 'string' || typeof item.output !== 'string') fail('only text Responses function outputs are supported');
          continue;
        }
        if (!item || !['system', 'developer', 'user', 'assistant'].includes(item.role)) fail('unsupported Responses input item');
        textBlocks(item.content, new Set(['input_text', 'output_text']), 'input.content');
      }
    }
    return positive(body.max_output_tokens, 'max_output_tokens', maximum);
  }
  nonemptyArray(body.messages, 'messages');
  const anthropic = protocol === 'anthropic-messages';
  for (const message of body.messages) {
    if (!message || !(anthropic ? ['user', 'assistant'] : ['system', 'developer', 'user', 'assistant', 'tool']).includes(message.role)) fail('unsupported message role');
    if (!anthropic && message.tool_calls !== undefined) {
      nonemptyArray(message.tool_calls, 'tool_calls');
      for (const call of message.tool_calls) if (call?.type !== 'function' || typeof call.id !== 'string' || typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string') fail('invalid native function-call data');
    }
    if (message.role === 'tool' && typeof message.tool_call_id !== 'string') fail('tool result requires tool_call_id');
    if (message.content === null && !anthropic && Array.isArray(message.tool_calls)) continue;
    textBlocks(message.content, new Set(anthropic ? ['text', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking'] : ['text']), 'messages.content');
  }
  if (anthropic && body.system !== undefined) textBlocks(body.system, new Set(['text']), 'system');
  if (protocol === 'openai-chat') {
    if ('max_completion_tokens' in body && 'max_tokens' in body) fail('use one explicit output token limit');
    return positive(body.max_completion_tokens ?? body.max_tokens, 'max_completion_tokens/max_tokens', maximum);
  }
  return positive(body.max_tokens, 'max_tokens', maximum);
}

export function buildRequest(profile, nativeBody) {
  if (types.isProxy(profile) || !profile || typeof profile !== 'object') fail('invalid profile');
  // Profiles are trusted local configuration, but read their properties without accessors.
  const config = inspectJson(profile);
  if (!PROTOCOLS.has(config.protocol)) fail('unknown explicit protocol');
  if (typeof config.id !== 'string' || !config.id || typeof config.model !== 'string' || !config.model) fail('profile id/model required');
  const maximum = positive(config.limits?.maxOutputTokens, 'profile maxOutputTokens');
  const byteLimit = positive(config.limits?.maxInputBytes, 'profile maxInputBytes', MAX_BYTES);
  if (typeof nativeBody === 'string' && Buffer.byteLength(nativeBody) > byteLimit) fail('input byte limit exceeded');
  const body = inspectJson(typeof nativeBody === 'string' ? parseJson(nativeBody) : nativeBody);
  if (config.protocol !== 'gemini' && body.model !== config.model) fail('body model must exactly match the profile');
  const outputLimit = validateNative(config.protocol, body, maximum);
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded) > byteLimit) fail('input byte limit exceeded');
  let base;
  try { base = new URL(config.baseUrl); } catch { fail('invalid base URL'); }
  if (base.username || base.password || base.search || base.hash) fail('base URL credentials/query/fragment are unsupported');
  // DNS, HTTPS, redirects, egress approval and IP pinning are the transport's job.
  const suffix = config.protocol === 'openai-responses' ? 'responses' : config.protocol === 'anthropic-messages' ? 'messages' : config.protocol === 'gemini' ? `models/${encodeURIComponent(config.model)}:generateContent` : 'chat/completions';
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/${suffix}`;
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  let authHeader = { name: 'Authorization', prefix: 'Bearer ' };
  if (config.protocol === 'anthropic-messages') { headers['anthropic-version'] = '2023-06-01'; authHeader = { name: 'x-api-key', prefix: '' }; }
  if (config.protocol === 'gemini') authHeader = { name: 'x-goog-api-key', prefix: '' };
  return { url: base.href, body: encoded, headers, authHeader, outputLimit };
}

export const SUPPORTED_PROTOCOLS = Object.freeze([...PROTOCOLS]);
