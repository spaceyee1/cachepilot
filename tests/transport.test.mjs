import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHttpsTransport, publicAddress, validateEndpoint } from '../api/transport.mjs';

const request = { url: 'https://api.provider.com/v1/responses', body: '{"offline":true}', headers: {}, authHeader: { name: 'Authorization', prefix: 'Bearer ' } };
const key = 'offline-fixture-not-a-real-key';
const args = extra => ({ request, key, timeoutMs: 1000, ...extra });
function fakeHttp({ status = 200, headers = {}, chunks = ['{"usage":{"input_tokens":3}}'], never = false, aborted = false, authorized = true } = {}) {
  const state = { calls: 0, ends: 0, destroys: 0 };
  return { state, impl(url, options, callback) {
    state.calls++; state.options = options; state.url = url;
    const req = new EventEmitter(); req.destroyed = false;
    req.destroy = () => { if (!req.destroyed) { req.destroyed = true; state.destroys++; } return req; };
    req.end = body => {
      state.ends++; state.body = body;
      if (never) return;
      queueMicrotask(() => {
        const socket = new EventEmitter(); socket.authorized = authorized;
        req.emit('socket', socket); socket.emit('secureConnect');
        const res = new PassThrough(); res.statusCode = status; res.headers = { 'content-type': 'application/json', ...headers };
        callback(res);
        if (res.destroyed) return;
        if (aborted) { res.emit('aborted'); return; }
        for (const c of chunks) if (!res.destroyed) res.write(c);
        if (!res.destroyed) res.end();
      });
    };
    return req;
  } };
}
const resolver = async () => [{ address: '8.8.8.8', family: 4 }];

