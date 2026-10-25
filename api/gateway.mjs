import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const PROTOCOL_ROUTES = Object.freeze({ 'openai-responses': '/v1/responses', 'openai-chat': '/v1/chat/completions', 'deepseek-chat': '/v1/chat/completions', 'anthropic-messages': '/v1/messages' });
function fault(code) { const error = new Error(code); error.code = code; return error; }
function nativeRoute(profile) {
  if (profile.protocol === 'gemini' && typeof profile.model === 'string' && profile.model.length <= 160) return `/v1beta/models/${encodeURIComponent(profile.model)}:generateContent`;
  const route = PROTOCOL_ROUTES[profile.protocol]; if (!route) throw fault('INVALID_GATEWAY_PROFILE'); return route;
}
function safeError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const mapping = {
    API_APPROVAL_DENIED: [403, 'approval_denied'],
    API_NETWORK_DISABLED: [403, 'network_disabled'],
    API_BUDGET_EXHAUSTED: [429, 'budget_exhausted'],
    API_CANCELLED: [499, 'request_aborted'],
    API_BUSY: [429, 'local_concurrency_limit'],
    API_TIMEOUT: [504, 'request_timeout'],
    API_PROFILE_CHANGED: [409, 'profile_changed'],
    API_LOCAL_HELPER_UNCONFIRMED: [503, 'local_helper_unconfirmed'],
    // These codes originate inside this transport's bounded body reader.
    INPUT_LIMIT: [413, 'input_limit'],
    REQUEST_ABORTED: [499, 'request_aborted'],
    REQUEST_TIMEOUT: [408, 'request_timeout'],
    INVALID_JSON: [400, 'invalid_json']
  };
  if (code === 'API_ARGUMENTS_REJECTED') return [400, 'invalid_request'];
  return mapping[code] ?? [502, 'request_failed'];
}
/** Optional local transport only. execute is the sole provider path and must enforce approval and budgets. */
export async function startGateway({ profile, execute, port = 0, ttlMs = 300000 } = {}) {
  if (!profile || typeof profile !== 'object' || typeof execute !== 'function' || !Number.isSafeInteger(port) || port < 0 || port > 65535 || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300000 || !Number.isSafeInteger(profile.limits?.maxInputBytes) || profile.limits.maxInputBytes < 1 || profile.limits.maxInputBytes > 65536) throw fault('INVALID_GATEWAY_CONFIGURATION');
  const route = nativeRoute(profile);
  const token = randomBytes(32).toString('base64url'); const expectedBearer = Buffer.from(`Bearer ${token}`);
  const sockets = new Set(), cleanupTimers = new Map(), contexts = new Set(), halfClosed = new WeakSet();
  let host, address, ttlTimer, closingPromise, closed = false, active = 0, accepted = 0, completed = 0, rejected = 0, aborted = 0;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const authenticate = authorization => {
    if (typeof authorization !== 'string' || authorization.length !== expectedBearer.length) return false;
    const actual = Buffer.from(authorization, 'utf8'); return actual.length === expectedBearer.length && timingSafeEqual(actual, expectedBearer);
  };
  const cleanupSocket = socket => { const timer = cleanupTimers.get(socket); if (timer) clearTimeout(timer); cleanupTimers.delete(socket); sockets.delete(socket); };
  const halfCloseAndExpire = socket => {
    if (socket.destroyed || halfClosed.has(socket)) return socket;
    halfClosed.add(socket);
    // end's callback runs after queued bytes have flushed; do not destroy sooner.
    socket.end(() => {
      if (socket.destroyed) return;
      const timer = setTimeout(() => { cleanupTimers.delete(socket); if (!socket.destroyed) socket.destroy(); }, 250);
      cleanupTimers.set(socket, timer);
    });
    return socket;
  };
  // Flush the complete response before half-closing. A 250ms timer is a cleanup target,
  // not a real-time guarantee when the event loop is blocked.
  const respond = (req, res, status, value) => {
    if (res.destroyed || res.writableEnded || !res.socket || res.socket.destroyed) return;
    const socket = res.socket;
    let json;
    try { json = JSON.stringify(value); } catch { status = 502; json = '{"error":{"code":"request_failed"}}'; }
    if (typeof json !== 'string' || Buffer.byteLength(json) > 1048576) { status = 502; json = '{"error":{"code":"response_limit"}}'; }
    res.shouldKeepAlive = false;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json), 'connection': 'close', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    let drained = 0;
    const drain = chunk => { drained += chunk.length; if (drained > 65536) req.pause(); };
    req.on('data', drain);
    req.once('close', () => req.removeListener('data', drain));
    res.once('finish', () => halfCloseAndExpire(socket));
    res.end(json);
    req.resume();
  };
  const rejectRequest = (req, res, status, code) => { rejected++; respond(req, res, status, { error: { code } }); };
  async function bodyText(req, signal) {
    return new Promise((resolve, reject) => {
      let settled = false, size = 0, chunks = [];
      const finish = (error, value) => {
        if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', onAbort);
        req.removeListener('data', onData); req.removeListener('end', onEnd); req.removeListener('aborted', onAborted); req.removeListener('error', onError);
        if (error) reject(fault(error)); else resolve(value); chunks = [];
      };
      const onData = chunk => { size += chunk.length; if (size > profile.limits.maxInputBytes) { req.pause(); return finish('INPUT_LIMIT'); } chunks.push(Buffer.from(chunk)); };
      const onEnd = () => { let text; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)); const parsed = JSON.parse(text); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error(); } catch { return finish('INVALID_JSON'); } finish(null, text); };
      const onAbort = () => finish('REQUEST_ABORTED');
      const onAborted = () => finish('REQUEST_ABORTED');
      const onError = () => finish('REQUEST_ABORTED');
      const timer = setTimeout(() => finish('REQUEST_TIMEOUT'), Math.min(10000, profile.limits.timeoutMs || 10000));
      req.on('data', onData); req.once('end', onEnd); req.once('aborted', onAborted); req.once('error', onError);
      if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort();
    });
  }
  const server = http.createServer({ maxHeaderSize: 8192, insecureHTTPParser: false }, (req, res) => {
    const socket = req.socket;
    req.on('error', () => {}); res.on('error', () => {});
    const rawNames = req.rawHeaders.filter((_, index) => index % 2 === 0).map(name => name.toLowerCase());
    if (closed) return rejectRequest(req, res, 503, 'gateway_closed');
    if (Object.hasOwn(req.headers, 'origin')) return rejectRequest(req, res, 403, 'origin_rejected');
    if (req.headers.host !== host || rawNames.filter(name => name === 'host').length !== 1) return rejectRequest(req, res, 400, 'host_rejected');
    if (rawNames.filter(name => name === 'authorization').length !== 1 || !authenticate(req.headers.authorization)) return rejectRequest(req, res, 401, 'local_auth_required');
    if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.includes('?') || req.url.includes('#')) return rejectRequest(req, res, 400, 'url_rejected');
    if (req.method === 'GET' && req.url === '/v1/models') {
      if (req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) return rejectRequest(req, res, 400, 'body_rejected');
      return respond(req, res, 200, { object: 'list', data: [{ id: profile.model, object: 'model', owned_by: 'configured-profile' }] });
    }
    if (req.method !== 'POST') return rejectRequest(req, res, 405, 'method_rejected');
    if (req.url !== route) return rejectRequest(req, res, 404, 'route_rejected');
    if (req.headers['content-encoding'] || rawNames.filter(name => name === 'content-type').length !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) return rejectRequest(req, res, req.headers['content-encoding'] ? 415 : 415, 'encoding_or_type_rejected');
    if (req.headers.expect) return rejectRequest(req, res, 417, 'expect_rejected');
    if (active >= 1) return rejectRequest(req, res, 429, 'local_concurrency_limit');
    if (req.headers['content-length'] && (!/^\d+$/.test(req.headers['content-length']) || Number(req.headers['content-length']) > profile.limits.maxInputBytes)) return rejectRequest(req, res, 413, 'input_limit');
    const controller = new AbortController(); const context = { controller, released: false }; contexts.add(context); active++; accepted++;
    const onDisconnect = () => { if (!controller.signal.aborted && !context.released) { aborted++; controller.abort(); } };
    socket.once('close', onDisconnect); req.once('aborted', onDisconnect);
    const release = () => { if (context.released) return; context.released = true; active--; contexts.delete(context); socket.removeListener('close', onDisconnect); req.removeListener('aborted', onDisconnect); };
    void (async () => {
      try {
        const body = await bodyText(req, controller.signal);
        // Pass the original UTF-8 JSON text: execute must reject duplicate fields without silent JSON.parse loss.
        const result = await execute(body, { signal: controller.signal });
        if (controller.signal.aborted || socket.destroyed) return;
        const status = Number.isInteger(result?.status) && result.status >= 200 && result.status <= 599 ? result.status : 200;
        respond(req, res, status, result && Object.hasOwn(result, 'body') ? result.body : result);
        completed++;
      } catch (error) {
        const [status, code] = safeError(error);
        if (!socket.destroyed && !controller.signal.aborted) rejectRequest(req, res, status, code);
      } finally { release(); }
    })();
  });
  server.headersTimeout = 5000; server.requestTimeout = 0; server.keepAliveTimeout = 1; server.maxRequestsPerSocket = 1; server.maxConnections = 32;
  server.on('connection', socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => cleanupSocket(socket));
    // Node's default destroySoon destroys a socket immediately after response writes,
    // producing a Windows RST when an oversized request upload is still unread.
    // This socket belongs only to this gateway; defer that destruction until after FIN.
    socket.destroySoon = () => halfCloseAndExpire(socket);
  });
  server.on('clientError', (_error, socket) => { if (!socket.destroyed && !halfClosed.has(socket)) { socket.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); halfCloseAndExpire(socket); } });
  server.on('checkContinue', (req, res) => rejectRequest(req, res, 417, 'expect_rejected'));
  const close = () => {
    if (closingPromise) return closingPromise;
    closed = true; clearTimeout(ttlTimer);
    for (const context of contexts) { if (!context.controller.signal.aborted) { aborted++; context.controller.abort(); } }
    for (const timer of cleanupTimers.values()) clearTimeout(timer); cleanupTimers.clear();
    for (const socket of sockets) socket.destroy();
    closingPromise = new Promise(resolve => { server.close(() => resolve()); }); return closingPromise;
  };
  await new Promise((resolve, reject) => { const onError = () => { server.removeListener('listening', onListening); reject(fault('GATEWAY_LISTEN_FAILED')); }; const onListening = () => { server.removeListener('error', onError); resolve(); }; server.once('error', onError); server.once('listening', onListening); server.listen({ host: '127.0.0.1', port, exclusive: true }); });
  const bound = server.address(); host = `127.0.0.1:${bound.port}`; address = `http://${host}`;
  // Keep a persistent error handler after startup, with no raw error output.
  server.on('error', () => { void close(); });
  ttlTimer = setTimeout(() => { void close(); }, ttlMs);
  return Object.freeze({ address, token, expiresAt, status: () => Object.freeze({ listening: server.listening, connections: sockets.size, active, accepted, completed, rejected, aborted, cleanupTimers: cleanupTimers.size, expiresAt }), close });
}
