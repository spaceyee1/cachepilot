import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';

// Test-only process guard. No claim of an OS-wide network firewall.
const allowed = host => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host).toLowerCase());
const counters = globalThis[Symbol.for('cachepilot.offline')] ??= { denied: 0 };
function denied() { counters.denied++; throw Object.assign(new Error('OFFLINE_EXTERNAL_NETWORK_DENIED'), { code: 'OFFLINE_EXTERNAL_NETWORK_DENIED' }); }
function target(args) {
  const first = args[0];
  if (typeof first === 'string' || first instanceof URL) {
    if (String(first).startsWith('\\\\.\\pipe\\')) return 'localhost';
    try { return new URL(first).hostname; } catch { return String(args[1] ?? first); }
  }
  if (first && typeof first === 'object') { if (first.path && !first.port) return 'localhost'; return first.hostname ?? first.host ?? 'localhost'; }
  return typeof args[1] === 'string' ? args[1] : 'localhost';
}
for (const mod of [http, https]) for (const method of ['request', 'get']) {
  const original = mod[method];
  mod[method] = function (...args) { if (!allowed(target(args))) return denied(); return original.apply(this, args); };
}
for (const method of ['connect', 'createConnection']) {
  const original = net[method];
  net[method] = function (...args) { if (!allowed(target(args))) return denied(); return original.apply(this, args); };
}
const oldLookup = dns.lookup;
dns.lookup = function (host, ...args) { if (!allowed(host)) return denied(); return oldLookup.call(this, host, ...args); };
const oldPromiseLookup = dnsPromises.lookup;
dnsPromises.lookup = async function (host, ...args) { if (!allowed(host)) return denied(); return oldPromiseLookup.call(this, host, ...args); };
const oldFetch = globalThis.fetch;
globalThis.fetch = function (input, init) { if (!allowed(new URL(typeof input === 'string' || input instanceof URL ? input : input.url).hostname)) return Promise.reject(Object.assign(new Error('OFFLINE_EXTERNAL_NETWORK_DENIED'), { code: 'OFFLINE_EXTERNAL_NETWORK_DENIED' })); return oldFetch(input, init); };
syncBuiltinESMExports();
