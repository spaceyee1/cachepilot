import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSemanticConfiguration } from '../api/semantic-config.mjs';
const root = fileURLToPath(new URL('./', import.meta.url));
test('missing startup settings disable semantic reuse without downloads or a network request', async () => {
  const result = await loadSemanticConfiguration(path.join(root, 'nonexistent-semantic-settings.json'));
  assert.equal(result.cache, null); assert.equal(result.encoder, null);
});
for (const [name, contents] of [['disabled', { enabled: false }], ['cuda', { enabled: true, device: 'cuda' }],
  ['unexpected property', { enabled: false, baseUrl: 'https://remote.invalid' }], ['array', []]]) {
  test(`startup ${name} cannot enable an unintended encoder`, async () => {
    const temp = await mkdtemp(path.join(root, '.semantic-config-'));
    try {
      const file = path.join(temp, 'settings.json'); await writeFile(file, JSON.stringify(contents));
      const result = await loadSemanticConfiguration(file); assert.equal(result.cache, null); assert.equal(result.encoder, null);
    } finally { assert.ok(temp.startsWith(root)); await rm(temp, { recursive: true, force: true }); }
  });
}
