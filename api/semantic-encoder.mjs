import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = fileURLToPath(new URL('../scripts/semantic_embed.py', import.meta.url));
const MAX_LINE = 96 * 1024;
const ALGORITHM = 'bert-mean-l2-v1';
const KEY_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json',
  'sentence_bert_config.json', '1_Pooling/config.json', 'model.safetensors'];
const failure = code => Object.assign(new Error(code), { code });

function localFile(value, directory = false) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.startsWith('\\\\') || value.startsWith('//'))
    throw failure('SEMANTIC_LOCAL_PATH_REQUIRED');
  const resolved = realpathSync(value);
  if (resolved.startsWith('\\\\') || resolved.startsWith('//')) throw failure('SEMANTIC_LOCAL_PATH_REQUIRED');
  if (directory ? !statSync(resolved).isDirectory() : !statSync(resolved).isFile())
    throw failure('SEMANTIC_LOCAL_PATH_REQUIRED');
  return resolved;
}

export function validateEmbeddingVector(value, dimensions = 384) {
  if (!Array.isArray(value) || value.length !== dimensions || dimensions < 1 || dimensions > 4096 ||
      value.some(number => typeof number !== 'number' || !Number.isFinite(number)))
    throw failure('SEMANTIC_INVALID_VECTOR');
  const norm = Math.hypot(...value);
  if (norm < 0.999 || norm > 1.001) throw failure('SEMANTIC_INVALID_VECTOR');
  return value;
}

