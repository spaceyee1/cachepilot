import { createHmac, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';

// Original bounded, process-local response cache. Similarity is a retrieval hint,
// never proof of equivalence. This module neither sends requests nor rewrites
// prompts, loads a model, records cloud usage, or persists queries/responses.
const PROTOCOLS = new Set(['openai-responses', 'openai-chat', 'deepseek-chat', 'anthropic-messages', 'gemini']);
const REQUEST_BYTES = 65_536;
const RESPONSE_BYTES = 1_048_576;
const QUERY_BYTES = 16_384;
const VECTOR_DIMENSIONS = 8_192;
const DANGEROUS_KEY = /^(?:__proto__|constructor|prototype)$/;
const TOOL_KEYS = new Set(['tool_calls', 'tool_call_id', 'function_call', 'functionCall', 'functionResponse', 'tool_use', 'tool_result']);
const TOOL_TYPES = new Set(['function_call', 'function_call_output', 'tool_use', 'tool_result', 'input_image', 'image', 'image_url', 'audio', 'input_audio', 'input_file', 'file', 'document', 'video', 'thinking', 'redacted_thinking']);
const TEXT_MARKER = Object.freeze({ semanticQuery: 'last_user_text_v1' });

function integer(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`Invalid semantic cache ${name}`);
  return value;
}
function finite(value, name, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new TypeError(`Invalid semantic cache ${name}`);
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

// Do not execute caller accessors, toJSON methods, or Proxy traps when accepting
// a response. Request objects are deliberately unsupported: the API adapter must
// first validate and serialize the untrusted native request.
function copyJson(value, depth = 0, state = { nodes: 0, bytes: 0 }) {
  if (++state.nodes > 20_000 || depth > 32) throw new TypeError('JSON complexity limit');
  if (typeof value === 'string') {
    state.bytes += Buffer.byteLength(value);
    if (state.bytes > RESPONSE_BYTES) throw new TypeError('JSON byte limit');
    return value;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || types.isProxy(value)) throw new TypeError('Plain JSON required');
  const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
  if ((array && proto !== Array.prototype) || (!array && proto !== Object.prototype && proto !== null)) throw new TypeError('Plain JSON required');
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError('JSON symbols rejected');
  const descriptors = Object.getOwnPropertyDescriptors(value), result = array ? [] : Object.create(null);
  if (array && value.length > 8_192) throw new TypeError('JSON array limit');
  if (array && Object.keys(descriptors).length !== value.length + 1) throw new TypeError('Dense JSON array required');
  for (const [key, d] of Object.entries(descriptors)) {
    if (array && key === 'length') continue;
    if (!('value' in d) || !d.enumerable || DANGEROUS_KEY.test(key) || key === 'toJSON') throw new TypeError('Unsafe JSON property');
    state.bytes += Buffer.byteLength(key);
    if (state.bytes > RESPONSE_BYTES) throw new TypeError('JSON byte limit');
    result[key] = copyJson(d.value, depth + 1, state);
  }
  return result;
}
function unsafeContent(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(unsafeContent);
  for (const [key, part] of Object.entries(value)) {
    if (TOOL_KEYS.has(key) || (key === 'type' && TOOL_TYPES.has(part)) ||
      (key === 'role' && part === 'tool') ||
      (key === 'refusal' && part !== null && part !== '') ||
      (key === 'type' && part === 'refusal')) return true;
    if (unsafeContent(part)) return true;
  }
  return false;
}
function textValue(content, allowedType) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.length !== 1) return null;
  const block = content[0];
  if (!block || block.type !== allowedType || typeof block.text !== 'string' || Object.keys(block).some(k => !['type', 'text'].includes(k))) return null;
  return block.text;
}
function requestParts(protocol, source) {
  if (!PROTOCOLS.has(protocol) || typeof source !== 'string' || Buffer.byteLength(source) > REQUEST_BYTES) return null;
  let body;
  try { body = copyJson(JSON.parse(source)); } catch { return null; }
  if (!body || Array.isArray(body) || typeof body !== 'object' || unsafeContent(body)) return null;
  if (body.stream === true || body.background === true || body.store === true) return null;
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length)) return null;
  if (body.tool_choice !== undefined || body.toolConfig !== undefined || body.parallel_tool_calls === true) return null;
  // An absent temperature is a provider default, not a deterministic setting.
  if ((protocol === 'gemini' ? body.generationConfig?.temperature : body.temperature) !== 0) return null;
  let text, last, replace;
  if (protocol === 'gemini') {
    if (!Array.isArray(body.contents) || !body.contents.length) return null;
    last = body.contents.at(-1);
    if (last?.role !== 'user' || !Array.isArray(last.parts) || last.parts.length !== 1 ||
      typeof last.parts[0]?.text !== 'string' || Object.keys(last.parts[0]).some(k => k !== 'text')) return null;
    text = last.parts[0].text;
    replace = () => { last.parts[0].text = TEXT_MARKER; };
  } else if (protocol === 'openai-responses') {
    if (body.store !== false) return null;
    if (typeof body.input === 'string') { text = body.input; replace = () => { body.input = TEXT_MARKER; }; }
    else {
      if (!Array.isArray(body.input) || !body.input.length) return null;
      last = body.input.at(-1);
      if (last?.role !== 'user') return null;
      text = textValue(last.content, 'input_text');
      replace = () => { if (typeof last.content === 'string') last.content = TEXT_MARKER; else last.content[0].text = TEXT_MARKER; };
    }
  } else {
    if (!Array.isArray(body.messages) || !body.messages.length) return null;
    last = body.messages.at(-1);
    if (last?.role !== 'user') return null;
    text = textValue(last.content, 'text');
    replace = () => { if (typeof last.content === 'string') last.content = TEXT_MARKER; else last.content[0].text = TEXT_MARKER; };
  }
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > QUERY_BYTES) return null;
  replace();
  return { text, envelope: canonical(body) };
}

