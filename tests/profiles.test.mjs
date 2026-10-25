import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfile, readProfiles, validateProfile, validateBaseUrl, readBoundedProfileHandle } from '../api/profiles.mjs';
import { validateEndpoint } from '../api/transport.mjs';

const scratch = path.join(path.dirname(fileURLToPath(import.meta.url)), '.profile-tests');
const example = () => ({ version: 1, id: 'offline', label: 'Offline fixture', protocol: 'openai-chat', baseUrl: 'https://api.openai.com/v1', model: 'offline-model', credentialGeneration: '00000000-0000-4000-8000-000000000001', networkEnabled: false, limits: { maxRequests: 1, maxInputBytes: 1024, maxTotalInputBytes: 2048, maxOutputTokens: 16, maxTotalOutputTokens: 32, timeoutMs: 1000 }, credentialCipher: 'AAAA' });
async function fixture(fn) {
  await mkdir(scratch, { recursive: true }); const directory = await mkdtemp(path.join(scratch, 'case-'));
  try { await writeFile(path.join(directory, 'offline.json'), JSON.stringify(example())); await fn(directory); }
  finally { assert.ok(directory.startsWith(scratch + path.sep)); await rm(directory, { recursive: true, force: true }); }
}
test('metadata omits cipher and does not expose shared mutable limits', async () => fixture(async directory => {
  const value = await loadProfile('offline', { directory }); assert.equal(value.id, 'offline'); assert.equal(Object.hasOwn(value, 'credentialCipher'), false); assert.ok(Object.isFrozen(value.limits)); assert.equal((await readProfiles({ directory })).length, 1);
}));
for (const id of ['../escape', '..', 'a/b', 'a\\b', 'a.json', '', 'UPPER', 'a:stream', '__proto__']) test(`profile ID rejects ${JSON.stringify(id)}`, async () => fixture(async directory => { await assert.rejects(loadProfile(id, { directory }), { code: 'INVALID_PROFILE_ID' }); }));
for (const field of Object.keys(example())) test(`missing ${field} is rejected`, () => { const value = example(); delete value[field]; assert.throws(() => validateProfile(value), { code: 'INVALID_PROFILE' }); });
test('null, arrays, prototypes, extra fields, accessors rejected', () => {
  for (const value of [null, [], { ...example(), extra: true }, Object.assign(Object.create({ custom: true }), example())]) assert.throws(() => validateProfile(value));
  const value = example(); Object.defineProperty(value, 'model', { get() { throw Error('getter must not execute'); }, enumerable: true }); assert.throws(() => validateProfile(value), { code: 'INVALID_PROFILE' });
});
for (const value of ['http://api.openai.com', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://x.internal', 'https://x.local', 'https://user:pass@api.openai.com', 'https://api.openai.com?q=x', 'https://api.openai.com#', 'https://api.openai.com?', 'https://api.openai.com\\evil', 'https://api.openai.com.']) test(`base URL rejects ${value}`, () => assert.throws(() => validateBaseUrl(value)));
// Pure validation only: these public-looking fixtures never resolve or connect.
for (const value of ['https://api.provider.com', 'https://api.provider.com/v1', 'https://api.provider.com:443', 'https://api.provider.com:443/v1']) test(`profile and transport agree on HTTPS default port: ${value}`, () => {
  assert.equal(validateBaseUrl(value), value);
  assert.equal(validateProfile({ ...example(), baseUrl: value }).baseUrl, value);
  const endpoint = validateEndpoint(value);
  assert.equal(endpoint.protocol, 'https:');
  assert.equal(endpoint.port, ''); // URL normalizes explicit default 443.
  assert.equal(endpoint.hostname, 'api.provider.com');
});
for (const port of [0, 1, 80, 444, 8443, 65535, 65536]) test(`profile and transport reject alternate/invalid port ${port}`, () => {
  const value = `https://api.provider.com:${port}/v1`;
  assert.throws(() => validateBaseUrl(value), { code: 'INVALID_PROFILE' });
  assert.throws(() => validateProfile({ ...example(), baseUrl: value }), { code: 'INVALID_PROFILE' });
  assert.throws(() => validateEndpoint(value), { code: 'API_ENDPOINT_REJECTED' });
});
for (const [field, value] of [['maxRequests', 21], ['maxInputBytes', 65537], ['maxTotalInputBytes', 1048577], ['maxOutputTokens', 1025], ['maxTotalOutputTokens', 8193], ['timeoutMs', 60001], ['timeoutMs', 0], ['timeoutMs', 1.5]]) test(`limit rejects ${field}=${value}`, () => { const profile = example(); profile.limits[field] = value; assert.throws(() => validateProfile(profile)); });
test('bad generation and null limits reject', () => { const profile = example(); profile.credentialGeneration = 'alias'; assert.throws(() => validateProfile(profile)); profile.credentialGeneration = example().credentialGeneration; profile.limits = null; assert.throws(() => validateProfile(profile)); });
test('file identity mismatch and oversized file reject', async () => fixture(async directory => {
  await writeFile(path.join(directory, 'offline.json'), JSON.stringify({ ...example(), id: 'other' })); await assert.rejects(loadProfile('offline', { directory }), { code: 'INVALID_PROFILE' });
  await writeFile(path.join(directory, 'offline.json'), ' '.repeat(32769)); await assert.rejects(loadProfile('offline', { directory }), { code: 'UNSAFE_PROFILE_PATH' });
}));
test('invalid JSON and missing file have fixed errors', async () => fixture(async directory => {
  await writeFile(path.join(directory, 'offline.json'), '{'); await assert.rejects(loadProfile('offline', { directory }), { code: 'PROFILE_READ_FAILED' }); await assert.rejects(loadProfile('missing', { directory }), { code: 'PROFILE_NOT_FOUND' });
}));
test('junction profile directory is rejected', async () => fixture(async directory => {
  const link = path.join(directory, 'link'); await symlink(directory, link, 'junction'); await assert.rejects(loadProfile('offline', { directory: link }), { code: 'UNSAFE_PROFILE_PATH' }); await rm(link);
}));
test('relative and UNC startup directories reject', async () => { await assert.rejects(readProfiles({ directory: 'relative' }), { code: 'UNSAFE_PROFILE_PATH' }); await assert.rejects(readProfiles({ directory: '\\\\server\\share' }), { code: 'UNSAFE_PROFILE_PATH' }); });
test('top-level and limits Proxy traps never execute', () => {
  let called = false;
  const traps = { ownKeys() { called = true; throw Error('trap'); }, getPrototypeOf() { called = true; throw Error('trap'); }, get() { called = true; throw Error('trap'); } };
  assert.throws(() => validateProfile(new Proxy(example(), traps)), { code: 'INVALID_PROFILE' });
  const value = example(); value.limits = new Proxy(value.limits, traps); assert.throws(() => validateProfile(value), { code: 'INVALID_PROFILE' }); assert.equal(called, false);
});
function state(size) { return { dev: 1n, ino: 2n, size: BigInt(size), mtimeNs: 3n, ctimeNs: 4n, isFile: () => true }; }
test('bounded handle reader detects opened file replacement', async () => {
  const expected = state(2); const handle = { stat: async () => ({ ...expected, ino: 999n }), read: async () => { throw Error('must not read'); } };
  await assert.rejects(readBoundedProfileHandle(handle, expected), { code: 'PROFILE_CHANGED' });
});
test('bounded handle reader caps growing file at 32769 bytes', async () => {
  const expected = state(2); let total = 0;
  const handle = { stat: async () => expected, read: async (buffer, offset, length) => { assert.ok(length <= 32769); buffer.fill(65, offset, offset + length); total += length; return { bytesRead: length }; } };
  await assert.rejects(readBoundedProfileHandle(handle, expected), { code: 'PROFILE_LIMIT' }); assert.equal(total, 32769);
});
test('bounded handle reader detects truncation and changed identity/mtime', async () => {
  for (const change of [{ size: 1n }, { ino: 99n }, { mtimeNs: 99n }, { ctimeNs: 99n }]) {
    const expected = state(2); let reads = 0, stats = 0;
    const handle = { stat: async () => ++stats === 1 ? expected : { ...expected, ...change }, read: async buffer => { if (reads++) return { bytesRead: 0 }; buffer.write('{}'); return { bytesRead: 2 }; } };
    await assert.rejects(readBoundedProfileHandle(handle, expected), { code: 'PROFILE_CHANGED' });
  }
});
test('bounded handle reader accepts a stable exact snapshot', async () => {
  const expected = state(2); let reads = 0;
  const handle = { stat: async () => expected, read: async buffer => { if (reads++) return { bytesRead: 0 }; buffer.write('{}'); return { bytesRead: 2 }; } };
  const result = await readBoundedProfileHandle(handle, expected); assert.equal(result.buffer.toString(), '{}'); assert.equal(result.stat.size, 2n);
});
