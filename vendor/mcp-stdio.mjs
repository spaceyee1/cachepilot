import { TextDecoder } from 'node:util';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const requestId = value => typeof value === 'string' || Number.isSafeInteger(value);
const metadataOnly = value => value === undefined || (object(value)
  && Object.keys(value).every(key => key === '_meta')
  && (!own(value, '_meta') || object(value._meta)));

/** Newline-delimited MCP stdio. Business tools return JSON data, never protocol frames. */
export function serveStdio({
  tools, callTool, close = () => {}, name = 'cachepilot', version = '0.5.0',
  errorMessages = {},
  input = process.stdin, output = process.stdout, errorOutput = process.stderr,
  installSignalHandlers = true,
  maxFrameBytes = 2 * 1024 * 1024, maxPendingRequests = 16,
  maxOutputBytes = 8 * 1024 * 1024, maxQueuedResponses = 128,
} = {}) {
  if ((!Array.isArray(tools) && typeof tools !== 'function') || typeof callTool !== 'function') {
    throw new TypeError('MCP requires tools and callTool');
  }
  if (!object(errorMessages) || Object.values(errorMessages).some(value => typeof value !== 'string')) throw new TypeError('Invalid safe error definitions');
  for (const limit of [maxFrameBytes, maxPendingRequests, maxOutputBytes, maxQueuedResponses]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Invalid MCP resource limit');
  }

  let lifecycle = 'new';
  let stopping = false;
  let partial = Buffer.allocUnsafe(maxFrameBytes);
  let partialLength = 0;
  let canWrite = true;
  let queuedBytes = 0;
  const queue = [];
  const pending = new Map();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let complete;
  const closed = new Promise(resolve => { complete = resolve; });

  const diagnostic = () => {
    // Never include input, exception messages, paths, credentials, or tool arguments.
    try { errorOutput?.write('CachePilot MCP transport closed safely.\n'); } catch {}
  };

  function shutdown() {
    if (stopping) return closed;
    stopping = true;
    input.off('data', onData);
    input.off('end', onEnd);
    input.off('close', onEnd);
    input.off('error', onError);
    output.off('drain', onDrain);
    // Keep the error listener until cleanup finishes, including errors from a pending write.
    input.pause();
    partial = null;
    partialLength = 0;
    queue.length = 0;
    queuedBytes = 0;
    for (const ticket of pending.values()) {
      ticket.finished = true;
      ticket.controller.abort();
    }
    pending.clear();
    if (installSignalHandlers) {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
    }
    Promise.resolve().then(close).catch(diagnostic).finally(() => {
      output.off('error', onError);
      complete();
    });
    return closed;
  }

  function onError() { diagnostic(); void shutdown(); }
  function onSignal() { void shutdown(); }
  function onEnd() { void shutdown(); }
  function onDrain() { canWrite = true; flush(); }

  function flush() {
    while (!stopping && canWrite && queue.length) {
      const frame = queue.shift();
      queuedBytes -= frame.length;
      try { canWrite = output.write(frame); } catch { onError(); }
    }
  }

  function send(message) {
    if (stopping) return;
    let frame;
    try { frame = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8'); } catch { onError(); return; }
    if (frame.length + queuedBytes + (output.writableLength || 0) > maxOutputBytes
      || queue.length >= maxQueuedResponses) {
      onError();
      return;
    }
    queue.push(frame);
    queuedBytes += frame.length;
    flush();
  }

  function failure(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }
  function finish(ticket, result, error) {
    if (ticket.finished || stopping) return;
    ticket.finished = true;
    // A cancellation completes the protocol reply, not necessarily the work.
    // Keep its admission slot until handle() settles if a dependency ignores abort.
    if (!ticket.cancelled) pending.delete(ticket.id);
    if (error) failure(ticket.id, error.code, error.message);
    else send({ jsonrpc: '2.0', id: ticket.id, result });
  }
  function rejectedTool(error) {
    const code = typeof error?.code === 'string' && own(errorMessages, error.code) ? error.code : 'LOCAL_OPERATION_REJECTED';
    const value = { error: { code, message: own(errorMessages, code) ? errorMessages[code] : 'Local operation rejected' } };
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: true };
  }
  function invalidParams(ticket) { finish(ticket, null, { code: -32602, message: 'Invalid params' }); }

  async function handle(ticket, method, params) {
    try {
      if (method === 'ping') {
        if (!metadataOnly(params)) {
          invalidParams(ticket); return;
        }
        finish(ticket, {}); return;
      }
      if (method === 'initialize') {
        if (!object(params) || typeof params.protocolVersion !== 'string' || !params.protocolVersion
          || !object(params.capabilities) || !object(params.clientInfo)
          || typeof params.clientInfo.name !== 'string' || !params.clientInfo.name
          || typeof params.clientInfo.version !== 'string'
          || (own(params, '_meta') && !object(params._meta))) {
          invalidParams(ticket); return;
        }
        if (lifecycle !== 'new') {
          finish(ticket, null, { code: -32600, message: 'Already initialized' }); return;
        }
        lifecycle = 'initializing';
        finish(ticket, {
          protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
          capabilities: { tools: {} }, serverInfo: { name, version },
        });
        return;
      }
      if (!['tools/list', 'tools/call', 'resources/list', 'resources/templates/list'].includes(method)) {
        finish(ticket, null, { code: -32601, message: 'Method not found' }); return;
      }
      if (lifecycle !== 'ready') {
        finish(ticket, null, { code: -32002, message: 'Server not initialized' }); return;
      }
      // Some hosts query empty resource catalogs even for a tools-only server.
      if (method === 'resources/list' || method === 'resources/templates/list') {
        if (!metadataOnly(params)) { invalidParams(ticket); return; }
        finish(ticket, method === 'resources/list' ? { resources: [] } : { resourceTemplates: [] });
        return;
      }
      if (method === 'tools/list') {
        if (!metadataOnly(params)) {
          invalidParams(ticket); return;
        }
        const definitions = typeof tools === 'function' ? await tools() : tools;
        if (!Array.isArray(definitions) || definitions.some(tool => !object(tool)
          || typeof tool.name !== 'string' || !tool.name || !object(tool.inputSchema))) {
          throw new Error('Invalid tool definitions');
        }
        finish(ticket, { tools: definitions }); return;
      }
      if (!object(params) || typeof params.name !== 'string' || !params.name
        || (own(params, 'arguments') && !object(params.arguments))
        || (own(params, '_meta') && !object(params._meta))
        || Object.keys(params).some(key => !['name', 'arguments', '_meta'].includes(key))) {
        invalidParams(ticket); return;
      }
      const definitions = typeof tools === 'function' ? await tools() : tools;
      if (!Array.isArray(definitions) || !definitions.some(tool => tool?.name === params.name)) {
        finish(ticket, null, { code: -32602, message: 'Unknown tool' }); return;
      }
      if (ticket.finished || stopping) return;
      try {
        const data = await callTool(params.name, params.arguments ?? {}, { signal: ticket.controller.signal });
        if (ticket.finished || stopping) return;
        const value = object(data) ? data : { result: data ?? null };
        // Round-trip once so text and structuredContent always contain the same JSON value.
        const serialized = JSON.stringify(value);
        const structuredContent = JSON.parse(serialized);
        if (!object(structuredContent)) throw new Error('Invalid tool result');
        const result = { content: [{ type: 'text', text: serialized }], structuredContent, isError: false };
        // A valid input can expand in JSON and in the two MCP result surfaces.
        // Reject that result without dropping the host connection or its caches.
        if (Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: ticket.id, result }) + '\n') > maxOutputBytes) {
          const value = { error: { code: 'MCP_RESULT_TOO_LARGE', message: 'Tool result exceeds the output limit. Use a smaller context budget or input.' } };
          finish(ticket, { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: true });
        } else finish(ticket, result);
      } catch (error) { finish(ticket, rejectedTool(error)); }
    } catch { finish(ticket, null, { code: -32603, message: 'Internal error' }); }
    finally { if (pending.get(ticket.id) === ticket) pending.delete(ticket.id); }
  }

  function receive(line) {
    let message;
    try { message = JSON.parse(decoder.decode(line)); } catch {
      failure(null, -32700, 'Parse error'); return;
    }
    const notification = object(message) && message.jsonrpc === '2.0'
      && typeof message.method === 'string' && !own(message, 'id');
    const valid = object(message) && message.jsonrpc === '2.0'
      && typeof message.method === 'string' && message.method.length > 0
      && (!own(message, 'id') || requestId(message.id))
      && (!own(message, 'params') || object(message.params))
      && Object.keys(message).every(key => ['jsonrpc', 'id', 'method', 'params'].includes(key));
    if (!valid) {
      if (!notification) failure(object(message) && requestId(message.id) ? message.id : null, -32600, 'Invalid Request');
      return;
    }
    if (notification) {
      const params = message.params;
      if (message.method === 'notifications/initialized' && lifecycle === 'initializing'
        && metadataOnly(params)) lifecycle = 'ready';
      if (message.method === 'notifications/cancelled' && object(params) && requestId(params.requestId)
        && (!own(params, 'reason') || typeof params.reason === 'string')
        && (!own(params, '_meta') || object(params._meta))
        && Object.keys(params).every(key => ['requestId', 'reason', '_meta'].includes(key))) {
        const ticket = pending.get(params.requestId);
        if (ticket) {
          ticket.cancelled = true;
          ticket.controller.abort();
          finish(ticket, null, { code: -32800, message: 'Request cancelled' });
        }
      }
      return;
    }
    if (pending.has(message.id)) { failure(message.id, -32600, 'Duplicate request id'); return; }
    if (pending.size >= maxPendingRequests) { failure(message.id, -32000, 'Server busy'); return; }
    const ticket = { id: message.id, controller: new AbortController(), finished: false };
    pending.set(ticket.id, ticket);
    void handle(ticket, message.method, message.params);
  }

  function onData(chunk) {
    if (stopping) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    let start = 0;
    while (start < bytes.length && !stopping) {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline;
      const length = end - start;
      if (partialLength + length > maxFrameBytes) {
        failure(null, -32600, 'Frame too large');
        diagnostic(); void shutdown(); return;
      }
      const segment = bytes.subarray(start, end);
      if (newline < 0) {
        segment.copy(partial, partialLength);
        partialLength += segment.length;
        return;
      }
      let frame = segment;
      if (partialLength) {
        segment.copy(partial, partialLength);
        frame = partial.subarray(0, partialLength + segment.length);
      }
      partialLength = 0;
      if (frame.length) receive(frame);
      start = end + 1;
    }
  }

  input.on('data', onData);
  input.on('end', onEnd);
  input.on('close', onEnd);
  input.on('error', onError);
  output.on('drain', onDrain);
  output.on('error', onError);
  if (installSignalHandlers) {
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
  }
  return { closed, shutdown };
}
