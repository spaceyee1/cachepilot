import { lstat, readdir, open } from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import { types } from 'node:util';

const ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROTOCOLS = new Set(['openai-responses', 'openai-chat', 'deepseek-chat', 'anthropic-messages', 'gemini']);
const PROFILE_KEYS = ['version', 'id', 'label', 'protocol', 'baseUrl', 'model', 'credentialGeneration', 'networkEnabled', 'limits', 'credentialCipher'];
const LIMITS = { maxRequests: 20, maxInputBytes: 65536, maxTotalInputBytes: 1048576, maxOutputTokens: 1024, maxTotalOutputTokens: 8192, timeoutMs: 60000 };
function fail(code = 'INVALID_PROFILE') { const error = new Error(code); error.code = code; throw error; }
function record(value, keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const own = Object.keys(value);
  if (own.length !== keys.length || own.some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail();
}
function text(value, max) { if (typeof value !== 'string' || !value.length || value.length > max || /[\x00-\x1f\x7f]/u.test(value)) fail(); return value; }
export function validateProfileId(id) { if (typeof id !== 'string' || !ID.test(id)) fail('INVALID_PROFILE_ID'); return id; }
export function validateBaseUrl(value) {
  text(value, 2048);
  if (/[\\\s?#]/u.test(value)) fail();
  let url; try { url = new URL(value); } catch { fail(); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443') || isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || host.endsWith('.') || /(?:^|\.)(?:localhost|local|internal|invalid|test|example|onion)$/.test(host) || !/^[a-z0-9.-]+$/.test(host) || host.split('.').some(part => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) fail();
  return value;
}
export function validateProfile(value) {
  record(value, PROFILE_KEYS);
  if (value.version !== 1 || !PROTOCOLS.has(value.protocol) || typeof value.networkEnabled !== 'boolean' || typeof value.credentialGeneration !== 'string' || !UUID.test(value.credentialGeneration)) fail();
  validateProfileId(value.id); text(value.label, 96); text(value.model, 160); validateBaseUrl(value.baseUrl);
  if (typeof value.credentialCipher !== 'string' || value.credentialCipher.length < 4 || value.credentialCipher.length > 16384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.credentialCipher)) fail();
  record(value.limits, Object.keys(LIMITS));
  for (const [key, max] of Object.entries(LIMITS)) if (!Number.isSafeInteger(value.limits[key]) || value.limits[key] < 1 || value.limits[key] > max) fail();
  if (value.limits.maxTotalInputBytes < value.limits.maxInputBytes || value.limits.maxTotalOutputTokens < value.limits.maxOutputTokens) fail();
  const { credentialCipher, ...metadata } = value;
  return Object.freeze({ ...metadata, limits: Object.freeze({ ...metadata.limits }) });
}
export function profileDirectory() {
  const local = process.env.LOCALAPPDATA;
  if (process.platform !== 'win32' || !local || !path.win32.isAbsolute(local) || local.startsWith('\\\\')) fail('PROFILE_DIRECTORY_UNAVAILABLE');
  return path.join(local, 'CachePilotApi', 'profiles');
}
// directory is startup-only dependency injection for isolated offline tests; never an MCP tool argument.
async function safeDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.startsWith('\\\\') || directory.includes('\0')) fail('UNSAFE_PROFILE_PATH');
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved); let cursor = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat; try { stat = await lstat(cursor); } catch (error) { if (error.code === 'ENOENT') fail('PROFILE_NOT_FOUND'); fail('PROFILE_READ_FAILED'); }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('UNSAFE_PROFILE_PATH');
  }
  return resolved;
}
const sameFileState = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
// Internal test seam: a bounded reader for an already-open handle, not an MCP path API.
export async function readBoundedProfileHandle(handle, expected) {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile() || before.size > 32768n || !sameFileState(expected, before)) fail('PROFILE_CHANGED');
  const buffer = Buffer.alloc(32769); let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
    if (!bytesRead) break; length += bytesRead;
  }
  if (length > 32768) fail('PROFILE_LIMIT');
  const after = await handle.stat({ bigint: true });
  if (!sameFileState(before, after) || BigInt(length) !== after.size) fail('PROFILE_CHANGED');
  return { buffer: buffer.subarray(0, length), stat: after };
}
export async function loadProfile(id, { directory } = {}) {
  validateProfileId(id);
  const root = await safeDirectory(directory ?? profileDirectory());
  const file = path.join(root, `${id}.json`);
  let stat; try { stat = await lstat(file, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') fail('PROFILE_NOT_FOUND'); fail('PROFILE_READ_FAILED'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768n) fail('UNSAFE_PROFILE_PATH');
  let handle, value;
  try {
    handle = await open(file, 'r');
    // Read at most one byte beyond the cap; growth after lstat never causes an unbounded allocation.
    const { buffer, stat: after } = await readBoundedProfileHandle(handle, stat);
    await safeDirectory(root);
    const afterPath = await lstat(file, { bigint: true });
    if (afterPath.isSymbolicLink() || !afterPath.isFile()) fail('UNSAFE_PROFILE_PATH');
    if (!sameFileState(after, afterPath)) fail('PROFILE_CHANGED');
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  } catch (error) {
    if (['PROFILE_CHANGED', 'PROFILE_LIMIT', 'UNSAFE_PROFILE_PATH'].includes(error.code)) throw error;
    fail('PROFILE_READ_FAILED');
  } finally { await handle?.close(); }
  const metadata = validateProfile(value);
  if (metadata.id !== id) fail();
  return metadata;
}
export async function readProfiles({ directory } = {}) {
  let root; try { root = await safeDirectory(directory ?? profileDirectory()); } catch (error) { if (error.code === 'PROFILE_NOT_FOUND') return []; throw error; }
  let entries; try { entries = await readdir(root, { withFileTypes: true }); } catch { fail('PROFILE_READ_FAILED'); }
  const profiles = entries.filter(entry => entry.name.endsWith('.json'));
  if (profiles.length > 64) fail('PROFILE_LIMIT');
  const result = [];
  for (const entry of profiles.sort((a, b) => a.name.localeCompare(b.name))) result.push(await loadProfile(entry.name.slice(0, -5), { directory: root }));
  return result;
}
