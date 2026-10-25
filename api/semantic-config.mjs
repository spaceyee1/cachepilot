import { readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SemanticResponseCache } from './semantic-cache.mjs';
import { createLocalSemanticEncoder } from './semantic-encoder.mjs';

const DEFAULT_PATH = fileURLToPath(new URL('../semantic-settings.json', import.meta.url));
const KEYS = ['enabled', 'device', 'pythonPath', 'modelPath', 'threshold', 'margin', 'ttlMs', 'maxEntries', 'maxBytes', 'timeoutMs', 'maxQueue'];

// Startup-only local settings; never supplied by a prompt or MCP argument.
export async function loadSemanticConfiguration(file = DEFAULT_PATH) {
  let encoder = null;
  try {
    if (typeof file !== 'string' || !path.isAbsolute(file) || /^(?:\\\\|\/\/)/.test(file)) throw Error();
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) throw Error();
    // A canonical final path prevents accepting a replaced leaf through a link.
    if (path.resolve(await realpath(file)).toLowerCase() !== path.resolve(file).toLowerCase()) throw Error();
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !KEYS.includes(key)) || typeof value.enabled !== 'boolean') throw Error();
    if (!value.enabled) return { cache: null, encoder: null, state: 'disabled' };
    if (value.device !== 'cpu' || typeof value.pythonPath !== 'string' || typeof value.modelPath !== 'string') throw Error();
    for (const [key, low, high] of [['threshold', 0.95, 1], ['margin', 0.001, 0.2],
      ['ttlMs', 1000, 300000], ['maxEntries', 1, 256], ['maxBytes', 1024, 16777216],
      ['timeoutMs', 500, 120000], ['maxQueue', 1, 4]]) {
      if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < low || value[key] > high
          || (!['threshold', 'margin'].includes(key) && !Number.isSafeInteger(value[key]))) throw Error();
    }
    encoder = createLocalSemanticEncoder(value);
    const cache = new SemanticResponseCache({ embed: encoder.embed, encoderId: encoder.id,
      threshold: value.threshold, margin: value.margin, ttlMs: value.ttlMs,
      maxEntries: value.maxEntries, maxBytes: value.maxBytes, embedTimeoutMs: 30000, semanticLanguage: 'en' });
    return { cache, encoder, state: 'configured_local_cpu' };
  } catch {
    await encoder?.close();
    return { cache: null, encoder: null, state: 'unavailable_or_invalid_local_settings' };
  }
}
