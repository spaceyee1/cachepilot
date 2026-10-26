import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { API_VERSION } from '../api/version.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('universal package metadata declares the standard MCP entry without a host-specific manifest', async () => {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'cachepilot');
  assert.equal(pkg.version, API_VERSION);
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(typeof pkg.description, 'string');
  assert.match(pkg.description, /MCP/i);
  assert.doesNotMatch(pkg.description, /Codex/i);
  assert.deepEqual(pkg.cachepilot, {
    integration: 'mcp-stdio', entry: 'scripts/api-mcp.mjs', icon: 'assets/icon.svg',
    supportedPlatform: 'win32', hostSpecificManifestRequired: false,
  });
  assert.deepEqual(pkg.scripts, {
    start: 'node scripts/api-mcp.mjs',
    'mcp:config': 'node scripts/mcp-config.mjs',
    test: 'node --import ./tests/offline-guard.mjs --test tests/*.test.mjs',
    verify: 'node scripts/verify.mjs',
  });
  for (const name of ['.codex-plugin/plugin.json', '.mcp.json']) {
    await assert.rejects(lstat(path.join(root, name)), { code: 'ENOENT' });
  }
  const entry = await lstat(path.join(root, pkg.cachepilot.entry));
  assert.ok(entry.isFile() && !entry.isSymbolicLink());
});

test('universal icon is a bounded square SVG with no executable or external content', async () => {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const name = pkg.cachepilot.icon;
  assert.match(name, /^assets\/[a-z0-9-]+\.svg$/);
  const file = path.resolve(root, name);
  assert.ok(file.startsWith(path.resolve(root) + path.sep));
  const stat = await lstat(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.ok(stat.size < 5 * 1024 * 1024);
  const svg = await readFile(file, 'utf8');
  assert.match(svg, /<svg\s/);
  for (const attribute of ['width="96"', 'height="96"', 'viewBox="0 0 96 96"']) assert.ok(svg.includes(attribute));
  assert.doesNotMatch(svg, /<(?:script|foreignObject|image)\b/i);
  assert.doesNotMatch(svg, /\son\w+\s*=/i);
  assert.doesNotMatch(svg, /(?:href|url)\s*[=(]|<!DOCTYPE|<!ENTITY/i);
});
