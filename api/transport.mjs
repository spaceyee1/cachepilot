import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { ApiError } from './errors.mjs';

// Resolve once, validate every returned address, then pin the chosen address.
// No HTTP proxy environment variables, redirects, retries, or fallback origins.
export function publicAddress(address) {
  if (isIP(address) === 4) {
    const p = address.split('.').map(Number);
    return !(p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224
      || (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
      || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
      || (p[0] === 192 && (p[1] === 168 || p[1] === 0 || p[1] === 2))
      || (p[0] === 198 && (p[1] === 18 || p[1] === 19 || (p[1] === 51 && p[2] === 100)))
      || (p[0] === 203 && p[1] === 0 && p[2] === 113));
  }
  if (isIP(address) === 6) {
    const a = address.toLowerCase();
    // Deliberately conservative: global unicast only; no transition tunnels.
    return /^[23][0-9a-f]{0,3}:/.test(a) && !a.startsWith('2001:') && !a.startsWith('2002:') && !a.includes('.');
  }
  return false;
}

export function validateEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new ApiError('API_ENDPOINT_REJECTED'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || (url.port && url.port !== '443') || isIP(host.replace(/^\[|\]$/g, ''))
      || host.endsWith('.') || !host.includes('.') || host.length > 253
      || !host.split('.').every(p => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p))
      || /(?:^|\.)(localhost|local|internal|test|invalid|example)$/.test(host)
      || /%|\\|\/\//.test(url.pathname)) throw new ApiError('API_ENDPOINT_REJECTED');
  return url;
}

export function createHttpsTransport({ resolve = lookup, requestImpl = https.request } = {}) {
  return async function send({ request, key, signal, maxResponseBytes = 1048576, timeoutMs = 30000, beforeSubmit = async () => {} }) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new ApiError('API_TIMEOUT_LIMIT');
    if (signal?.aborted) throw new ApiError('API_CANCELLED');
    signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
    const cancelled = () => new ApiError(signal.reason?.name === 'TimeoutError' || signal.reason?.code === 'API_TIMEOUT' ? 'API_TIMEOUT' : 'API_CANCELLED');
    const url = validateEndpoint(request.url);
    if (typeof key !== 'string' || key.length < 8 || key.length > 4096 || /[\r\n\0]/.test(key)) throw new ApiError('API_CREDENTIAL_REJECTED');
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 2097152) throw new ApiError('API_RESPONSE_LIMIT');
    const started = performance.now();
    let addresses;
    // An aborted resolver cannot submit a request later: its result is discarded.
    let dnsAbort;
    const dnsCancelled = new Promise((_, reject) => {
      dnsAbort = () => reject(cancelled());
      signal?.addEventListener('abort', dnsAbort, { once: true });
    });
    try { addresses = await Promise.race([resolve(url.hostname, { all: true, verbatim: true }), dnsCancelled]); }
    catch { throw signal?.aborted ? cancelled() : new ApiError('API_DNS_REJECTED'); }
    finally { signal?.removeEventListener('abort', dnsAbort); }
    if (signal?.aborted) throw cancelled();
    if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32 || addresses.some(a => !publicAddress(a.address) || isIP(a.address) !== a.family)) throw new ApiError('API_DNS_REJECTED');
    const chosen = addresses.find(a => a.family === 4) ?? addresses[0];
    const timing = { dnsMs: performance.now() - started, tlsMs: null, firstByteMs: null, headersMs: null, totalMs: null };
    // A local identity recheck may itself be waiting on filesystem I/O. Do not
    // keep the transport slot pending after cancellation while awaiting it.
    // The race installs handlers on both branches, so a late resolve/reject can
    // neither submit a request nor become an unhandled rejection.
    let submitAbort;
    const submitCancelled = new Promise((_, reject) => {
      submitAbort = () => reject(cancelled());
      signal.addEventListener('abort', submitAbort, { once: true });
      if (signal.aborted) submitAbort();
    });
    try {
      await Promise.race([
        Promise.resolve().then(() => { if (signal.aborted) throw cancelled(); return beforeSubmit(); }),
        submitCancelled,
      ]);
    } finally { signal.removeEventListener('abort', submitAbort); }
    if (signal.aborted) throw cancelled();
    return new Promise((resolveResult, rejectResult) => {
      let settled = false, req, response, timer, socketStarted;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
        if (error) { response?.destroy(); if (req && !req.destroyed) req.destroy(); rejectResult(error); }
        else resolveResult(value);
      };
      const onAbort = () => finish(cancelled());
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      timer = setTimeout(() => finish(new ApiError('API_TIMEOUT')), timeoutMs);
      timer.unref?.();
      try {
        req = requestImpl(url, {
          method: 'POST', agent: false, rejectUnauthorized: true, servername: url.hostname,
          lookup: (_host, options, callback) => {
            if (options?.all) callback(null, [chosen]);
            else callback(null, chosen.address, chosen.family);
          },
          headers: { ...request.headers, [request.authHeader.name]: request.authHeader.prefix + key,
            'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Encoding': 'identity',
            'Content-Length': Buffer.byteLength(request.body) },
        }, res => {
          if (settled) { res.destroy(); return; }
          response = res; timing.headersMs = performance.now() - started;
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) { finish(new ApiError('API_REDIRECT_REFUSED')); return; }
          if (status < 200 || status >= 300) { finish(new ApiError(status === 401 || status === 403 ? 'API_AUTH_REJECTED' : status === 429 ? 'API_RATE_LIMITED' : 'API_UPSTREAM_REJECTED')); return; }
          if (!/^application\/json(?:;|$)/i.test(res.headers['content-type'] ?? '') || ![undefined, 'identity'].includes(res.headers['content-encoding'])) { finish(new ApiError('API_RESPONSE_FORMAT')); return; }
          if (Number(res.headers['content-length']) > maxResponseBytes) { finish(new ApiError('API_RESPONSE_LIMIT')); return; }
          const chunks = []; let size = 0;
          res.on('data', chunk => {
            if (settled) return;
            if (timing.firstByteMs === null) timing.firstByteMs = performance.now() - started;
            size += chunk.length;
            if (size > maxResponseBytes) { finish(new ApiError('API_RESPONSE_LIMIT')); return; }
            chunks.push(chunk);
          });
          res.once('aborted', () => finish(new ApiError('API_RESPONSE_INCOMPLETE')));
          res.once('error', () => finish(new ApiError('API_RESPONSE_INCOMPLETE')));
          res.once('end', () => {
            if (settled) return;
            try {
              const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
              if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error();
              timing.totalMs = performance.now() - started;
              finish(null, { data, status, timing });
            } catch { finish(new ApiError('API_RESPONSE_FORMAT')); }
          });
        });
        req.once('error', () => finish(new ApiError(signal?.aborted ? 'API_CANCELLED' : 'API_TRANSPORT_FAILED')));
        req.once('socket', socket => {
          socketStarted = performance.now();
          socket.once('secureConnect', () => {
            if (socket.authorized !== true) { finish(new ApiError('API_TLS_REJECTED')); return; }
            timing.tlsMs = performance.now() - socketStarted;
          });
        });
        if (!settled) req.end(request.body);
      } catch { finish(new ApiError('API_TRANSPORT_FAILED')); }
    });
  };
}
