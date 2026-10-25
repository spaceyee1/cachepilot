import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startGateway } from '../api/gateway.mjs';

const baseProfile = () => ({ id: 'offline', model: 'offline-model', protocol: 'openai-chat', limits: { maxInputBytes: 256, timeoutMs: 1000 } });
const body = '{"model":"offline-model","messages":[{"role":"user","content":"offline"}]}';
const route = '/v1/chat/completions';
async function fixture(fn, options = {}) {
  const gateway = await startGateway({ profile: baseProfile(), execute: async () => ({ status: 200, body: { ok: true } }), ...options });
  try { await fn(gateway); } finally { await gateway.close(); }
}
function headers(gateway, extra = {}) { return { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json', ...extra }; }
async function getJson(gateway, requestRoute = route, options = {}) { const response = await fetch(gateway.address + requestRoute, { method: 'POST', headers: headers(gateway), body, ...options }); const text = await response.text(); return { status: response.status, value: JSON.parse(text), headers: response.headers }; }
function native(gateway, { requestRoute = route, method = 'POST', payload = body, extraHeaders = {}, agent } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(gateway.address);
    let result, requestClosed = false; const writeErrors = [];
    const complete = () => { if (result && requestClosed) resolve({ ...result, writeErrors }); };
    const req = http.request({ host: '127.0.0.1', port: Number(url.port), path: requestRoute, method, headers: headers(gateway, { 'content-length': Buffer.byteLength(payload), ...extraHeaders }), agent }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject); res.on('end', () => { try { assert.ok(res.complete, 'full status, headers, and JSON body must arrive'); result = { status: res.statusCode, value: JSON.parse(Buffer.concat(chunks)), headers: res.headers }; complete(); } catch (error) { reject(error); } });
    });
    const timer = setTimeout(() => { req.destroy(); reject(Error('loopback test timeout')); }, 2000); req.on('error', error => { writeErrors.push(error.code || 'UNKNOWN'); if (!result) reject(error); }); req.once('close', () => { requestClosed = true; clearTimeout(timer); complete(); }); req.end(payload);
  });
}
async function waitFor(predicate, label, timeoutMs = 1500) { const deadline = Date.now() + timeoutMs; while (!predicate()) { if (Date.now() > deadline) assert.fail(label); await new Promise(resolve => setTimeout(resolve, 5)); } }
test('gateway is loopback only, has independent random bearer, models are local metadata', async () => fixture(async gateway => {
  assert.match(gateway.address, /^http:\/\/127\.0\.0\.1:\d+$/); assert.match(gateway.token, /^[A-Za-z0-9_-]{43}$/); assert.equal(JSON.stringify(gateway.status()).includes(gateway.token), false);
  const result = await getJson(gateway, '/v1/models', { method: 'GET', body: undefined }); assert.equal(result.status, 200); assert.equal(result.value.data[0].id, 'offline-model'); assert.equal(gateway.status().accepted, 0);
}));
test('raw native JSON and only AbortSignal reach execute; caller headers never forwarded', async () => {
  let calls = 0;
  await fixture(async gateway => {
    const result = await getJson(gateway, route, { headers: headers(gateway, { 'x-caller-secret': 'OFFLINE_FAKE_SECRET' }) }); assert.equal(result.status, 200); assert.deepEqual(result.value, { native: true }); assert.equal(calls, 1);
  }, { execute: async (raw, options) => { calls++; assert.equal(raw, body); assert.deepEqual(Object.keys(options), ['signal']); assert.ok(options.signal instanceof AbortSignal); return { status: 200, body: { native: true } }; } });
});
test('duplicate JSON fields remain present for strict native executor validation', async () => {
  let received;
  await fixture(async gateway => { const result = await getJson(gateway, route, { body: '{"model":"a","model":"b"}' }); assert.equal(result.status, 200); assert.equal(received, '{"model":"a","model":"b"}'); }, { execute: async raw => { received = raw; return { status: 200, body: {} }; } });
});
for (const [name, options, expected] of [
  ['missing bearer', { headers: { 'content-type': 'application/json' } }, 401],
  ['wrong bearer', { headers: { authorization: 'Bearer OFFLINE_FAKE_SECRET', 'content-type': 'application/json' } }, 401],
  ['origin', { extra: { origin: 'null' } }, 403],
  ['wrong host', { extra: { host: 'public.invalid' } }, 400],
  ['encoding', { extra: { 'content-encoding': 'gzip' } }, 415],
  ['wrong type', { extra: { 'content-type': 'text/plain' } }, 415],
  ['query', { requestRoute: route + '?x=1' }, 400],
  ['wrong route', { requestRoute: '/v1/messages' }, 404],
  ['unsupported method', { method: 'DELETE', body: undefined }, 405]
]) test(`rejects ${name} with complete JSON`, async () => fixture(async gateway => {
  const { extra, requestRoute, ...rest } = options; const result = extra?.host ? await native(gateway, { extraHeaders: extra }) : await getJson(gateway, requestRoute, { headers: headers(gateway, extra), ...rest }); assert.equal(result.status, expected); assert.equal(typeof result.value.error.code, 'string'); assert.equal(JSON.stringify(result.value).includes('SECRET'), false); assert.equal(gateway.status().accepted, 0);
}));
test('fetch and native HTTP receive full 413 JSON for oversized content-length', async () => fixture(async gateway => {
  for (let repetition = 0; repetition < 12; repetition++) {
    const payload = JSON.stringify({ text: 'x'.repeat(32768) });
    const a = await getJson(gateway, route, { body: payload }); const b = await native(gateway, { payload });
    for (const result of [a, b]) { assert.equal(result.status, 413); assert.equal(result.value.error.code, 'input_limit'); }
  }
  await waitFor(() => gateway.status().connections === 0 && gateway.status().cleanupTimers === 0, 'oversize sockets and timers released'); assert.equal(gateway.status().active, 0); assert.equal(gateway.status().rejected, 24);
}));
test('chunked oversize is bounded and returns complete 413 JSON', async () => fixture(async gateway => {
  const result = await new Promise((resolve, reject) => {
    const url = new URL(gateway.address);
    const req = http.request({ host: '127.0.0.1', port: Number(url.port), path: route, method: 'POST', headers: headers(gateway) }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject); res.on('end', () => { try { assert.ok(res.complete); resolve({ status: res.statusCode, value: JSON.parse(Buffer.concat(chunks)) }); } catch (error) { reject(error); } }); });
    req.on('error', reject); req.write('x'.repeat(512)); req.end();
  });
  assert.equal(result.status, 413); assert.equal(result.value.error.code, 'input_limit'); await waitFor(() => gateway.status().active === 0 && gateway.status().connections === 0, 'chunked oversize released');
}));
test('fetch and native complete 413 for 256KiB and 1MiB uploads', async () => fixture(async gateway => {
  for (const size of [262144, 1048576]) {
    const payload = JSON.stringify({ text: 'x'.repeat(size) });
    for (let repetition = 0; repetition < 3; repetition++) {
      const results = [await getJson(gateway, route, { body: payload }), await native(gateway, { payload })];
      for (const result of results) { assert.equal(result.status, 413); assert.equal(result.value.error.code, 'input_limit'); if (result.writeErrors) assert.deepEqual(result.writeErrors, [], 'native request must not report a write error after a complete response'); }
    }
  }
  await waitFor(() => gateway.status().active === 0 && gateway.status().connections === 0 && gateway.status().cleanupTimers === 0, 'large upload resources released');
}));
test('fetch and native concurrent overflow receive complete 429 without executing', async () => {
  let finish; let calls = 0;
  await fixture(async gateway => {
    const initial = getJson(gateway); await waitFor(() => calls === 1, 'first execute started');
    const large = JSON.stringify({ text: 'x'.repeat(1048576) });
    const overflow = await Promise.all(Array.from({ length: 12 }, (_, index) => index % 2 ? native(gateway, { payload: large }) : getJson(gateway, route, { body: large })));
    for (const result of overflow) { assert.equal(result.status, 429); assert.equal(result.value.error.code, 'local_concurrency_limit'); if (result.writeErrors) assert.deepEqual(result.writeErrors, []); }
    assert.equal(calls, 1); assert.equal(gateway.status().active, 1); finish({ status: 200, body: { ok: true } }); assert.equal((await initial).status, 200); await waitFor(() => gateway.status().active === 0 && gateway.status().connections === 0, 'all concurrent resources released');
  }, { execute: async () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
});
test('large unsupported encoding returns complete 415 before bounded connection cleanup', async () => fixture(async gateway => {
  const payload = JSON.stringify({ text: 'x'.repeat(1048576) });
  for (let repetition = 0; repetition < 3; repetition++) {
    const results = [await getJson(gateway, route, { headers: headers(gateway, { 'content-encoding': 'unsupported' }), body: payload }), await native(gateway, { payload, extraHeaders: { 'content-encoding': 'unsupported' } })];
    for (const result of results) { assert.equal(result.status, 415); assert.equal(result.value.error.code, 'encoding_or_type_rejected'); if (result.writeErrors) assert.deepEqual(result.writeErrors, []); }
  }
  await waitFor(() => gateway.status().connections === 0 && gateway.status().cleanupTimers === 0, 'unsupported encoding sockets and timers released'); assert.equal(gateway.status().accepted, 0);
}));
test('client abort cancels actual execute, releases one slot once, and recovers', async () => {
  let calls = 0, aborts = 0;
  await fixture(async gateway => {
    for (let repetition = 0; repetition < 8; repetition++) {
      const controller = new AbortController(); const pending = getJson(gateway, route, { signal: controller.signal }).catch(error => error);
      await waitFor(() => calls === repetition + 1, 'execute started'); controller.abort(); await pending;
      await waitFor(() => gateway.status().active === 0 && gateway.status().connections === 0, 'abort releases slot and socket'); assert.equal(gateway.status().active, 0);
    }
    assert.equal(aborts, 8); assert.equal(gateway.status().aborted, 8); assert.equal(gateway.status().accepted, 8);
  }, { execute: (_raw, { signal }) => { calls++; return new Promise((_resolve, reject) => { const cancel = () => { aborts++; reject(Object.assign(Error('OFFLINE_FAKE_SECRET'), { code: 'REQUEST_ABORTED' })); }; if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true }); }); } });
});
test('raw exception details and fake keys never enter errors and do not trigger retries', async () => {
  let calls = 0;
  await fixture(async gateway => { const result = await getJson(gateway); assert.equal(result.status, 502); assert.deepEqual(result.value, { error: { code: 'request_failed' } }); assert.equal(calls, 1); assert.equal(gateway.status().active, 0); }, { execute: async () => { calls++; throw Error('OFFLINE_FAKE_SECRET private path'); } });
});
for (const [runtimeCode, status, publicCode] of [
  ['API_APPROVAL_DENIED', 403, 'approval_denied'],
  ['API_NETWORK_DISABLED', 403, 'network_disabled'],
  ['API_BUDGET_EXHAUSTED', 429, 'budget_exhausted'],
  ['API_CANCELLED', 499, 'request_aborted'],
  ['API_BUSY', 429, 'local_concurrency_limit'],
  ['API_TIMEOUT', 504, 'request_timeout'],
  ['API_PROFILE_CHANGED', 409, 'profile_changed'],
  ['API_LOCAL_HELPER_UNCONFIRMED', 503, 'local_helper_unconfirmed']
]) test(`runtime ${runtimeCode} returns fixed ${status} without retry or raw exception`, async () => {
  let calls = 0;
  await fixture(async gateway => {
    const result = await getJson(gateway); assert.equal(result.status, status); assert.deepEqual(result.value, { error: { code: publicCode } }); assert.equal(calls, 1); assert.equal(gateway.status().active, 0); assert.equal(JSON.stringify(result.value).includes('SECRET'), false);
  }, { execute: async () => { calls++; throw Object.assign(Error('OFFLINE_FAKE_SECRET private credentials path'), { name: 'ApiError', code: runtimeCode }); } });
});
test('invalid UTF-8, JSON syntax, and non-object input reject before execute', async () => fixture(async gateway => {
  for (const payload of ['{', 'null', '[]', Buffer.from([0xff, 0xfe])]) { const result = await native(gateway, { payload }); assert.equal(result.status, 400); assert.equal(result.value.error.code, 'invalid_json'); } assert.equal(gateway.status().completed, 0);
}));
for (const [protocol, requestRoute] of [['openai-responses', '/v1/responses'], ['deepseek-chat', route], ['anthropic-messages', '/v1/messages'], ['gemini', '/v1beta/models/offline-model:generateContent']]) test(`native route for ${protocol} is fixed`, async () => fixture(async gateway => {
  const result = await getJson(gateway, requestRoute); assert.equal(result.status, 200); assert.equal(gateway.status().accepted, 1);
}, { profile: { ...baseProfile(), protocol } }));
test('close is idempotent, releases listening port and sockets, and TTL closes automatically', async () => {
  const first = await startGateway({ profile: baseProfile(), execute: async () => ({ status: 200, body: {} }) }); const port = Number(new URL(first.address).port); await Promise.all([first.close(), first.close()]); await waitFor(() => first.status().connections === 0 && first.status().cleanupTimers === 0, 'close clears resources'); assert.equal(first.status().listening, false);
  const second = await startGateway({ profile: baseProfile(), execute: async () => ({}), port, ttlMs: 25 }); assert.notEqual(second.token, first.token); await waitFor(() => !second.status().listening, 'TTL closes listening port'); await second.close();
});
