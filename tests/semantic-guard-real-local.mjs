import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createLocalSemanticEncoder } from '../api/semantic-encoder.mjs';
import { SemanticResponseCache } from '../api/semantic-cache.mjs';

// Explicit local CPU diagnosis. Raw diagnostic encoding is intentionally
// separate from production eligibility: a measured cosine does not authorize
// bypassing the literal/language guard. Cached answers below are synthetic.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(root, 'audit', 'guard-real-local.json');
if (fs.existsSync(outputPath)) throw Error('Refusing to overwrite an existing audit');
const settings = JSON.parse(fs.readFileSync(path.join(root, 'semantic-settings.json'), 'utf8'));
assert.equal(settings.device, 'cpu'); assert.equal(settings.threshold, 0.97);
const threshold = 0.97;
const encoder = createLocalSemanticEncoder({ ...settings, device: 'cpu', gpu: false });
const labels = new Map([
  ['backup_allow_seven', 'Delete the backup after seven days.'],
  ['backup_deny_seven', 'Do not delete the backup after seven days.'],
  ['chinese_allow', '可以重启服务'],
  ['chinese_do_not', '不要重启服务'],
  ['chinese_cannot', '不可重启服务'],
  ['number_seven', 'Keep the backup for 7 days.'],
  ['number_thirty', 'Keep the backup for 30 days.'],
]);
const normal = 'Explain how leaves transform sunlight into nourishment';
const vectors = new Map();
const request = text => ({ scope: 'synthetic-cpu-guard-partition', protocol: 'openai-chat',
  body: JSON.stringify({ model: 'synthetic-model', temperature: 0,
    messages: [{ role: 'user', content: text }], max_tokens: 32 }) });
const response = () => ({ model: 'synthetic-model', choices: [{ index: 0,
  message: { role: 'assistant', content: 'Synthetic complete response for eligibility testing only.' }, finish_reason: 'stop' }] });