test('public address checks reject private, metadata, reserved and tunnel addresses', () => {
  for (const a of ['0.0.0.0','10.1.2.3','127.0.0.1','100.64.0.1','169.254.169.254','172.16.0.1','192.168.1.2','192.0.2.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','::1','::ffff:127.0.0.1','fe80::1','fc00::1','2001:db8::1','2002:7f00:1::']) assert.equal(publicAddress(a), false, a);
  for (const a of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111']) assert.equal(publicAddress(a), true, a);
});
test('endpoint restrictions reject URL credentials, IP literals, alternate ports and secrets in query', () => {
  for (const url of ['http://api.provider.com/v1','https://user:pass@api.provider.com/v1','https://127.0.0.1/v1','https://[::1]/v1','https://api.provider.com:8443/v1','https://api.provider.com/v1?key=fixture','https://api.provider.com/v1#fragment','https://localhost/v1','https://metadata.internal/v1','https://api.provider.com./v1','https://api.provider.com/%2fprivate']) assert.throws(() => validateEndpoint(url));
  assert.equal(validateEndpoint(request.url).hostname, 'api.provider.com');
});
test('all DNS answers must be public; mixed public/private resolution never submits', async () => {
  const f = fakeHttp();
  const send = createHttpsTransport({ resolve: async () => [...await resolver(), { address: '127.0.0.1', family: 4 }], requestImpl: f.impl });
  await assert.rejects(send(args()), { code: 'API_DNS_REJECTED' }); assert.equal(f.state.calls, 0);
});
test('approved hostname and TLS servername survive DNS pinning; no duplicate send', async () => {
  const f = fakeHttp(); let resolutions = 0;
  const send = createHttpsTransport({ resolve: async () => { resolutions++; return resolver(); }, requestImpl: f.impl });
  const result = await send(args());
  assert.equal(result.data.usage.input_tokens, 3); assert.equal(f.state.calls, 1); assert.equal(f.state.ends, 1); assert.equal(resolutions, 1);
  assert.equal(f.state.options.servername, 'api.provider.com'); assert.equal(f.state.options.rejectUnauthorized, true); assert.equal(f.state.options.agent, false);
  assert.equal(f.state.options.headers.Authorization, 'Bearer ' + key);
  f.state.options.lookup('api.provider.com', {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
  for (const field of ['dnsMs','tlsMs','headersMs','firstByteMs','totalMs']) assert.ok(result.timing[field] >= 0, field);
});
test('timeout covers a DNS resolver that never completes', async () => {
  const f = fakeHttp(), hold = setTimeout(() => {}, 1000);
  try { await assert.rejects(createHttpsTransport({ resolve: () => new Promise(() => {}), requestImpl: f.impl })(args({ timeoutMs: 15 })), { code: 'API_TIMEOUT' }); }
  finally { clearTimeout(hold); }
  assert.equal(f.state.calls, 0);
});
test('abort during DNS discards its eventual answer', async () => {
  const f = fakeHttp(), controller = new AbortController(); let release;
  const waiting = createHttpsTransport({ resolve: () => new Promise(r => { release = r; }), requestImpl: f.impl })(args({ signal: controller.signal }));
  controller.abort(); await assert.rejects(waiting, { code: 'API_CANCELLED' }); release(await resolver()); await new Promise(r => setImmediate(r));
  assert.equal(f.state.calls, 0);
});
test('generation recheck runs after DNS and can refuse before request construction', async () => {
  const f = fakeHttp(); let checked = false;
  await assert.rejects(createHttpsTransport({ resolve: resolver, requestImpl: f.impl })(args({ beforeSubmit: async () => { checked = true; throw Object.assign(new Error('changed'), { code: 'API_PROFILE_CHANGED' }); } })), { code: 'API_PROFILE_CHANGED' });
  assert.equal(checked, true); assert.equal(f.state.calls, 0);
});
test('abort while pre-submit recheck is pending prevents req.end', async () => {
  const f = fakeHttp(), c = new AbortController(); let release;
  const run = createHttpsTransport({ resolve: resolver, requestImpl: f.impl })(args({ signal: c.signal, beforeSubmit: () => new Promise(r => { release = r; }) }));
  await new Promise(r => setImmediate(r)); c.abort(); release(); await assert.rejects(run, { code: 'API_CANCELLED' }); assert.equal(f.state.ends, 0);
});
test('abort returns while pre-submit is still pending; its late resolution cannot send', async () => {
  const f = fakeHttp(), controller = new AbortController(); let release, began = false;
  const run = createHttpsTransport({ resolve: resolver, requestImpl: f.impl })(args({ signal: controller.signal,
    beforeSubmit: () => { began = true; return new Promise(r => { release = r; }); } }));
  await new Promise(r => setImmediate(r)); assert.equal(began, true);
  controller.abort();
  // Intentionally do not release the identity operation before rejection.
  await assert.rejects(run, { code: 'API_CANCELLED' });
  assert.equal(f.state.calls, 0); assert.equal(f.state.ends, 0);
  release(); await new Promise(r => setImmediate(r));
  assert.equal(f.state.calls, 0); assert.equal(f.state.ends, 0);
});
test('timeout returns with a never-completing pre-submit operation and no request', async () => {
  const f = fakeHttp(), hold = setTimeout(() => {}, 1000); let began = false;
  try {
    await assert.rejects(createHttpsTransport({ resolve: resolver, requestImpl: f.impl })(args({ timeoutMs: 15,
      beforeSubmit: () => { began = true; return new Promise(() => {}); } })), { code: 'API_TIMEOUT' });
  } finally { clearTimeout(hold); }
  assert.equal(began, true); assert.equal(f.state.calls, 0); assert.equal(f.state.ends, 0);
});
test('late pre-submit rejection after cancellation is handled and cannot submit', async () => {
  const f = fakeHttp(), controller = new AbortController(); let rejectLate, began;
  const ready = new Promise(resolve => { began = resolve; });
  const waiting = createHttpsTransport({ resolve: resolver, requestImpl: f.impl })(args({ signal: controller.signal,
    beforeSubmit: () => { began(); return new Promise((_, reject) => { rejectLate = reject; }); } }));
  await ready; controller.abort(); await assert.rejects(waiting, { code: 'API_CANCELLED' });
  rejectLate(Error('synthetic late identity failure')); await new Promise(r => setImmediate(r));
  assert.equal(f.state.calls, 0); assert.equal(f.state.ends, 0);
});
test('pre-submit abort listener is removed on success, cancellation, timeout and identity rejection', async () => {
  // Capture the transport's combined signal, then inspect its public listener
  // inventory after completion. No HTTP, DNS or actual timer timeout is needed.
  const originalAny = AbortSignal.any;
  let combined;
  AbortSignal.any = function(signals) { combined = originalAny.call(AbortSignal, signals); return combined; };
  try {
    const succeeded = fakeHttp();
    await createHttpsTransport({ resolve: resolver, requestImpl: succeeded.impl })(args());
    assert.equal(getEventListeners(combined, 'abort').length, 0);
    const refused = fakeHttp();
    await assert.rejects(createHttpsTransport({ resolve: resolver, requestImpl: refused.impl })(args({ beforeSubmit: async () => { throw Object.assign(Error('fixed'), { code: 'API_PROFILE_CHANGED' }); } })), { code: 'API_PROFILE_CHANGED' });
    assert.equal(getEventListeners(combined, 'abort').length, 0);
    const controller = new AbortController(), cancelledHttp = fakeHttp(); let started;
    const startedPromise = new Promise(resolve => { started = resolve; });
    const waiting = createHttpsTransport({ resolve: resolver, requestImpl: cancelledHttp.impl })(args({ signal: controller.signal, beforeSubmit: () => { started(); return new Promise(() => {}); } }));
    await startedPromise; controller.abort(); await assert.rejects(waiting, { code: 'API_CANCELLED' });
    assert.equal(getEventListeners(combined, 'abort').length, 0); assert.equal(cancelledHttp.state.calls, 0);
    const timedHttp = fakeHttp(), hold = setTimeout(() => {}, 1000);
    try {
      await assert.rejects(createHttpsTransport({ resolve: resolver, requestImpl: timedHttp.impl })(args({ timeoutMs: 15, beforeSubmit: () => new Promise(() => {}) })), { code: 'API_TIMEOUT' });
      assert.equal(getEventListeners(combined, 'abort').length, 0); assert.equal(timedHttp.state.calls, 0);
    } finally { clearTimeout(hold); }
  } finally { AbortSignal.any = originalAny; }
});
for (const [name, options, code] of [
  ['redirect', { status: 302, headers: { location: 'https://different.provider.com' } }, 'API_REDIRECT_REFUSED'],
  ['authentication error', { status: 401, chunks: [key] }, 'API_AUTH_REJECTED'],
  ['rate limit', { status: 429 }, 'API_RATE_LIMITED'],
  ['upstream failure', { status: 500 }, 'API_UPSTREAM_REJECTED'],
  ['HTML response', { headers: { 'content-type': 'text/html' } }, 'API_RESPONSE_FORMAT'],
  ['compressed response', { headers: { 'content-encoding': 'gzip' } }, 'API_RESPONSE_FORMAT'],
  ['declared oversize', { headers: { 'content-length': '2000000' } }, 'API_RESPONSE_LIMIT'],
  ['streamed oversize', { chunks: ['a'.repeat(1048577)] }, 'API_RESPONSE_LIMIT'],
  ['malformed JSON', { chunks: ['{"unfinished":'] }, 'API_RESPONSE_FORMAT'],
  ['invalid UTF-8', { chunks: [Buffer.from([0xff])] }, 'API_RESPONSE_FORMAT'],
  ['truncated connection', { aborted: true }, 'API_RESPONSE_INCOMPLETE'],
  ['untrusted certificate', { authorized: false }, 'API_TLS_REJECTED'],
]) test(`${name} is a fixed safe error without retry`, async () => {
  const f = fakeHttp(options);
  await assert.rejects(createHttpsTransport({ resolve: resolver, requestImpl: f.impl })(args()), error => error.code === code && !error.message.includes(key));
  assert.equal(f.state.calls, 1); assert.ok(f.state.destroys <= 1);
});
test('abort after submission destroys the request exactly once', async () => {
  const f = fakeHttp({ never: true }), c = new AbortController();
  const run = createHttpsTransport({ resolve: resolver, requestImpl: f.impl })(args({ signal: c.signal }));
  await new Promise(r => setImmediate(r)); c.abort(); c.abort(); await assert.rejects(run, { code: 'API_CANCELLED' }); assert.equal(f.state.destroys, 1);
});
test('request deadline reclaims a submitted request', async () => {
  const f = fakeHttp({ never: true });
  await assert.rejects(createHttpsTransport({ resolve: resolver, requestImpl: f.impl })(args({ timeoutMs: 15 })), { code: 'API_TIMEOUT' }); assert.equal(f.state.destroys, 1);
});
test('invalid timeout and header injection are rejected before DNS', async () => {
  let resolutions = 0; const send = createHttpsTransport({ resolve: async () => { resolutions++; return resolver(); }, requestImpl: fakeHttp().impl });
  for (const timeoutMs of [0, -1, 60001, NaN]) await assert.rejects(send(args({ timeoutMs })), { code: 'API_TIMEOUT_LIMIT' });
  await assert.rejects(send(args({ key: 'fixture\r\nInjected: value' })), { code: 'API_CREDENTIAL_REJECTED' }); assert.equal(resolutions, 0);
});
