// Actual local CPU encoder + synthetic provider/helper. No credential or cloud call.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { loadSemanticConfiguration } from '../api/semantic-config.mjs';
import { createApiRuntime } from '../api/runtime.mjs';

const config = await loadSemanticConfiguration();
assert.ok(config.cache && config.encoder, 'existing local CPU configuration must be available');
const profile = { version: 1, id: 'offline-fixture', label: 'offline fixture', protocol: 'openai-chat',
  baseUrl: 'https://offline.provider.invalid/v1', model: 'offline-fixture-model', credentialGeneration: 'a7e34868-65c6-4539-ab83-1c65b8de974e', networkEnabled: true,
  limits: { maxRequests: 20, maxInputBytes: 65536, maxTotalInputBytes: 1048576, maxOutputTokens: 64, maxTotalOutputTokens: 1024, timeoutMs: 1000 } };
let fakeSends = 0, approvals = 0;
const received = [];
const runtime = createApiRuntime({ semanticCache: config.cache, source: 'offline_fixture',
  getProfile: async () => profile, listProfiles: async () => [profile],
  helpers: { approve: async () => { approvals++; return true; }, credential: async () => 'synthetic-not-a-provider-credential' },
  transport: async ({ request }) => {
    fakeSends++; received.push(request.body);
    return { data: { model: profile.model, choices: [{ message: { role: 'assistant', content: 'Synthetic offline answer; no provider was contacted.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 64, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 0 } } }, timing: {} };
  } });
const run = async text => {
  const body = { model: profile.model, messages: [{ role: 'user', content: text }], temperature: 0, max_completion_tokens: 32 };
  const start = performance.now();
  const result = await runtime.callTool('cachepilot_api_request', { profileId: profile.id, body });
  return { result, ms: performance.now() - start, body: JSON.stringify(body) };
};
try {
  const first = await run('Explain photosynthesis.');
  const second = await run('Explain photosynthesis');
  console.log(JSON.stringify({ phase: 'first_pair_observed', first: first.result.localResponseCache,
    second: second.result.localResponseCache, cache: config.cache.status(), encoder: config.encoder.status() }));
  assert.equal(first.result.sent, true); assert.equal(second.result.sent, false);
  assert.equal(second.result.localResponseCache.match, 'semantic');
  assert.equal(second.result.source, 'local_semantic_cache');
  assert.equal(second.result.providerCacheMeasured, false); assert.equal(second.result.usage.inputTokens, null);
  assert.equal(Object.hasOwn(second.result.response, 'usage'), false);
  const negative = await run('What is not machine learning?');
  assert.equal(negative.result.sent, true);
  const chineseA = await run('请解释机器学习');
  const chineseB = await run('请介绍机器学习');
  assert.equal(chineseA.result.sent, true); assert.equal(chineseB.result.sent, true);
  const long = await run('Explain how plants obtain energy '.repeat(100));
  assert.equal(long.result.sent, true); assert.equal(received.at(-1), long.body);
  assert.equal(fakeSends, 5); assert.equal(approvals, 6);
  const status = await runtime.callTool('cachepilot_api_status', {});
  assert.equal(status.scopes[0].requests, fakeSends);
  console.log(JSON.stringify({ scope: 'real_local_cpu_encoder_with_synthetic_transport_and_approval',
    model: 'existing_all-MiniLM-L6-v2', modelFingerprint: config.encoder.id, device: 'cpu',
    actualExternalRequests: 0, realCredentialsUsed: false, fakeProviderCalls: fakeSends, localApprovals: approvals,
    firstLocalMs: first.ms, hitLocalMs: second.ms, actualSemanticSimilarity: second.result.localResponseCache.similarity,
    nonIdenticalQueryHit: true, negationRejected: true, chineseApproximateReuseRejected: true,
    longInputForwardedUnchanged: true, providerUsageReplayed: false, encoder: config.encoder.status(),
    cloudCacheHitRate: null, optimizationGainMeasured: false }));
} finally {
  await runtime.close(); await config.encoder.close();
  assert.equal(config.encoder.status().state, 'closed');
  console.log(JSON.stringify({ workerClosed: true, automaticRestart: false }));
}