// No literal is silently normalized or discarded. Risky text remains eligible
// for exact reuse, but is excluded from approximate response reuse. This costs
// hits deliberately: embeddings can blur a changed number, negation or unit.
function exactOnly(text) {
  // The available encoder is English-only. Do not infer multilingual quality
  // from a high cosine score; non-ASCII input remains exact-only in this build.
  if (/[^\x00-\x7F]/.test(text)) return true;
  return /[\p{N}`"'“”‘’「」『』«»<>≤≥=≠]|https?:\/\/|www\.|[\\/]|\b(?:not|no|never|cannot|unable|neither|nor|without|except|unless|avoid|omit|exclude|deny|denied|forbid|forbidden|prohibit|prohibited|disallow|disallowed|instead|only|must|all|any|some|each|every|few|several|both|either|none|single|double|zero|one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million|before|after|more|less|greater|smaller|equal|compare|versus|vs|increase|decrease|today|tomorrow|yesterday|latest|current)\b|不|没|無|无|非|否|勿|别|禁止|除外|除了|之前|之后|以前|以后|大于|小于|至少|至多|超过|低于|比较|相比|不同|更|最|今天|明天|昨天|现在|最新/iu.test(text);
}
function vectorCopy(value) {
  if (types.isProxy(value) || (!Array.isArray(value) && !(value instanceof Float32Array) && !(value instanceof Float64Array))) throw new TypeError('Invalid embedding vector');
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 2 || length > VECTOR_DIMENSIONS) throw new TypeError('Invalid embedding dimensions');
  const result = new Float64Array(length);
  let scale = 0;
  for (let i = 0; i < length; i++) {
    const descriptor = Array.isArray(value) ? Object.getOwnPropertyDescriptor(value, String(i)) : null;
    if (Array.isArray(value) && (!descriptor || !('value' in descriptor))) throw new TypeError('Invalid embedding member');
    const part = descriptor ? descriptor.value : value[i];
    if (typeof part !== 'number' || !Number.isFinite(part)) throw new TypeError('Invalid embedding member');
    scale = Math.max(scale, Math.abs(part)); result[i] = part;
  }
  if (scale === 0) throw new TypeError('Zero embedding');
  let squares = 0;
  for (let i = 0; i < length; i++) { result[i] /= scale; squares += result[i] * result[i]; }
  const norm = Math.sqrt(squares);
  if (!Number.isFinite(norm) || norm === 0) throw new TypeError('Invalid embedding norm');
  for (let i = 0; i < length; i++) result[i] /= norm;
  return result;
}
function cosine(a, b) {
  if (a.length !== b.length) return null;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return Math.max(-1, Math.min(1, sum));
}
function completedText(protocol, original) {
  let data;
  try { data = copyJson(original); } catch { return null; }
  if (!data || Array.isArray(data) || typeof data !== 'object' || unsafeContent(data) || data.error) return null;
  if (protocol === 'openai-chat' || protocol === 'deepseek-chat') {
    if (!Array.isArray(data.choices) || data.choices.length !== 1) return null;
    const choice = data.choices[0], message = choice?.message;
    if (choice?.finish_reason !== 'stop' || message?.role !== 'assistant' || typeof message.content !== 'string' || !message.content.trim()) return null;
    if (Object.keys(message).some(k => !['role', 'content', 'refusal', 'annotations'].includes(k)) ||
      (message.annotations !== undefined && (!Array.isArray(message.annotations) || message.annotations.length))) return null;
  } else if (protocol === 'openai-responses') {
    if (data.status !== 'completed' || data.incomplete_details || !Array.isArray(data.output) || data.output.length !== 1) return null;
    const message = data.output[0];
    if (message?.type !== 'message' || message.role !== 'assistant' || message.status !== 'completed' || !Array.isArray(message.content) || message.content.length !== 1) return null;
    const block = message.content[0];
    if (block?.type !== 'output_text' || typeof block.text !== 'string' || !block.text.trim() ||
      (block.annotations !== undefined && (!Array.isArray(block.annotations) || block.annotations.length))) return null;
  } else if (protocol === 'anthropic-messages') {
    if (data.type !== 'message' || data.role !== 'assistant' || data.stop_reason !== 'end_turn' || !Array.isArray(data.content) || data.content.length !== 1) return null;
    if (data.content[0]?.type !== 'text' || typeof data.content[0].text !== 'string' || !data.content[0].text.trim() || Object.keys(data.content[0]).some(k => !['type', 'text'].includes(k))) return null;
  } else if (protocol === 'gemini') {
    if (data.promptFeedback?.blockReason || !Array.isArray(data.candidates) || data.candidates.length !== 1) return null;
    const candidate = data.candidates[0], content = candidate?.content;
    if (candidate?.finishReason !== 'STOP' || content?.role !== 'model' || !Array.isArray(content.parts) || content.parts.length !== 1) return null;
    if (typeof content.parts[0]?.text !== 'string' || !content.parts[0].text.trim() || Object.keys(content.parts[0]).some(k => k !== 'text')) return null;
  } else return null;
  // A local hit did not perform the original provider request. Do not replay its
  // billing counters, request identity, or original creation timestamp as new.
  delete data.usage; delete data.usageMetadata; delete data.id; delete data.created;
  return data;
}

export class SemanticResponseCache {
  #embed; #encoderId; #threshold; #margin; #ttlMs; #maxEntries; #maxBytes; #maxPending; #timeout;
  #now; #salt = randomBytes(32); #entries = new Map(); #tickets = new Map(); #controllers = new Set();
  #bytes = 0; #pending = 0; #epoch = 0; #dimension = null; #ticketTtlMs; #ticketBytes = 0;
  #counters = { lookups: 0, exactHits: 0, semanticHits: 0, misses: 0, ineligible: 0, embeddingFailures: 0, busy: 0, ambiguous: 0, stored: 0, rejectedStores: 0, expired: 0, evicted: 0, cleared: 0, evictedTickets: 0 };
  constructor({ embed, encoderId, threshold = 0.97, margin = 0.02, ttlMs = 300_000, maxEntries = 128,
    maxBytes = 8_388_608, maxPending = 4, embedTimeoutMs = 5_000, ticketTtlMs = 120_000, semanticLanguage = 'en', now = () => performance.now() } = {}) {
    if (typeof embed !== 'function' || typeof encoderId !== 'string' || !encoderId.trim() || encoderId.length > 512 || typeof now !== 'function' || semanticLanguage !== 'en') throw new TypeError('Explicit supported local encoder required');
    this.#embed = embed; this.#encoderId = encoderId;
    this.#threshold = finite(threshold, 'threshold', 0.95, 1); this.#margin = finite(margin, 'margin', 0.001, 1);
    this.#ttlMs = integer(ttlMs, 'ttlMs', 1, 86_400_000); this.#maxEntries = integer(maxEntries, 'maxEntries', 1, 4_096);
    this.#maxBytes = integer(maxBytes, 'maxBytes', 512, 67_108_864); this.#maxPending = integer(maxPending, 'maxPending', 1, 16);
    this.#timeout = integer(embedTimeoutMs, 'embedTimeoutMs', 1, 30_000); this.#ticketTtlMs = integer(ticketTtlMs, 'ticketTtlMs', 1, 300_000);
    this.#now = now;
  }
  #digest(value) { return createHmac('sha256', this.#salt).update(value).digest('hex'); }
  #sweep(now) {
    for (const [key, entry] of this.#entries) if (now >= entry.expiresAt) {
      this.#entries.delete(key); this.#bytes -= entry.bytes; this.#counters.expired++;
    }
    for (const [ticket, entry] of this.#tickets) if (now - entry.issuedAt >= this.#ticketTtlMs) {
      this.#tickets.delete(ticket); this.#ticketBytes -= entry.ticketBytes;
    }
  }
  #touch(key, entry) { this.#entries.delete(key); this.#entries.set(key, entry); }
  #miss(reason, ticket, lookupEpoch = this.#epoch) { this.#counters.misses++; return { hit: false, reason, lookupEpoch, ...(ticket ? { ticket } : {}) }; }
  #ticket(data) {
    const ticketBytes = (data.vector?.byteLength ?? 0) + 256, limit = Math.min(this.#maxBytes, 2_097_152);
    if (ticketBytes > limit) return undefined;
    while (this.#tickets.size >= Math.min(this.#maxEntries, 32) || this.#ticketBytes + ticketBytes > limit) {
      const [old, entry] = this.#tickets.entries().next().value;
      this.#tickets.delete(old); this.#ticketBytes -= entry.ticketBytes; this.#counters.evictedTickets++;
    }
    const ticket = Object.freeze(Object.create(null)); this.#tickets.set(ticket, { ...data, ticketBytes }); this.#ticketBytes += ticketBytes; return ticket;
  }
  async #embedding(text, externalSignal) {
    if (this.#pending >= this.#maxPending) { this.#counters.busy++; return { error: 'embedding_busy' }; }
    const controller = new AbortController(); this.#controllers.add(controller); this.#pending++;
    let timer, externalAbort, localAbort;
    const task = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error('Embedding cancelled');
      const returned = this.#embed(text, { signal: controller.signal });
      // A synchronous Proxy must be rejected before Promise assimilation can
      // consult its then property. The injected encoder itself is trusted code.
      if (types.isProxy(returned)) throw new TypeError('Proxy embedding rejected');
      return returned;
    }).then(vectorCopy);
    // Keep an uncooperative encoder's concurrency slot occupied until its actual
    // promise settles. A timeout must not permit unlimited background work.
    task.then(() => { this.#pending--; this.#controllers.delete(controller); }, () => { this.#pending--; this.#controllers.delete(controller); });
    const aborted = new Promise(resolve => {
      localAbort = () => resolve({ error: externalSignal?.aborted ? 'cancelled' : 'embedding_cancelled' });
      controller.signal.addEventListener('abort', localAbort, { once: true });
      externalAbort = () => controller.abort();
      externalSignal?.addEventListener('abort', externalAbort, { once: true });
      if (externalSignal?.aborted) controller.abort();
      timer = setTimeout(() => { resolve({ error: 'embedding_timeout' }); controller.abort(); }, this.#timeout);
    });
    try { return await Promise.race([task.then(vector => ({ vector }), () => ({ error: 'embedding_failed' })), aborted]); }
    finally { clearTimeout(timer); externalSignal?.removeEventListener('abort', externalAbort); controller.signal.removeEventListener('abort', localAbort); }
  }
  async lookup({ scope, protocol, body, signal } = {}) {
    this.#counters.lookups++;
    if (signal?.aborted) return this.#miss('cancelled');
    if (typeof scope !== 'string' || !scope.trim() || scope.length > 4_096) { this.#counters.ineligible++; return this.#miss('scope_unverified'); }
    const parts = requestParts(protocol, body);
    if (!parts) { this.#counters.ineligible++; return this.#miss('request_ineligible'); }
    const epoch = this.#epoch, now = this.#now(); this.#sweep(now);
    const group = this.#digest(canonical([scope, protocol, this.#encoderId, parts.envelope]));
    const queryHash = this.#digest(parts.text), key = `${group}:${queryHash}`, exact = this.#entries.get(key);
    if (exact) {
      this.#touch(key, exact); this.#counters.exactHits++;
      return { hit: true, lookupEpoch: epoch, match: 'exact', similarity: 1, reason: 'local_exact_response', response: JSON.parse(exact.responseJson) };
    }
    const limited = exactOnly(parts.text);
    if (limited) {
      // Literal-guarded / unsupported-language inputs cannot participate in
      // approximate retrieval, so do not start an encoder merely to cache them.
      return this.#miss('literal_guard_exact_only', this.#ticket({ group, queryHash, key, vector: null,
        exactOnly: true, epoch, issuedAt: now, protocol }));
    }
    const embedded = await this.#embedding(parts.text, signal);
    if (signal?.aborted || epoch !== this.#epoch) return this.#miss(signal?.aborted ? 'cancelled' : 'cache_cleared', undefined, epoch);
    if (embedded.error) { this.#counters.embeddingFailures++; return this.#miss(embedded.error); }
    const vector = embedded.vector;
    if (this.#dimension !== null && vector.length !== this.#dimension) { this.#counters.embeddingFailures++; return this.#miss('embedding_dimension_changed'); }
    this.#dimension ??= vector.length;
    const completedAt = this.#now(); this.#sweep(completedAt);
    let best = null, second = -Infinity;
    for (const [entryKey, entry] of this.#entries) {
      if (entry.group !== group || entry.exactOnly) continue;
      const score = cosine(vector, entry.vector);
      if (score === null) continue;
      if (!best || score > best.score) { if (best) second = best.score; best = { entryKey, entry, score }; }
      else if (score > second) second = score;
    }
    let reason = 'no_semantic_match';
    if (best && best.score >= this.#threshold) {
      if (best.score - second >= this.#margin) {
        this.#touch(best.entryKey, best.entry); this.#counters.semanticHits++;
        // Never create a new entry/ticket from a hit: no transitive aliases.
        return { hit: true, lookupEpoch: epoch, match: 'semantic', similarity: best.score, reason: 'local_semantic_response', response: JSON.parse(best.entry.responseJson) };
      }
      reason = 'ambiguous_neighbours'; this.#counters.ambiguous++;
    }
    return this.#miss(reason, this.#ticket({ group, queryHash, key, vector, exactOnly: limited, epoch, issuedAt: completedAt, protocol }));
  }
  async store(ticket, response, { signal } = {}) {
    const data = ticket && typeof ticket === 'object' ? this.#tickets.get(ticket) : null;
    if (data) { this.#tickets.delete(ticket); this.#ticketBytes -= data.ticketBytes; }
    const now = this.#now();
    if (!data || signal?.aborted || data.epoch !== this.#epoch || now - data.issuedAt >= this.#ticketTtlMs || now < data.issuedAt) { this.#counters.rejectedStores++; return false; }
    const clean = completedText(data.protocol, response);
    if (!clean) { this.#counters.rejectedStores++; return false; }
    const responseJson = JSON.stringify(clean), bytes = Buffer.byteLength(responseJson) + (data.vector?.byteLength ?? 0) + 256;
    if (bytes > this.#maxBytes || Buffer.byteLength(responseJson) > RESPONSE_BYTES) { this.#counters.rejectedStores++; return false; }
    this.#sweep(now);
    const old = this.#entries.get(data.key);
    if (old) { this.#entries.delete(data.key); this.#bytes -= old.bytes; }
    while (this.#entries.size >= this.#maxEntries || this.#bytes + bytes > this.#maxBytes) {
      const [key, entry] = this.#entries.entries().next().value;
      this.#entries.delete(key); this.#bytes -= entry.bytes; this.#counters.evicted++;
    }
    this.#entries.set(data.key, { ...data, vector: data.vector?.slice() ?? null, responseJson, bytes, expiresAt: now + this.#ttlMs });
    this.#bytes += bytes; this.#counters.stored++; return true;
  }
  clear() {
    this.#epoch++; this.#entries.clear(); this.#tickets.clear(); this.#bytes = 0; this.#ticketBytes = 0; this.#counters.cleared++;
    for (const controller of this.#controllers) controller.abort();
  }
  status() {
    this.#sweep(this.#now());
    return { mode: 'local_semantic_response_cache', encoderId: this.#encoderId, device: 'cpu', persistent: false, epoch: this.#epoch,
      semanticLanguage: 'en', nonEnglishPolicy: 'exact_only',
      providerCacheMeasured: false, optimizationGainMeasured: false, semanticEquivalenceGuaranteed: false,
      statisticsScope: 'this_process_local_response_reuse_only', ...this.#counters,
      entries: this.#entries.size, bytes: this.#bytes, maxEntries: this.#maxEntries, maxBytes: this.#maxBytes,
      pendingTickets: this.#tickets.size, ticketBytes: this.#ticketBytes, maxPendingTickets: Math.min(this.#maxEntries, 32), maxTicketBytes: Math.min(this.#maxBytes, 2_097_152),
      pendingEmbeddings: this.#pending, maxPendingEmbeddings: this.#maxPending, embeddingTimeoutMs: this.#timeout,
      threshold: this.#threshold, ambiguityMargin: this.#margin, ttlMs: this.#ttlMs };
  }
}

export const createSemanticCache = options => new SemanticResponseCache(options);
