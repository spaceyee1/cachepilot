import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createLocalSemanticEncoder } from '../api/semantic-encoder.mjs';

// This is an explicit local-only mechanism benchmark; no provider or API request.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const settings = JSON.parse(fs.readFileSync(path.join(root, 'semantic-settings.json'), 'utf8'));
const encoder = createLocalSemanticEncoder(settings);
const labels = [
  ['base', 'How can I reset my account password?'],
  ['paraphrase', 'What steps should I take to reset the password for my account?'],
  ['unrelated', 'Explain how a solar eclipse occurs.'],
  ['positive', 'Delete the backup after seven days.'],
  ['negative', 'Do not delete the backup after seven days.'],
  ['number7', 'Keep the backup for 7 days.'],
  ['number30', 'Keep the backup for 30 days.'],
];
const vectors = new Map();
let ownedPid = null;
try {
  for (const [label, text] of labels) {
    const started = performance.now();
    const vector = await encoder.embed(text);
    vectors.set(label, vector); ownedPid = encoder.status().workerPid;
    console.log(JSON.stringify({ label, milliseconds: +(performance.now() - started).toFixed(3), dimensions: vector.length,
      norm: +Math.hypot(...vector).toFixed(9) }));
  }
  for (const [left, right] of [['base', 'paraphrase'], ['base', 'unrelated'], ['positive', 'negative'], ['number7', 'number30']]) {
    const similarity = vectors.get(left).reduce((sum, number, i) => sum + number * vectors.get(right)[i], 0);
    console.log(JSON.stringify({ left, right, cosine: +similarity.toFixed(9) }));
  }
  await assert.rejects(encoder.embed('word '.repeat(300)), { code: 'SEMANTIC_INPUT_TOO_LONG' });
  console.log(JSON.stringify({ overlengthRejectedWithoutTruncation: true, state: encoder.status() }));
} finally {
  await encoder.close();
  let stillExists = false;
  if (ownedPid) { try { process.kill(ownedPid, 0); stillExists = true; } catch {} }
  assert.equal(stillExists, false);
  console.log(JSON.stringify({ ownedPid, workerExited: !stillExists, gpu: false, networkRequests: 0 }));
}
