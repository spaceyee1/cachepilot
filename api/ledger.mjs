import { createHash } from 'node:crypto';
import { ApiError } from './errors.mjs';

const integer = n => Number.isSafeInteger(n) && n >= 0;
function add(a, b) { if (!integer(a) || !integer(b) || !integer(a + b)) throw new ApiError('API_COUNTER_LIMIT'); return a + b; }
export function scopeFor(profile) {
  return createHash('sha256').update(JSON.stringify([profile.id, profile.protocol, profile.baseUrl, profile.model, profile.credentialGeneration])).digest('hex');
}
export class ApiLedger {
  #scopes = new Map();
  #source;
  constructor({ source = 'interface_reported' } = {}) {
    if (!['interface_reported', 'offline_fixture'].includes(source)) throw new ApiError('API_SOURCE_REJECTED');
    this.#source = source;
  }
  #row(profile) {
    const scopeId = scopeFor(profile);
    if (!this.#scopes.has(scopeId)) {
      if (this.#scopes.size >= 16) throw new ApiError('API_SCOPE_LIMIT');
      this.#scopes.set(scopeId, { scopeId, profileId: profile.id, protocol: profile.protocol,
        requests: 0, reportedRequests: 0, inputTokens: 0, cacheObservedInputTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, unknownUsageRequests: 0, source: this.#source });
    }
    return this.#scopes.get(scopeId);
  }
  attempted(profile) { const row = this.#row(profile); row.requests = add(row.requests, 1); }
  completed(profile, usage) {
    const row = this.#row(profile);
    // Each completion is committed once by ApiRuntime, never from successive snapshots.
    const next = { ...row };
    if (integer(usage?.inputTokens)) next.inputTokens = add(next.inputTokens, usage.inputTokens);
    if (integer(usage?.outputTokens)) next.outputTokens = add(next.outputTokens, usage.outputTokens);
    // A reported cache write remains useful even when this record cannot supply
    // a complete cache-read denominator. It never counts as a read or a hit.
    if (integer(usage?.cacheWriteTokens)) next.cacheWriteTokens = add(next.cacheWriteTokens, usage.cacheWriteTokens);
    if (integer(usage?.inputTokens) && integer(usage?.cachedInputTokens)
        && usage.cachedInputTokens <= usage.inputTokens) {
      next.reportedRequests = add(next.reportedRequests, 1);
      next.cacheObservedInputTokens = add(next.cacheObservedInputTokens, usage.inputTokens);
      next.cacheReadTokens = add(next.cacheReadTokens, usage.cachedInputTokens);
    } else next.unknownUsageRequests = add(next.unknownUsageRequests, 1);
    this.#scopes.set(row.scopeId, next);
  }
  failed(profile) { const row = this.#row(profile); row.unknownUsageRequests = add(row.unknownUsageRequests, 1); }
  scopes() { return [...this.#scopes.values()].map(v => ({ ...v })); }
  snapshot() {
    return this.scopes().map(row => ({ ...row,
      cacheUsageFieldsReported: row.reportedRequests > 0,
      providerCacheMeasured: row.reportedRequests > 0 && row.cacheObservedInputTokens > 0,
      cacheHitRate: row.cacheObservedInputTokens > 0 ? row.cacheReadTokens / row.cacheObservedInputTokens : null,
      reportingCoverage: row.requests > 0 ? row.reportedRequests / row.requests : null,
      identityStatus: 'unverified', includesHostUsage: false, optimizationGainMeasured: false }));
  }
}