const hash = name => createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');
const report = {
  schema: 'cachepilot-local-cpu-guard-evidence-v1', startedAtUtc: new Date().toISOString(),
  scope: 'independent_candidate_only', threshold, thresholdAdjusted: false,
  providerRequests: 0, credentialsUsed: false, downloadsRequested: false, gpuExperiment: false,
  safetyScope: 'Node process offline guard plus encoder Python socket denial; not an OS-wide firewall',
  accuracyDisclaimer: 'Cosine is a diagnostic similarity, not equivalence proof. The encoder is English-only; Chinese diagnostic scores do not validate Chinese semantics.',
  coreSha256: hash('api/semantic-cache.mjs'), scriptSha256: hash('tests/semantic-guard-real-local.mjs'),
  rawDiagnostic: { productionGuardBypassedForDiagnosisOnly: true, encoded: [], pairwise: [] },
  production: { answersAreSynthetic: true, guardedSeedCases: [], normalSeedGuardQueries: [], exactOriginalReuse: [] },
  model: { encoderId: encoder.id }, cleanup: null, passed: false,
};
let ownedPid = null, failure = null;
function cosine(left, right) {
  let dot = 0, leftSquares = 0, rightSquares = 0;
  assert.equal(left.length, right.length);
  for (let i = 0; i < left.length; i++) { dot += left[i] * right[i]; leftSquares += left[i] ** 2; rightSquares += right[i] ** 2; }
  return dot / Math.sqrt(leftSquares * rightSquares);
}
function spyCache() {
  let calls = 0, refuseCalls = false;
  const cache = new SemanticResponseCache({ encoderId: encoder.id, threshold, semanticLanguage: 'en', embedTimeoutMs: 30_000,
    embed: async (text, options) => { calls++; if (refuseCalls) throw Error('Guard allowed an unexpected encoder call'); return encoder.embed(text, options); } });
  return { cache, get calls() { return calls; }, refuseEncoderCalls() { refuseCalls = true; } };
}
function evidence(state, query, result, beforeCalls, beforeSemanticHits) {
  return { query, hit: result.hit, match: result.match ?? null, reason: result.reason,
    encoderCallsDelta: state.calls - beforeCalls, semanticHitsDelta: state.cache.status().semanticHits - beforeSemanticHits,
    similarityFieldPresent: Object.hasOwn(result, 'similarity'), ...(Object.hasOwn(result, 'similarity') ? { similarity: result.similarity } : {}) };
}
async function guardedLookup(state, query) {
  const beforeCalls = state.calls, beforeHits = state.cache.status().semanticHits;
  const result = await state.cache.lookup(request(query));
  const value = evidence(state, query, result, beforeCalls, beforeHits);
  assert.equal(result.hit, false); assert.equal(result.reason, 'literal_guard_exact_only'); assert.ok(result.ticket);
  assert.equal(value.encoderCallsDelta, 0); assert.equal(value.semanticHitsDelta, 0); assert.equal(value.similarityFieldPresent, false);
  return { result, value };
}
try {
  for (const [label, text] of labels) {
    const start = performance.now(), vector = await encoder.embed(text);
    ownedPid ??= encoder.status().workerPid; assert.ok(ownedPid); vectors.set(label, vector);
    report.rawDiagnostic.encoded.push({ label, text, dimensions: vector.length, elapsedMs: +(performance.now() - start).toFixed(3) });
  }
  for (const [kind, left, right] of [
    ['english_negation', 'backup_allow_seven', 'backup_deny_seven'],
    ['numeric_change', 'number_seven', 'number_thirty'],
    ['chinese_opposition_diagnostic_only', 'chinese_allow', 'chinese_do_not'],
    ['chinese_opposition_diagnostic_only', 'chinese_allow', 'chinese_cannot'],
    ['chinese_negation_variants_diagnostic_only', 'chinese_do_not', 'chinese_cannot'],
  ]) {
    const score = cosine(vectors.get(left), vectors.get(right));
    report.rawDiagnostic.pairwise.push({ kind, left, right, cosine: score, fixedThreshold: threshold,
      rawScoreAtOrAboveThreshold: score >= threshold, productionSemanticReuseAllowedByRawScoreAlone: false });
  }
  report.model = { ...report.model, ...encoder.status() };
  assert.equal(report.model.device, 'cpu'); assert.equal(report.model.gpu, false);
  assert.equal(report.model.parameterDevice, 'cpu'); assert.equal(report.model.torchCudaInitialized, false); assert.equal(report.model.network, false);

  const cases = [
    { seed: 'backup_allow_seven', probes: ['backup_deny_seven'] },
    { seed: 'chinese_allow', probes: ['chinese_do_not', 'chinese_cannot'] },
    { seed: 'number_seven', probes: ['number_thirty'] },
  ];
  for (const item of cases) {
    const state = spyCache(); state.refuseEncoderCalls();
    const seeded = await guardedLookup(state, labels.get(item.seed));
    assert.equal(await state.cache.store(seeded.result.ticket, response()), true);
    const probes = [];
    for (const probe of item.probes) probes.push((await guardedLookup(state, labels.get(probe))).value);
    report.production.guardedSeedCases.push({ seed: item.seed, seedEvidence: seeded.value, syntheticResponseStored: true, probes,
      totalEncoderCalls: state.calls, semanticHits: state.cache.status().semanticHits });
    const beforeCalls = state.calls, beforeHits = state.cache.status().semanticHits;
    const exact = await state.cache.lookup(request(labels.get(item.seed)));
    assert.equal(exact.hit, true); assert.equal(exact.match, 'exact'); assert.equal(state.calls, beforeCalls);
    report.production.exactOriginalReuse.push({ seed: item.seed, allowed: true,
      ...evidence(state, labels.get(item.seed), exact, beforeCalls, beforeHits) });
  }

  const normalState = spyCache(); const start = performance.now();
  const normalMiss = await normalState.cache.lookup(request(normal));
  assert.equal(normalMiss.hit, false); assert.ok(normalMiss.ticket); assert.equal(normalState.calls, 1);
  assert.equal(await normalState.cache.store(normalMiss.ticket, response()), true);
  report.production.normalSeed = { query: normal, realCpuEncoderCalls: 1, elapsedMs: +(performance.now() - start).toFixed(3), syntheticResponseStored: true };
  normalState.refuseEncoderCalls();
  for (const [label, text] of labels) report.production.normalSeedGuardQueries.push({ label, ...(await guardedLookup(normalState, text)).value });
  report.production.normalSeedFinalState = { totalEncoderCalls: normalState.calls, semanticHits: normalState.cache.status().semanticHits,
    threshold: normalState.cache.status().threshold, nonEnglishPolicy: normalState.cache.status().nonEnglishPolicy };
  assert.equal(normalState.calls, 1); assert.equal(normalState.cache.status().semanticHits, 0);
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { name: error?.name ?? 'Error', code: error?.code ?? null, message: String(error?.message ?? 'failure').slice(0, 300) };
} finally {
  let closeFailure = null, stillExists = null;
  try { await encoder.close(); } catch (error) { closeFailure = error?.code ?? error?.message ?? 'close_failed'; }
  if (ownedPid) {
    try { process.kill(ownedPid, 0); stillExists = true; }
    catch (error) { if (error?.code === 'ESRCH') stillExists = false; else closeFailure ??= `existence_check_${error?.code ?? 'unknown'}`; }
  }
  report.cleanup = { ownedPid, closeAwaited: true, ownedPidStillExists: stillExists, workerExitedVerified: ownedPid !== null && stillExists === false,
    closeFailure, finalEncoderState: encoder.status().state };
  if (closeFailure || !report.cleanup.workerExitedVerified) { report.passed = false; failure ??= Error('Owned worker cleanup not verified'); }
  report.finishedAtUtc = new Date().toISOString();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
}
console.log(JSON.stringify({ report: path.relative(root, outputPath), passed: report.passed, rawPairs: report.rawDiagnostic.pairwise,
  productionGuardedProbes: report.production.normalSeedGuardQueries.length, cleanup: report.cleanup }));
if (failure) throw failure;