/** Local CPU encoder. Cancellation terminates this worker and rejects its queued jobs. */
export function createLocalSemanticEncoder(config, { spawnChild = spawn } = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      (config.gpu !== undefined && config.gpu !== false) ||
      (config.device !== undefined && config.device !== 'cpu') || config.baseUrl)
    throw failure('SEMANTIC_LOCAL_CPU_ONLY');
  const pythonPath = localFile(config.pythonPath);
  const modelPath = localFile(config.modelPath, true);
  const fingerprint = createHash('sha256').update(ALGORITHM).update('\0');
  for (const name of KEY_FILES) {
    const candidate = path.join(modelPath, name);
    if (!existsSync(candidate) || lstatSync(candidate).isSymbolicLink()) throw failure('SEMANTIC_MODEL_INCOMPLETE');
    const actual = realpathSync(candidate);
    if (!actual.startsWith(modelPath + path.sep) || !statSync(actual).isFile()) throw failure('SEMANTIC_MODEL_PATH_REJECTED');
    if (statSync(actual).size > (name === 'model.safetensors' ? 256 * 1024 * 1024 : 4 * 1024 * 1024))
      throw failure('SEMANTIC_MODEL_SIZE_LIMIT');
    fingerprint.update(name).update('\0');
    const descriptor = openSync(actual, 'r');
    try {
      const chunk = Buffer.allocUnsafe(1024 * 1024); let count;
      while ((count = readSync(descriptor, chunk, 0, chunk.length, null)) > 0) fingerprint.update(chunk.subarray(0, count));
    } finally { closeSync(descriptor); }
  }
  const id = `minilm-cpu-${ALGORITHM}-sha256:${fingerprint.digest('hex')}`;
  const timeoutMs = Math.min(120000, Math.max(500, Number(config.timeoutMs) || 60000));
  const maxQueue = Math.floor(Math.min(16, Math.max(1, Number(config.maxQueue) || 4)));
  let child = null, ready = null, state = 'idle', closed = false, nextId = 0, buffer = '';
  let readyResolve, readyReject, readyTimer, startup = null;
  let completed = 0, failures = 0, lastError = null, stderrBytes = 0, workerPid = null;
  const jobs = new Map();
  const children = new Set();

  function settle(job, error, value) {
    if (!jobs.delete(job.id)) return;
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.abort);
    if (error) { failures++; lastError = error.code; job.reject(error); }
    else { completed++; job.resolve(value); }
  }
  function stop(code = 'SEMANTIC_WORKER_STOPPED') {
    const previous = child;
    child = null; workerPid = null;
    clearTimeout(readyTimer);
    readyReject?.(failure(code)); readyResolve = readyReject = null;
    ready = startup = null; buffer = '';
    state = closed ? 'closed' : 'idle';
    for (const job of [...jobs.values()]) settle(job, failure(code));
    if (previous && !previous.killed) previous.kill();
  }
  function accept(line, source) {
    if (source !== child) return;
    let frame;
    try { frame = JSON.parse(line); } catch { stop('SEMANTIC_INVALID_OUTPUT'); return; }
    if (frame?.type === 'ready') {
      if (ready || frame.id !== id || frame.dimensions !== 384 || frame.device !== 'cpu' || frame.network !== false ||
          frame.parameterDevice !== 'cpu' || frame.torchCudaInitialized !== false) {
        stop('SEMANTIC_INVALID_OUTPUT'); return;
      }
      ready = { dimensions: 384, maxTokens: frame.maxTokens, parameterDevice: frame.parameterDevice,
        torchCudaInitialized: frame.torchCudaInitialized };
      state = 'ready'; clearTimeout(readyTimer); readyResolve?.(); readyResolve = readyReject = null;
      return;
    }
    const job = jobs.get(frame?.requestId);
    if (!job) { stop('SEMANTIC_INVALID_OUTPUT'); return; }
    if (frame.error) {
      const allowed = new Set(['SEMANTIC_INPUT_TOO_LONG', 'SEMANTIC_INVALID_INPUT', 'SEMANTIC_INFERENCE_FAILED']);
      settle(job, failure(allowed.has(frame.error) ? frame.error : 'SEMANTIC_INFERENCE_FAILED'));
      return;
    }
    try {
      if (!ready || frame.id !== id) throw failure('SEMANTIC_INVALID_OUTPUT');
      const vector = validateEmbeddingVector(frame.vector, ready.dimensions);
      settle(job, null, vector);
    } catch (error) { stop(error.code || 'SEMANTIC_INVALID_OUTPUT'); }
  }
  function ensureWorker() {
    if (startup) return startup;
    state = 'starting';
    startup = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const promise = startup;
    try {
      const env = {};
      for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC']) if (process.env[name]) env[name] = process.env[name];
      Object.assign(env, { CUDA_VISIBLE_DEVICES: '-1', HIP_VISIBLE_DEVICES: '-1',
        HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1',
        HF_HUB_DISABLE_PROGRESS_BARS: '1', TOKENIZERS_PARALLELISM: 'false',
        PYTHONDONTWRITEBYTECODE: '1', OMP_NUM_THREADS: '2', MKL_NUM_THREADS: '2',
        NO_PROXY: '*', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '' });
      const current = spawnChild(pythonPath, ['-I', '-B', RUNNER, '--model', modelPath, '--identity', id],
        { shell: false, windowsHide: true, cwd: path.dirname(RUNNER), env, stdio: ['pipe', 'pipe', 'pipe'] });
      child = current; workerPid = current.pid || null;
      children.add(current);
      current.stdout.on('data', bytes => {
        if (current !== child) return;
        buffer += bytes.toString('utf8');
        if (Buffer.byteLength(buffer) > MAX_LINE) { stop('SEMANTIC_OUTPUT_LIMIT'); return; }
        let end;
        while ((end = buffer.indexOf('\n')) !== -1 && current === child) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); accept(line, current);
        }
      });
      current.stderr.on('data', bytes => { stderrBytes = Math.min(8193, stderrBytes + bytes.length); });
      current.stdin.on('error', () => { if (child === current) stop('SEMANTIC_WORKER_IO'); });
      current.on('error', () => { children.delete(current); if (child === current) stop('SEMANTIC_WORKER_START_FAILED'); });
      current.on('exit', () => { children.delete(current); if (child === current) stop('SEMANTIC_WORKER_EXITED'); });
      readyTimer = setTimeout(() => stop('SEMANTIC_START_TIMEOUT'), timeoutMs);
    } catch { stop('SEMANTIC_WORKER_START_FAILED'); }
    return promise;
  }
  return {
    id,
    embed(text, { signal } = {}) {
      if (closed) return Promise.reject(failure('SEMANTIC_ENCODER_CLOSED'));
      if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 12 * 1024)
        return Promise.reject(failure('SEMANTIC_INVALID_INPUT'));
      if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function' ||
          typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean'))
        return Promise.reject(failure('SEMANTIC_INVALID_SIGNAL'));
      if (signal?.aborted) return Promise.reject(failure('SEMANTIC_CANCELLED'));
      if (jobs.size >= maxQueue) return Promise.reject(failure('SEMANTIC_BUSY'));
      return new Promise((resolve, reject) => {
        const job = { id: ++nextId, resolve, reject, signal, timer: null, abort: null };
        jobs.set(job.id, job);
        job.abort = () => { if (jobs.has(job.id)) stop('SEMANTIC_CANCELLED'); };
        signal?.addEventListener('abort', job.abort, { once: true });
        if (signal?.aborted) { job.abort(); return; }
        job.timer = setTimeout(() => stop('SEMANTIC_TIMEOUT'), timeoutMs);
        ensureWorker().then(() => {
          if (jobs.has(job.id) && child) child.stdin.write(JSON.stringify({ requestId: job.id, text }) + '\n');
        }, error => settle(job, error));
      });
    },
    async close() {
      closed = true; stop('SEMANTIC_ENCODER_CLOSED');
      await Promise.all([...children].map(current => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(failure('SEMANTIC_WORKER_CLOSE_TIMEOUT')), 3000);
        current.once('exit', () => { clearTimeout(timer); resolve(); });
      })));
    },
    status() { return { id, state, device: 'cpu', gpu: false, network: false, language: 'en',
      policyScope: 'semantic-encoder-only', parameterDevice: ready?.parameterDevice || null,
      torchCudaInitialized: ready?.torchCudaInitialized ?? null,
      dimensions: ready?.dimensions || 384, pending: jobs.size, completed, failures, lastError,
      workerPid, stderrPresent: stderrBytes > 0, stderrTruncated: stderrBytes > 8192 }; },
  };
}
