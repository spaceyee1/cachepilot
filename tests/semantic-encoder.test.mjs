import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalSemanticEncoder, validateEmbeddingVector } from '../api/semantic-encoder.mjs';

const unit = Array.from({ length: 384 }, (_, i) => i ? 0 : 1);
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'cachepilot-semantic-unit-'));
  mkdirSync(path.join(root, '1_Pooling'));
  for (const name of ['config.json', 'tokenizer.json', 'tokenizer_config.json',
    'sentence_bert_config.json', '1_Pooling/config.json', 'model.safetensors']) writeFileSync(path.join(root, name), '{}');
  return { root, config: { pythonPath: process.execPath, modelPath: root, timeoutMs: 500 },
    dispose: () => rmSync(root, { recursive: true, force: true }) };
}
function mockEncoder(config, mode = 'normal') {
  let encoder, calls = 0, kills = 0, observed, lastChild;
  encoder = createLocalSemanticEncoder(config, { spawnChild(executable, args, options) {
    calls++; observed = { executable, args, options };
    const child = new EventEmitter(); lastChild = child;
    child.pid = 424242;
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => { kills++; child.killed = true; setImmediate(() => child.emit('exit', null, 'SIGTERM')); return true; };
    child.stdin.on('data', bytes => {
      const request = JSON.parse(bytes.toString());
      if (mode === 'silent') return;
      const frame = mode === 'invalid' ? { requestId: request.requestId, id: encoder.id, vector: [0] }
        : mode === 'overlength' ? { requestId: request.requestId, error: 'SEMANTIC_INPUT_TOO_LONG' }
          : { requestId: request.requestId, id: encoder.id, vector: unit };
      setImmediate(() => child.stdout.write(JSON.stringify(frame) + '\n'));
    });
    setImmediate(() => {
      if (mode === 'spawnError') { child.emit('error', new Error('fixture')); return; }
      if (mode === 'startupSilent') return;
      child.stdout.write(JSON.stringify({ type: 'ready', id: mode === 'wrongId' ? 'wrong' : encoder.id,
        device: 'cpu', parameterDevice: 'cpu', torchCudaInitialized: false,
        network: false, dimensions: 384, maxTokens: 256 }) + '\n');
    });
    return child;
  } });
  return { encoder, calls: () => calls, kills: () => kills, observed: () => observed, child: () => lastChild };
}
async function run(mode, body, extra = {}) {
  const f = fixture(); let mock;
  try { mock = mockEncoder({ ...f.config, ...extra }, mode); await body(mock); }
  finally { if (mock) await mock.encoder.close(); f.dispose(); }
}

