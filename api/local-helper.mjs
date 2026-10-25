import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { loadProfile, validateProfileId } from './profiles.mjs';
import { boundedLocalRead } from './wait.mjs';

function failure(code) { const error = new Error(code); error.code = code; if (code === 'HELPER_TERMINATION_UNCONFIRMED') error.terminationUnconfirmed = true; return error; }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function cleanEnvironment() {
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'LOCALAPPDATA', 'USERPROFILE', 'TEMP', 'TMP']) if (typeof process.env[name] === 'string') env[name] = process.env[name];
  env.PATH = 'C:\\Windows\\System32;C:\\Windows';
  return env;
}
// spawnImpl is startup-only test injection, never exposed to the MCP caller.
export function createLocalHelpers({ scriptRoot, profileDirectory: directory, spawnImpl = spawn, timeoutMs = 45000, terminationWaitMs = 2000 } = {}) {
  if (typeof scriptRoot !== 'string' || !path.isAbsolute(scriptRoot) || scriptRoot.startsWith('\\\\') || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 45000 || !Number.isInteger(terminationWaitMs) || terminationWaitMs < 1 || terminationWaitMs > 2000) throw failure('HELPER_CONFIGURATION');
  async function current(profile, signal) {
    validateProfileId(profile?.id);
    let saved;
    try { saved = await boundedLocalRead(() => loadProfile(profile.id, { directory }), signal); }
    catch (error) { if (error.code === 'API_CANCELLED') throw failure('HELPER_ABORTED'); throw error; }
    if (!UUID.test(profile?.credentialGeneration) || saved.credentialGeneration !== profile.credentialGeneration) throw failure('CREDENTIAL_CHANGED');
    return saved;
  }
  async function run(scriptName, args, input, signal) {
    if (signal?.aborted) throw failure('HELPER_ABORTED');
    const mode = { 'Credential-Helper.ps1': 'read', 'Confirm-Api.ps1': 'approve', 'Show-Gateway.ps1': 'gateway' }[scriptName];
    if (!mode) throw failure('HELPER_CONFIGURATION');
    const executable = path.resolve(scriptRoot, '..', 'ui', 'CachePilot.ApiLocalHelper.exe');
    const nativeArgs = mode === 'read' ? [mode, args[1], args[3]] : [mode];
    const parsed = path.parse(executable); let cursor = parsed.root;
    for (const segment of executable.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      let stat; try { stat = await lstat(cursor); } catch { throw failure('HELPER_UNAVAILABLE'); }
      if (stat.isSymbolicLink()) throw failure('HELPER_UNSAFE_PATH');
    }
    if (Buffer.byteLength(input) > 81920) throw failure('HELPER_INPUT_LIMIT');
    return new Promise((resolve, reject) => {
      let child, settled = false, killed = false, closed = false, failureCode = null, terminationTimer, bytes = 0, chunks = [];
      const stop = () => { if (!killed && child && !closed) { killed = true; try { child.kill(); } catch {} } };
      const finish = (error, value) => {
        if (settled) return; settled = true; clearTimeout(timer); clearTimeout(terminationTimer); signal?.removeEventListener('abort', onAbort);
        if (error) reject(failure(error)); else resolve(value);
        chunks = [];
      };
      const fail = code => {
        if (settled || failureCode) return;
        failureCode = code; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
        if (!child || closed) return finish(code);
        // Do not release the caller's slot merely because kill() was requested.
        terminationTimer = setTimeout(() => finish('HELPER_TERMINATION_UNCONFIRMED'), terminationWaitMs);
        stop();
      };
      const onAbort = () => fail('HELPER_ABORTED');
      const timer = setTimeout(() => fail('HELPER_TIMEOUT'), timeoutMs);
      try {
        child = spawnImpl(executable, nativeArgs, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: cleanEnvironment() });
        child.on('error', () => fail('HELPER_FAILED'));
        child.stdout.on('data', chunk => { if (settled || failureCode) return; bytes += Buffer.byteLength(chunk); if (bytes > 16384) return fail('HELPER_OUTPUT_LIMIT'); chunks.push(Buffer.from(chunk)); });
        child.stdout.on('error', () => fail('HELPER_FAILED'));
        // Never include stderr or stdout in error messages, logs, or MCP results.
        child.stderr.on('data', () => {}); child.stderr.on('error', () => fail('HELPER_FAILED'));
        child.stdin.on('error', () => fail('HELPER_FAILED'));
        child.on('close', code => {
          closed = true;
          if (settled) return;
          if (failureCode) return finish(failureCode);
          if (code !== 0) return finish('HELPER_FAILED');
          let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return finish('HELPER_INVALID_RESPONSE'); }
          if (!plain(value)) return finish('HELPER_INVALID_RESPONSE');
          finish(null, value);
        });
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) return onAbort();
        child.stdin.end(input);
      } catch { fail('HELPER_FAILED'); }
    });
  }
  return {
    async credential(profile, signal) {
      const saved = await current(profile, signal);
      const value = await run('Credential-Helper.ps1', ['-ProfileId', saved.id, '-ExpectedGeneration', saved.credentialGeneration], '', signal);
      if (Object.keys(value).sort().join(',') !== 'generation,key' || value.generation !== saved.credentialGeneration || typeof value.key !== 'string' || value.key.length < 1 || value.key.length > 4096 || /[\x00-\x20\x7f]/.test(value.key)) throw failure('HELPER_INVALID_RESPONSE');
      await current(saved, signal); // Discard an in-flight result if binding changed while decrypting.
      if (signal?.aborted) throw failure('HELPER_ABORTED');
      return value.key;
    },
    async approve({ profile, body, requestId, bodyHash }, signal) {
      const saved = await current(profile, signal);
      let bodyText; try { bodyText = typeof body === 'string' ? body : JSON.stringify(body); } catch { throw failure('INVALID_PREVIEW'); }
      if (!UUID.test(requestId) || typeof bodyText !== 'string' || !/^[0-9a-f]{64}$/.test(bodyHash) || createHash('sha256').update(bodyText).digest('hex') !== bodyHash) throw failure('INVALID_PREVIEW');
      const value = await run('Confirm-Api.ps1', [], JSON.stringify({ requestId, bodyHash, bodyText, baseUrl: saved.baseUrl, model: saved.model, protocol: saved.protocol, maxOutputTokens: saved.limits.maxOutputTokens }), signal);
      if (Object.keys(value).sort().join(',') !== 'approved,bodyHash,requestId' || typeof value.approved !== 'boolean' || value.requestId !== requestId || value.bodyHash !== bodyHash) throw failure('HELPER_INVALID_RESPONSE');
      await current(saved, signal);
      if (signal?.aborted) throw failure('HELPER_ABORTED');
      return value.approved;
    },
    async showGateway(details, signal) {
      if (!plain(details) || Object.keys(details).sort().join(',') !== 'address,expiresAt,model,profileId,protocol,token' || typeof details.address !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(details.address) || Number(details.address.split(':').at(-1)) > 65535 || typeof details.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(details.token) || typeof details.expiresAt !== 'string' || !Number.isFinite(Date.parse(details.expiresAt)) || typeof details.model !== 'string' || details.model.length > 160 || typeof details.protocol !== 'string' || !['openai-responses', 'openai-chat', 'deepseek-chat', 'anthropic-messages', 'gemini'].includes(details.protocol)) throw failure('INVALID_GATEWAY_DETAILS');
      validateProfileId(details.profileId);
      const value = await run('Show-Gateway.ps1', [], JSON.stringify(details), signal);
      if (Object.keys(value).join(',') !== 'shown' || value.shown !== true) throw failure('HELPER_INVALID_RESPONSE');
      if (signal?.aborted) throw failure('HELPER_ABORTED');
      return true;
    }
  };
}
