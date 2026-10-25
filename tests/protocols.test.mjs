import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, SUPPORTED_PROTOCOLS } from '../api/protocols.mjs';

// Entirely local synthetic fixtures. No real key, DNS lookup, or HTTP request.
const profile = protocol => ({ id: 'offline-fixture', protocol, model: 'fixture-model', baseUrl: 'https://fixture.invalid/v1', credentialGeneration: 1, limits: { maxInputBytes: 65_536, maxOutputTokens: 64 } });
const native = protocol => protocol === 'openai-responses'
  ? { model: 'fixture-model', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Keep\n  bytes 世界' }] }], max_output_tokens: 32, store: false }
  : protocol === 'gemini'
    ? { contents: [{ role: 'user', parts: [{ text: 'Keep\n  bytes 世界' }] }], generationConfig: { maxOutputTokens: 32 } }
    : { model: 'fixture-model', messages: [{ role: 'user', content: 'Keep\n  bytes 世界' }], ...(protocol === 'openai-chat' ? { max_completion_tokens: 32 } : { max_tokens: 32 }) };
const endpoints = {
  'openai-responses': { prefix: '/v1', suffix: '/responses', auth: { name: 'Authorization', prefix: 'Bearer ' } },
  'openai-chat': { prefix: '/v1', suffix: '/chat/completions', auth: { name: 'Authorization', prefix: 'Bearer ' } },
  'deepseek-chat': { prefix: '', suffix: '/chat/completions', auth: { name: 'Authorization', prefix: 'Bearer ' } },
  'anthropic-messages': { prefix: '/v1', suffix: '/messages', auth: { name: 'x-api-key', prefix: '' } },
  gemini: { prefix: '/v1beta', suffix: '/models/fixture-model:generateContent', auth: { name: 'x-goog-api-key', prefix: '' } },
};

for (const protocol of SUPPORTED_PROTOCOLS) {
  test(`${protocol}: exact configured destination, method suffix and credential-free auth descriptor`, () => {
    const expected = endpoints[protocol];
    assert.ok(expected, 'every supported protocol must have an independent expectation');
    for (const prefix of [expected.prefix, '/custom/provider-prefix']) {
      for (const trailingSlash of ['', '/']) {
        const baseUrl = `https://fixture.invalid${prefix}${trailingSlash}`;
        const request = buildRequest({ ...profile(protocol), baseUrl }, native(protocol));
        assert.equal(request.url, `https://fixture.invalid${prefix}${expected.suffix}`);
        assert.equal(new URL(request.url).pathname, `${prefix}${expected.suffix}`);
        assert.deepEqual(request.authHeader, expected.auth);
        const expectedHeaders = { 'content-type': 'application/json', accept: 'application/json' };
        if (protocol === 'anthropic-messages') expectedHeaders['anthropic-version'] = '2023-06-01';
        assert.deepEqual(request.headers, expectedHeaders);
        assert.ok(!Object.keys(request.headers).some(key => /authorization|api[-_]?key/i.test(key)), 'credential values are added only by the approved transport');
        assert.equal(typeof request.body, 'string');
        assert.deepEqual(JSON.parse(request.body), native(protocol));
      }
    }
  });
  test(`${protocol}: preserves native payload and selects only its explicit route`, () => {
    const body = native(protocol), before = JSON.stringify(body), request = buildRequest(profile(protocol), body);
    assert.equal(JSON.stringify(body), before);
    assert.deepEqual(JSON.parse(request.body), body);
    assert.equal(request.outputLimit, 32);
    assert.equal(request.headers['content-type'], 'application/json');
    assert.ok(!Object.keys(request.headers).some(key => /authorization|key/i.test(key)));
    assert.equal(new URL(request.url).hostname, 'fixture.invalid');
    const suffix = protocol === 'openai-responses' ? '/responses' : protocol === 'gemini' ? '/models/fixture-model:generateContent' : protocol === 'anthropic-messages' ? '/messages' : '/chat/completions';
    assert.ok(new URL(request.url).pathname.endsWith(suffix));
    assert.deepEqual(buildRequest(profile(protocol), JSON.stringify(body)), request);
  });
  test(`${protocol}: explicit positive capped output limit is required`, () => {
    for (const limit of [0, -1, 65, 1.5, null, '32', Number.NaN]) {
      const body = native(protocol);
      if (protocol === 'gemini') body.generationConfig.maxOutputTokens = limit;
      else body[protocol === 'openai-responses' ? 'max_output_tokens' : protocol === 'openai-chat' ? 'max_completion_tokens' : 'max_tokens'] = limit;
      assert.throws(() => buildRequest(profile(protocol), body));
    }
  });
}

test('protocol is never inferred or silently replaced', () => {
  assert.throws(() => buildRequest({ ...profile('openai-chat'), protocol: 'auto' }, native('openai-chat')), /explicit protocol/);
  assert.throws(() => buildRequest(profile('openai-chat'), native('gemini')));
});
test('profile model must match, without changing either object', () => {
  const body = { ...native('openai-chat'), model: 'other-model' };
  assert.throws(() => buildRequest(profile('openai-chat'), body), /exactly match/);
  assert.equal(body.model, 'other-model');
});
test('Responses storage consent is explicit; no safety fields are silently inserted', () => {
  for (const store of [true, null, undefined]) {
    const body = native('openai-responses'); body.store = store;
    if (store === undefined) delete body.store;
    assert.throws(() => buildRequest(profile('openai-responses'), body));
  }
  assert.throws(() => buildRequest(profile('openai-responses'), { ...native('openai-responses'), background: true }));
});
test('streaming and alternate root fields are rejected, not omitted', () => {
  for (const protocol of SUPPORTED_PROTOCOLS.filter(value => value !== 'gemini')) assert.throws(() => buildRequest(profile(protocol), { ...native(protocol), stream: true }), /streaming/);
  assert.throws(() => buildRequest(profile('openai-chat'), { ...native('openai-chat'), unsupported: true }), /unsupported root/);
  assert.throws(() => buildRequest(profile('openai-chat'), { ...native('openai-chat'), max_tokens: 32 }), /one explicit/);
  assert.throws(() => buildRequest(profile('openai-chat'), { ...native('openai-chat'), SYNTHETIC_PRIVATE_FIELD: true }), error => !error.message.includes('SYNTHETIC_PRIVATE_FIELD'));
});
test('accessors, toJSON, Proxy objects and JSON-incompatible values are never invoked', () => {
  let calls = 0;
  const accessor = native('openai-chat');
  Object.defineProperty(accessor, 'tools', { enumerable: true, get() { calls++; throw Error('called'); } });
  assert.throws(() => buildRequest(profile('openai-chat'), accessor), /accessor/);
  const methods = { ...native('openai-chat'), toJSON() { calls++; return {}; } };
  assert.throws(() => buildRequest(profile('openai-chat'), methods), /toJSON/);
  const proxy = new Proxy(native('openai-chat'), { ownKeys() { calls++; throw Error('called'); } });
  assert.throws(() => buildRequest(profile('openai-chat'), proxy), /plain JSON/);
  assert.equal(calls, 0);
  for (const value of [undefined, () => {}, BigInt(1), new Date(), new Map(), Symbol('x')]) assert.throws(() => buildRequest(profile('openai-chat'), { ...native('openai-chat'), metadata: { value } }));
});
test('dangerous properties and credential fields are refused at every depth', () => {
  for (const name of ['__proto__', 'constructor', 'prototype', 'api_key', 'apiKey', 'authorization', 'password']) {
    const body = JSON.parse(JSON.stringify(native('openai-chat')));
    Object.defineProperty(body, name, { enumerable: true, value: 'SYNTHETIC_NOT_A_KEY' });
    assert.throws(() => buildRequest(profile('openai-chat'), body));
    assert.throws(() => buildRequest(profile('openai-chat'), JSON.stringify(body)));
  }
});
test('no duplicate JSON members or non-JSON whitespace is accepted', () => {
  const source = JSON.stringify(native('openai-chat'));
  assert.throws(() => buildRequest(profile('openai-chat'), source.replace('"model":', '"model":"discarded","model":')), /duplicate/);
  assert.throws(() => buildRequest(profile('openai-chat'), `\u00a0${source}`), /malformed/);
  for (const text of ['{', '{"x":1,}', '[1,]', source + 'true', '{"x":1e999}']) assert.throws(() => buildRequest(profile('openai-chat'), text));
});
test('byte/depth/node/array limits bound untrusted JSON before serialization', () => {
  assert.throws(() => buildRequest(profile('openai-chat'), { ...native('openai-chat'), messages: [{ role: 'user', content: 'x'.repeat(65_537) }] }), /byte limit/);
  assert.throws(() => buildRequest(profile('openai-chat'), ' '.repeat(65_537)), /byte limit/);
  let deep = {}; for (let i = 0; i < 22; i++) deep = { inner: deep };
  assert.throws(() => buildRequest(profile('openai-chat'), { ...native('openai-chat'), metadata: deep }), /complexity/);
  assert.throws(() => buildRequest(profile('openai-chat'), { ...native('openai-chat'), stop: Array(4_097).fill('') }), /array limit/);
  assert.throws(() => buildRequest(profile('openai-chat'), { ...native('openai-chat'), metadata: { a: Array(4_000).fill(1), b: Array(4_000).fill(1), c: Array(4_000).fill(1) } }), /complexity/);
});
test('cycles, sparse arrays, augmented arrays and non-enumerable fields are refused', () => {
  const cycle = {}; cycle.inner = cycle;
  assert.throws(() => buildRequest(profile('openai-chat'), { ...native('openai-chat'), metadata: cycle }), /cyclic/);
  const sparse = Array(2); sparse[1] = 'end';
  assert.throws(() => buildRequest(profile('openai-chat'), { ...native('openai-chat'), stop: sparse }), /sparse/);
  const augmented = ['end']; augmented.extra = true;
  assert.throws(() => buildRequest(profile('openai-chat'), { ...native('openai-chat'), stop: augmented }), /augmented/);
  const body = native('openai-chat'); Object.defineProperty(body, 'hidden', { value: 1 });
  assert.throws(() => buildRequest(profile('openai-chat'), body), /non-enumerable/);
});
test('remote/uploaded assets and built-in executing tools are not supported', () => {
  assert.throws(() => buildRequest(profile('openai-chat'), { ...native('openai-chat'), messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://asset.invalid' } }] }] }), /assets|asset/);
  assert.throws(() => buildRequest(profile('anthropic-messages'), { ...native('anthropic-messages'), messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fixture', content: [{ type: 'image', source: { type: 'url', url: 'https://asset.invalid' } }] }] }] }));
  assert.throws(() => buildRequest(profile('openai-responses'), { ...native('openai-responses'), tools: [{ type: 'web_search_preview' }] }), /tools/);
  assert.throws(() => buildRequest(profile('gemini'), { ...native('gemini'), tools: [{ googleSearch: {} }] }), /function declarations/);
});
test('function declarations, roles, arguments and tool results remain native data', () => {
  const body = native('openai-chat');
  body.tools = [{ type: 'function', function: { name: 'fixture_fn', parameters: { type: 'object', properties: { text: { type: 'string' } } } } }];
  body.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: 'fixture_fn', arguments: '{"text":"keep  spaces"}' } }] });
  body.messages.push({ role: 'tool', tool_call_id: 'call_fixture', content: 'SYNTHETIC_RESULT' });
  assert.deepEqual(JSON.parse(buildRequest(profile('openai-chat'), body).body), body);
});
test('malformed tool calls and ambiguous Gemini parts fail before any transport', () => {
  for (const tool_calls of [[{ type: 'function', function: { name: 'fixture_fn', arguments: '{}' } }], [{ type: 'computer', id: 'call_fixture' }]]) {
    assert.throws(() => buildRequest(profile('openai-chat'), { ...native('openai-chat'), messages: [{ role: 'assistant', content: null, tool_calls }] }), /function-call|executable built-in/);
  }
  assert.throws(() => buildRequest(profile('openai-chat'), { ...native('openai-chat'), messages: [{ role: 'tool', content: 'fixture' }] }), /tool_call_id/);
  for (const part of [{}, { text: 123 }, { text: 'x', functionCall: { name: 'fixture_fn' } }, { functionCall: {} }]) assert.throws(() => buildRequest(profile('gemini'), { ...native('gemini'), contents: [{ parts: [part] }] }));
});
test('model names cannot alter Gemini endpoint hierarchy and URL credentials are refused', () => {
  const request = buildRequest({ ...profile('gemini'), model: '../escape' }, native('gemini'));
  assert.match(new URL(request.url).pathname, /models\/\.\.%2Fescape:generateContent$/);
  for (const baseUrl of ['https://name:password@fixture.invalid/v1', 'https://fixture.invalid/v1?key=secret', 'https://fixture.invalid/v1#fragment']) assert.throws(() => buildRequest({ ...profile('openai-chat'), baseUrl }, native('openai-chat')));
});
