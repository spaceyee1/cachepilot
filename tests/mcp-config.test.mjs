import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { createMcpConfig } from '../scripts/mcp-config.mjs';
import { API_VERSION } from '../api/version.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'scripts', 'mcp-config.mjs');
const apiScript = path.join(root, 'scripts', 'api-mcp.mjs');
const guard = pathToFileURL(path.join(root, 'tests', 'offline-guard.mjs')).href;
const gpuOff = { CACHEPILOT_GPU: 'off', CUDA_VISIBLE_DEVICES: '-1', NVIDIA_VISIBLE_DEVICES: 'none' };

function checkEntry(entry) {
  assert.deepEqual(entry, { command: process.execPath, args: [apiScript], env: gpuOff });
  assert.ok(path.isAbsolute(entry.command));
  assert.ok(path.isAbsolute(entry.args[0]));
  assert.deepEqual(Object.keys(entry).sort(), ['args', 'command', 'env']);
}

function cleanEnvironment(extra = {}) {
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (typeof process.env[name] === 'string') env[name] = process.env[name];
  }
  return { ...env, ...gpuOff, CACHEPILOT_API_MONITOR: 'off', ...extra };
}

async function boundedExit(done, timeoutMs) {
  let timer;
  try { return await Promise.race([done, new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

async function runCli(args, extra = {}) {
  const child = spawn(process.execPath, ['--import', guard, script, ...args], {
    cwd: os.tmpdir(), windowsHide: true, env: cleanEnvironment(extra), stdio: ['ignore', 'pipe', 'pipe'],
  });
  const done = once(child, 'close');
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const timer = setTimeout(() => child.kill(), 5000);
  try { const [code, signal] = await done; return { code, signal, stdout, stderr }; }
  finally { clearTimeout(timer); }
}

test('MCP configuration has explicit wrapped and bare standard entries with absolute paths', () => {
  const wrapped = createMcpConfig();
  assert.deepEqual(Object.keys(wrapped), ['mcpServers']);
  assert.deepEqual(Object.keys(wrapped.mcpServers), ['cachepilot']);
  checkEntry(wrapped.mcpServers.cachepilot);
  assert.deepEqual(createMcpConfig('mcpServers'), wrapped);
  checkEntry(createMcpConfig('server'));
});

test('MCP configuration refuses unsupported formats instead of generating a host-specific fallback', () => {
  for (const value of [null, '', 'codex', 'MCPServers', '--format', {}, [], 0, true]) assert.throws(() => createMcpConfig(value));
});

test('MCP configuration does not inherit environment secrets, model settings or host paths', () => {
  const names = ['CACHEPILOT_CONFIG_TEST_SECRET', 'CACHEPILOT_SEMANTIC_CONFIG'];
  const previous = new Map(names.map(name => [name, process.env[name]]));
  try {
    process.env.CACHEPILOT_CONFIG_TEST_SECRET = 'synthetic-not-a-provider-credential';
    process.env.CACHEPILOT_SEMANTIC_CONFIG = path.join(os.tmpdir(), 'not-a-real-model-config.json');
    const value = createMcpConfig();
    checkEntry(value.mcpServers.cachepilot);
    assert.doesNotMatch(JSON.stringify(value), /synthetic-not-a-provider-credential|not-a-real-model-config/);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('configuration CLI works outside the package directory and emits only JSON with GPU off', async () => {
  for (const [args, format] of [[[], 'mcpServers'], [['--format', 'server'], 'server'], [['--format', 'mcpServers'], 'mcpServers']]) {
    const result = await runCli(args, { CACHEPILOT_CONFIG_TEST_SECRET: 'synthetic-config-leak-sentinel' });
    assert.equal(result.code, 0); assert.equal(result.signal, null); assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), createMcpConfig(format));
    assert.doesNotMatch(result.stdout, /synthetic-config-leak-sentinel/);
  }
});

test('configuration CLI rejects ambiguous or extra arguments without stdout or sensitive diagnostics', async () => {
  for (const args of [['server'], ['--format'], ['--format', 'codex'], ['--format=server'], ['--format', 'server', 'extra']]) {
    const result = await runCli(args);
    assert.equal(result.code, 1); assert.equal(result.signal, null); assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'MCP_CONFIG_ARGUMENTS_REJECTED');
  }
});

for (const clientName of ['generic-editor-test', 'independent-agent-test']) {
  test(`generated entry initializes the real MCP server for ${clientName} from another working directory`, { timeout: 15000 }, async () => {
    const entry = createMcpConfig('server');
    const local = path.join(root, 'tests', '.mcp-config-unused-local-' + process.pid + '-' + clientName);
    const child = spawn(entry.command, ['--import', guard, ...entry.args], {
      cwd: os.tmpdir(), windowsHide: true, env: cleanEnvironment({ ...entry.env, LOCALAPPDATA: local }), stdio: ['pipe', 'pipe', 'pipe'],
    });
    const done = once(child, 'close');
    let raw = '', stderr = '', malformed = null, closed = false;
    const responses = new Map();
    child.on('close', () => { closed = true; });
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      raw += chunk;
      let end;
      while ((end = raw.indexOf('\n')) >= 0) {
        const line = raw.slice(0, end); raw = raw.slice(end + 1);
        try { const value = JSON.parse(line); if (value.id !== undefined) responses.set(value.id, value); }
        catch (error) { malformed = error; }
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const wait = async id => {
      const deadline = performance.now() + 5000;
      while (!responses.has(id) && !closed && !malformed && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(malformed, null);
      assert.ok(responses.has(id), 'missing MCP response; fixed diagnostic=' + stderr);
      return responses.get(id);
    };
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    try {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: clientName, version: '1.0' } } });
      assert.equal((await wait(1)).result.serverInfo.version, API_VERSION);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      assert.ok((await wait(2)).result.tools.some(tool => tool.name === 'cachepilot_api_status'));
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'cachepilot_api_status', arguments: {} } });
      const result = (await wait(3)).result;
      assert.equal(result.isError, false);
      const status = result.structuredContent;
      assert.equal(status.pid, child.pid); assert.equal(status.version, API_VERSION);
      assert.equal(status.device, 'off'); assert.equal(status.networkAttempts, 0);
      assert.equal(status.hostRequestsIntercepted, false);
      assert.deepEqual(status.profiles, []); assert.deepEqual(status.scopes, []);
      assert.equal(status.semanticCache.enabled, false);
      child.stdin.end();
      const exit = await boundedExit(done, 3000);
      assert.ok(exit, 'server did not exit on stdio EOF');
      assert.deepEqual(exit, [0, null]);
      assert.equal(stderr, '');
    } finally {
      if (!closed) { child.kill(); await boundedExit(done, 1000); }
    }
  });
}