test('semantic encoder rejects remote, relative, GPU and missing paths', () => {
  assert.throws(() => createLocalSemanticEncoder({ baseUrl: 'https://example.invalid' }), { code: 'SEMANTIC_LOCAL_CPU_ONLY' });
  assert.throws(() => createLocalSemanticEncoder({ gpu: true }), { code: 'SEMANTIC_LOCAL_CPU_ONLY' });
  for (const device of ['cuda', 'auto', 'mps', null])
    assert.throws(() => createLocalSemanticEncoder({ device }), { code: 'SEMANTIC_LOCAL_CPU_ONLY' });
  for (const gpu of ['false', 0, null])
    assert.throws(() => createLocalSemanticEncoder({ gpu }), { code: 'SEMANTIC_LOCAL_CPU_ONLY' });
  assert.throws(() => createLocalSemanticEncoder({ pythonPath: 'python', modelPath: 'model' }), { code: 'SEMANTIC_LOCAL_PATH_REQUIRED' });
});
test('semantic encoder model identity includes content and version', () => {
  const f = fixture();
  try {
    const first = createLocalSemanticEncoder(f.config);
    writeFileSync(path.join(f.root, 'model.safetensors'), '{"changed":true}');
    const second = createLocalSemanticEncoder(f.config);
    assert.notEqual(first.id, second.id); assert.match(first.id, /bert-mean-l2-v1-sha256:/);
  } finally { f.dispose(); }
});
test('semantic encoder rejects invalid text before worker start', () => run('normal', async m => {
  for (const value of ['', ' ', null, 'x'.repeat(12289)]) await assert.rejects(m.encoder.embed(value), { code: 'SEMANTIC_INVALID_INPUT' });
  for (const signal of [null, {}, { aborted: false }]) await assert.rejects(m.encoder.embed('synthetic', { signal }), { code: 'SEMANTIC_INVALID_SIGNAL' });
  assert.equal(m.calls(), 0);
}));
test('semantic encoder invokes local CPU isolated interpreter without shell or inherited secrets', () => run('normal', async m => {
  assert.equal((await m.encoder.embed('synthetic')).length, 384);
  const { args, options } = m.observed();
  assert.equal(args[0], '-I'); assert.equal(args[1], '-B'); assert.equal(options.shell, false);
  assert.equal(options.env.CUDA_VISIBLE_DEVICES, '-1'); assert.equal(options.env.HF_HUB_OFFLINE, '1');
  assert.equal(Object.hasOwn(options.env, 'DEEPSEEK_API_KEY'), false);
  assert.equal(Object.hasOwn(options.env, 'OPENAI_API_KEY'), false);
  assert.equal(m.encoder.status().network, false);
}));
test('semantic encoder reuses resident worker', () => run('normal', async m => {
  await m.encoder.embed('first'); await m.encoder.embed('second');
  assert.equal(m.calls(), 1); assert.equal(m.encoder.status().completed, 2);
}));
test('semantic encoder rejects overlength rather than truncating', () => run('overlength', async m => {
  await assert.rejects(m.encoder.embed('synthetic'), { code: 'SEMANTIC_INPUT_TOO_LONG' });
  assert.equal(m.encoder.status().completed, 0);
}));
test('semantic encoder validates finite normalized dimensions', () => {
  assert.equal(validateEmbeddingVector(unit), unit);
  for (const vector of [[1], new Array(384).fill(0), new Array(384).fill(NaN), new Array(384).fill(Infinity)])
    assert.throws(() => validateEmbeddingVector(vector), { code: 'SEMANTIC_INVALID_VECTOR' });
});
test('semantic encoder malformed response terminates worker', () => run('invalid', async m => {
  await assert.rejects(m.encoder.embed('synthetic'), { code: 'SEMANTIC_INVALID_VECTOR' });
  assert.equal(m.kills(), 1);
}));
test('semantic encoder identity mismatch terminates worker', () => run('wrongId', async m => {
  await assert.rejects(m.encoder.embed('synthetic'), { code: 'SEMANTIC_INVALID_OUTPUT' });
  assert.equal(m.kills(), 1);
}));
test('semantic encoder pre-aborted input never spawns', () => run('normal', async m => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(m.encoder.embed('synthetic', { signal: abort.signal }), { code: 'SEMANTIC_CANCELLED' });
  assert.equal(m.calls(), 0);
}));
test('semantic encoder cancellation kills only owned worker and rejects queued jobs', () => run('silent', async m => {
  const abort = new AbortController();
  const first = m.encoder.embed('first', { signal: abort.signal }); const second = m.encoder.embed('second');
  const result = Promise.allSettled([first, second]); abort.abort();
  for (const item of await result) assert.equal(item.reason.code, 'SEMANTIC_CANCELLED');
  assert.equal(m.kills(), 1); assert.equal(m.encoder.status().pending, 0);
}));
test('semantic encoder queue is bounded', () => run('silent', async m => {
  const first = m.encoder.embed('first'); const result = Promise.allSettled([first]);
  await assert.rejects(m.encoder.embed('second'), { code: 'SEMANTIC_BUSY' });
  await m.encoder.close(); assert.equal((await result)[0].reason.code, 'SEMANTIC_ENCODER_CLOSED');
}, { maxQueue: 1 }));
test('semantic encoder request timeout kills worker', () => run('silent', async m => {
  await assert.rejects(m.encoder.embed('synthetic'), { code: 'SEMANTIC_TIMEOUT' }); assert.equal(m.kills(), 1);
}));
test('semantic encoder startup failure returns sanitized error and closes', () => run('spawnError', async m => {
  await assert.rejects(m.encoder.embed('synthetic'), { code: 'SEMANTIC_WORKER_START_FAILED' });
}));
test('semantic encoder close awaits worker exit and rejects future input', () => run('normal', async m => {
  await m.encoder.embed('synthetic'); await m.encoder.close();
  await assert.rejects(m.encoder.embed('after close'), { code: 'SEMANTIC_ENCODER_CLOSED' });
  assert.equal(m.encoder.status().state, 'closed'); assert.equal(m.kills(), 1);
}));
