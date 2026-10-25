import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { API_VERSION } from './version.mjs';

export function apiPipeName(home = os.homedir()) {
  const normalized = path.resolve(home).replace(/\\+$/, '').toLowerCase();
  return '\\\\.\\pipe\\cachepilot-api-monitor-v1-' + createHash('sha256').update(normalized).digest('hex').slice(0, 20);
}
export function startApiPublisher(ledger, { pipe = apiPipeName(), enabled = process.platform === 'win32' } = {}) {
  const processSession = randomBytes(16).toString('hex');
  let sequence = 0, socket = null, closed = false;
  const tick = () => {
    if (closed || socket || !enabled) return;
    const frame = { schema: 3, kind: 'api', pid: process.pid, version: API_VERSION, processSession,
      sequence: ++sequence, createdAt: Date.now(), device: 'off', scopes: ledger.scopes() };
    const data = JSON.stringify(frame) + '\n';
    if (Buffer.byteLength(data) >= 16384) return;
    const connection = net.createConnection(pipe); socket = connection;
    const cleanup = () => { if (socket === connection) socket = null; };
    connection.on('error', () => {}); connection.once('close', cleanup);
    connection.setTimeout(750, () => connection.destroy());
    // The receiving Windows pipe closes after reading LF. Keep our side open
    // until then: immediate end() can race WaitForConnectionAsync on Windows.
    connection.once('connect', () => connection.write(data));
  };
  const timer = enabled ? setInterval(tick, 1000) : null;
  timer?.unref(); tick();
  return { close() { closed = true; clearInterval(timer); socket?.destroy(); socket = null; } };
}
