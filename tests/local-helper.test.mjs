import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalHelpers } from '../api/local-helper.mjs';
const testsRoot = path.dirname(fileURLToPath(import.meta.url));
const scriptRoot = path.resolve(testsRoot, '..', 'scripts');
const scratch = path.join(testsRoot, '.helper-tests');
const generation = '00000000-0000-4000-8000-000000000001';
const requestId = '00000000-0000-4000-8000-000000000002';
function stored() { return { version: 1, id: 'offline', label: 'Offline', protocol: 'openai-chat', baseUrl: 'https://api.openai.com/v1', model: 'offline', credentialGeneration: generation, networkEnabled: false, limits: { maxRequests: 1, maxInputBytes: 1024, maxTotalInputBytes: 2048, maxOutputTokens: 16, maxTotalOutputTokens: 32, timeoutMs: 1000 }, credentialCipher: 'AAAA' }; }
const profile = () => { const { credentialCipher, ...value } = stored(); return value; };
async function fixture(fn) {
  await mkdir(scratch, { recursive: true }); const directory = await mkdtemp(path.join(scratch, 'case-')); await writeFile(path.join(directory, 'offline.json'), JSON.stringify(stored()));
  try { await fn(directory); } finally { assert.ok(directory.startsWith(scratch + path.sep)); await rm(directory, { recursive: true, force: true }); }
}
function runner(action, { closeOnKill = true, killDelay = 0 } = {}) {
  const calls = [];
  const spawnImpl = (exe, args, options) => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.kills = 0; child.kill = () => { child.kills++; if (closeOnKill) setTimeout(() => { child.exitCode = -1; child.emit('close', -1); }, killDelay); return true; };
    const call = { exe, args, options, child, input: '' }; calls.push(call); child.stdin.on('data', part => { call.input += part; }); child.stdin.on('finish', () => action?.(call)); return child;
  }; return { calls, spawnImpl };
}
function response(call, value) { call.child.stdout.write(JSON.stringify(value)); call.child.exitCode = 0; call.child.emit('close', 0); }
test('credential uses private pipe, fixed executable and no Key/TOKEN environment', async () => fixture(async directory => {
  const fake = runner(call => response(call, { key: 'OFFLINE_FAKE_SECRET', generation }));
  const helper = createLocalHelpers({ scriptRoot, profileDirectory: directory, spawnImpl: fake.spawnImpl }); assert.equal(await helper.credential(profile()), 'OFFLINE_FAKE_SECRET');
  const call = fake.calls[0]; assert.equal(call.exe, path.resolve(scriptRoot, '..', 'ui', 'CachePilot.ApiLocalHelper.exe')); assert.deepEqual(call.args, ['read', 'offline', generation]); assert.equal(call.options.shell, false); assert.ok(call.options.windowsHide); assert.equal(call.input, ''); assert.equal(call.args.includes('OFFLINE_FAKE_SECRET'), false); assert.equal(call.args.includes('-ExecutionPolicy'), false); assert.equal(call.args.includes('Bypass'), false); assert.equal(Object.keys(call.options.env).some(key => /key|token|secret|password/i.test(key)), false);
}));
test('generation mismatch prevents spawn', async () => fixture(async directory => {
  const fake = runner(); const helper = createLocalHelpers({ scriptRoot, profileDirectory: directory, spawnImpl: fake.spawnImpl }); await assert.rejects(helper.credential({ ...profile(), credentialGeneration: requestId }), { code: 'CREDENTIAL_CHANGED' }); assert.equal(fake.calls.length, 0);
}));
test('in-flight rebind discards decrypted value', async () => fixture(async directory => {
  const fake = runner(call => { void writeFile(path.join(directory, 'offline.json'), JSON.stringify({ ...stored(), credentialGeneration: requestId })).then(() => response(call, { key: 'OFFLINE_FAKE_SECRET', generation })); });
  const helper = createLocalHelpers({ scriptRoot, profileDirectory: directory, spawnImpl: fake.spawnImpl }); await assert.rejects(helper.credential(profile()), { code: 'CREDENTIAL_CHANGED' });
}));
test('wrong returned generation is rejected without leaking response', async () => fixture(async directory => {
  const fake = runner(call => response(call, { key: 'OFFLINE_FAKE_SECRET', generation: requestId })); const helper = createLocalHelpers({ scriptRoot, profileDirectory: directory, spawnImpl: fake.spawnImpl }); await assert.rejects(helper.credential(profile()), error => error.code === 'HELPER_INVALID_RESPONSE' && !String(error).includes('SECRET'));
}));
test('approve preserves exact native body and binds approval hash/request', async () => fixture(async directory => {
  const body = '{"messages":[{"role":"user","content":"offline"}]}'; const bodyHash = createHash('sha256').update(body).digest('hex');
  const fake = runner(call => { const input = JSON.parse(call.input); assert.equal(input.bodyText, body); assert.equal(Object.hasOwn(input, 'key'), false); response(call, { approved: true, requestId, bodyHash }); }); const helper = createLocalHelpers({ scriptRoot, profileDirectory: directory, spawnImpl: fake.spawnImpl }); assert.equal(await helper.approve({ profile: profile(), body, requestId, bodyHash }), true);
}));
test('approval can deny and mismatched body cannot launch UI', async () => fixture(async directory => {
  const body = '{}'; const bodyHash = createHash('sha256').update(body).digest('hex'); const fake = runner(call => response(call, { approved: false, requestId, bodyHash })); const helper = createLocalHelpers({ scriptRoot, profileDirectory: directory, spawnImpl: fake.spawnImpl }); assert.equal(await helper.approve({ profile: profile(), body, requestId, bodyHash }), false); await assert.rejects(helper.approve({ profile: profile(), body: '{"changed":1}', requestId, bodyHash }), { code: 'INVALID_PREVIEW' }); assert.equal(fake.calls.length, 1);
}));
test('oversized preview rejects before spawn', async () => fixture(async directory => {
  const body = JSON.stringify({ text: 'x'.repeat(81920) }); const bodyHash = createHash('sha256').update(body).digest('hex'); const fake = runner(); const helper = createLocalHelpers({ scriptRoot, profileDirectory: directory, spawnImpl: fake.spawnImpl }); await assert.rejects(helper.approve({ profile: profile(), body, requestId, bodyHash }), { code: 'HELPER_INPUT_LIMIT' }); assert.equal(fake.calls.length, 0);
}));
test('stdout limit kills helper exactly once', async () => fixture(async directory => {
  const fake = runner(call => { call.child.stdout.write('x'.repeat(16385)); call.child.emit('error', Error('SECRET')); }); const helper = createLocalHelpers({ scriptRoot, profileDirectory: directory, spawnImpl: fake.spawnImpl }); await assert.rejects(helper.credential(profile()), { code: 'HELPER_OUTPUT_LIMIT' }); assert.equal(fake.calls[0].child.kills, 1);
}));
test('abort before spawn creates no process', async () => fixture(async directory => {
  const controller = new AbortController(); controller.abort(); const fake = runner(); const helper = createLocalHelpers({ scriptRoot, profileDirectory: directory, spawnImpl: fake.spawnImpl }); await assert.rejects(helper.credential(profile(), controller.signal), { code: 'HELPER_ABORTED' }); assert.equal(fake.calls.length, 0);
}));
test('abort after spawn kills helper exactly once', async () => fixture(async directory => {
  const controller = new AbortController(); const fake = runner(() => controller.abort()); const helper = createLocalHelpers({ scriptRoot, profileDirectory: directory, spawnImpl: fake.spawnImpl }); await assert.rejects(helper.credential(profile(), controller.signal), { code: 'HELPER_ABORTED' }); assert.equal(fake.calls[0].child.kills, 1);
}));
test('timeout terminates underlying process', async () => fixture(async directory => {
  const fake = runner(); const helper = createLocalHelpers({ scriptRoot, profileDirectory: directory, spawnImpl: fake.spawnImpl, timeoutMs: 10 }); await assert.rejects(helper.credential(profile()), { code: 'HELPER_TIMEOUT' }); assert.equal(fake.calls[0].child.kills, 1);
}));
test('invalid/error output never appears in exception', async () => fixture(async directory => {
  const fake = runner(call => { call.child.stderr.write('OFFLINE_FAKE_SECRET'); call.child.stdout.write('OFFLINE_FAKE_SECRET'); call.child.exitCode = 1; call.child.emit('close', 1); }); const helper = createLocalHelpers({ scriptRoot, profileDirectory: directory, spawnImpl: fake.spawnImpl }); await assert.rejects(helper.credential(profile()), error => error.code === 'HELPER_FAILED' && !String(error).includes('SECRET'));
}));
test('abort promise remains pending until underlying close; repeated errors do not double kill', async () => fixture(async directory => {
  const controller = new AbortController(); const fake = runner(call => { controller.abort(); call.child.emit('error', Error('SECRET')); call.child.stdout.emit('error', Error('SECRET')); }, { closeOnKill: false });
  const helper = createLocalHelpers({ scriptRoot, profileDirectory: directory, spawnImpl: fake.spawnImpl });
  let settled = false; const result = helper.credential(profile(), controller.signal); const checked = assert.rejects(result, { code: 'HELPER_ABORTED' }).then(() => { settled = true; });
  for (let tries = 0; !fake.calls.length && tries < 30; tries++) await new Promise(resolve => setTimeout(resolve, 2));
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(fake.calls.length, 1); assert.equal(fake.calls[0].child.kills, 1); assert.equal(settled, false);
  fake.calls[0].child.exitCode = -1; fake.calls[0].child.emit('close', -1); await checked; assert.equal(settled, true); assert.equal(fake.calls[0].child.kills, 1);
}));
test('timeout and output limit also wait for kill close confirmation', async () => fixture(async directory => {
  for (const scenario of ['timeout', 'output']) {
    const fake = runner(call => { if (scenario === 'output') call.child.stdout.write('x'.repeat(16385)); }, { closeOnKill: false });
    const helper = createLocalHelpers({ scriptRoot, profileDirectory: directory, spawnImpl: fake.spawnImpl, timeoutMs: scenario === 'timeout' ? 10 : 1000 });
    let settled = false; const checked = assert.rejects(helper.credential(profile()), { code: scenario === 'timeout' ? 'HELPER_TIMEOUT' : 'HELPER_OUTPUT_LIMIT' }).then(() => { settled = true; });
    for (let tries = 0; (!fake.calls.length || !fake.calls[0].child.kills) && tries < 50; tries++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(fake.calls[0].child.kills, 1); assert.equal(settled, false); fake.calls[0].child.exitCode = -1; fake.calls[0].child.emit('close', -1); await checked;
  }
}));
test('unconfirmed termination has explicit fail-closed code and flag', async () => fixture(async directory => {
  const fake = runner(() => {}, { closeOnKill: false }); const helper = createLocalHelpers({ scriptRoot, profileDirectory: directory, spawnImpl: fake.spawnImpl, timeoutMs: 5, terminationWaitMs: 10 });
  await assert.rejects(helper.credential(profile()), error => error.code === 'HELPER_TERMINATION_UNCONFIRMED' && error.terminationUnconfirmed === true && !String(error).includes('SECRET'));
  assert.equal(fake.calls[0].child.kills, 1); fake.calls[0].child.exitCode = -1; fake.calls[0].child.emit('close', -1); assert.equal(fake.calls[0].child.kills, 1);
}));
test('gateway token goes through stdin only and never appears in returned metadata', async () => fixture(async directory => {
  const details = { address: 'http://127.0.0.1:45678', token: 'A'.repeat(43), expiresAt: new Date(Date.now() + 300000).toISOString(), profileId: 'offline', protocol: 'openai-chat', model: 'offline' };
  const fake = runner(call => { assert.equal(JSON.parse(call.input).token, details.token); assert.equal(call.args.some(arg => arg.includes(details.token)), false); response(call, { shown: true }); });
  const helper = createLocalHelpers({ scriptRoot, profileDirectory: directory, spawnImpl: fake.spawnImpl }); assert.equal(await helper.showGateway(details), true); assert.equal(fake.calls.length, 1);
}));
test('gateway window rejects non-loopback address and invalid token without spawning', async () => fixture(async directory => {
  const details = { address: 'http://0.0.0.0:45678', token: 'A'.repeat(43), expiresAt: new Date(Date.now() + 300000).toISOString(), profileId: 'offline', protocol: 'openai-chat', model: 'offline' };
  const fake = runner(); const helper = createLocalHelpers({ scriptRoot, profileDirectory: directory, spawnImpl: fake.spawnImpl }); await assert.rejects(helper.showGateway(details), { code: 'INVALID_GATEWAY_DETAILS' }); await assert.rejects(helper.showGateway({ ...details, address: 'http://127.0.0.1:45678', token: 'bad' }), { code: 'INVALID_GATEWAY_DETAILS' }); assert.equal(fake.calls.length, 0);
}));
