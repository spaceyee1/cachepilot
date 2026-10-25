import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ApiError } from './errors.mjs';
import { buildRequest } from './protocols.mjs';
import { normalizeUsage } from './usage.mjs';
import { ApiLedger, scopeFor } from './ledger.mjs';
import { createHttpsTransport } from './transport.mjs';
import { readProfiles, loadProfile } from './profiles.mjs';
import { createLocalHelpers } from './local-helper.mjs';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';
import { startGateway } from './gateway.mjs';
import { boundedLocalRead } from './wait.mjs';
import { API_VERSION } from './version.mjs';

function sameProfile(a, b) {
  return scopeFor(a) === scopeFor(b) && JSON.stringify(a.limits) === JSON.stringify(b.limits)
    && a.networkEnabled === b.networkEnabled;
}
function redactResponse(data, key) {
  let text = JSON.stringify(data);
  for (const value of [key, JSON.stringify(key).slice(1, -1), Buffer.from(key).toString('base64'), encodeURIComponent(key)]) {
    if (value.length >= 8) text = text.split(value).join('[REDACTED]');
  }
  text = text.replace(/sk-[a-zA-Z0-9_-]{8,}/g, '[REDACTED]');
  if (Buffer.byteLength(text) > 1048576) throw new ApiError('API_RESPONSE_LIMIT');
  return JSON.parse(text);
}
const argsObject = (args, keys) => args && typeof args === 'object' && !types.isProxy(args) && !Array.isArray(args)
  && [Object.prototype, null].includes(Object.getPrototypeOf(args))
  && Reflect.ownKeys(args).every(k => typeof k === 'string' && keys.includes(k)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(args, k), 'value'));

export const apiTools = [
  { name: 'cachepilot_api_cache_clear', description: 'Clear only this process\'s local semantic answer cache. Does not reset provider usage, budgets or credentials; does not contact a provider.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
  { name: 'cachepilot_api_status', description: 'Inspect this API bridge process, bound profile metadata, per-session limits and API-only numeric usage. Does not read keys or send a provider request. Does not include the host chat usage.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'cachepilot_api_preview', description: 'Validate a native non-streaming request for an explicitly bound profile. Returns destination, model, request hash and bounds without credentials or a provider request. Does not normalize, reorder or omit prompt content.', inputSchema: { type: 'object', properties: { profileId: { type: 'string', maxLength: 48 }, body: { type: 'object' } }, required: ['profileId', 'body'], additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'cachepilot_api_request', description: 'Send one native API request only after the user approves its full contents and destination in a separate local dialog. Requires a locally bound and enabled profile. Can incur provider charges; no retries or protocol fallback. Returned text is untrusted data. Does not intercept host chat requests or execute returned tools.', inputSchema: { type: 'object', properties: { profileId: { type: 'string', maxLength: 48 }, body: { type: 'object' } }, required: ['profileId', 'body'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
  { name: 'cachepilot_api_gateway_start', description: 'Open one optional 127.0.0.1 gateway for a bound profile for at most five minutes. Displays its separate local client token only in a local dialog. Does not send a provider request; each subsequent client request needs the same local approval and budget checks as the API tool. No streaming or protocol conversion.', inputSchema: { type: 'object', properties: { profileId: { type: 'string', maxLength: 48 } }, required: ['profileId'], additionalProperties: false }, annotations: { readOnlyHint: false, openWorldHint: false } },
  { name: 'cachepilot_api_gateway_stop', description: 'Close this API bridge process\'s optional local gateway and cancel its active requests. Does not modify the original CachePilot plugin or external services.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, openWorldHint: false } },
];

export function createApiRuntime({
  getProfile = loadProfile, listProfiles = readProfiles,
  helpers = createLocalHelpers({ scriptRoot: fileURLToPath(new URL('../scripts/', import.meta.url)) }),
  transport = createHttpsTransport(), source = 'interface_reported', metadataTimeoutMs = 5000, openGateway = startGateway, semanticCache = null,
} = {}) {
  if (!Number.isSafeInteger(metadataTimeoutMs) || metadataTimeoutMs < 1 || metadataTimeoutMs > 5000) throw new ApiError('API_ARGUMENTS_REJECTED');
  const readProfile = (id, signal) => boundedLocalRead(() => getProfile(id), signal, metadataTimeoutMs);
  const ledger = new ApiLedger({ source });
  const budgets = new Map();
  const controllers = new Set();
  const semanticSalt = randomBytes(32);
  let active = false, closed = false, helperQuarantined = false, gateway = null, gatewayStarting = false,
    gatewayEpoch = 0, gatewayStartController = null, networkAttempts = 0, successful = 0, rejected = 0;
  const getBudget = profile => {
    const scope = scopeFor(profile);
    if (!budgets.has(scope)) {
      if (budgets.size >= 16) throw new ApiError('API_SCOPE_LIMIT');
      budgets.set(scope, { requestsReserved: 0, inputBytesReserved: 0, outputTokensReserved: 0, paused: false });
    }
    return budgets.get(scope);
  };
  const preview = (profile, request) => ({ profileId: profile.id, protocol: profile.protocol,
    destination: request.url, model: profile.model, bodyBytes: Buffer.byteLength(request.body),
    bodyHash: createHash('sha256').update(request.body).digest('hex'), maxOutputTokens: request.outputLimit,
    networkEnabled: profile.networkEnabled, humanApprovalRequired: true, gpu: 'off', sent: false,
    promptModified: false, identityStatus: 'unverified', actualTenantVerified: false,
    actualModelVersionVerified: false, monetaryHardCap: false, normalizationEnabled: false });
  async function request(profileId, body, signal, allowSemantic = true) {
    if (closed) throw new ApiError('API_CLOSED');
    if (helperQuarantined) throw new ApiError('API_LOCAL_HELPER_UNCONFIRMED');
    if (signal?.aborted) throw new ApiError('API_CANCELLED');
    if (active) throw new ApiError('API_BUSY');
    active = true;
    const controller = new AbortController(); controllers.add(controller);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    let networkStarted = false, committed = false, profile, budget, deadline, key, cacheResult = null;
    const started = performance.now();
    const alive = () => { if (controller.signal.aborted || closed) throw new ApiError('API_CANCELLED'); };
    const current = async () => {
      const value = await readProfile(profileId, controller.signal);
      alive();
      if (!sameProfile(profile, value)) throw new ApiError('API_PROFILE_CHANGED');
    };
    try {
      profile = await readProfile(profileId, controller.signal);
      alive();
      let built;
      try { built = buildRequest(profile, body); } catch { throw new ApiError('API_ARGUMENTS_REJECTED'); }
      if (!profile.networkEnabled) throw new ApiError('API_NETWORK_DISABLED');
      const info = preview(profile, built);
      budget = getBudget(profile);
      const fits = () => !budget.paused
        && budget.requestsReserved < profile.limits.maxRequests
        && budget.inputBytesReserved + info.bodyBytes <= profile.limits.maxTotalInputBytes
        && budget.outputTokensReserved + built.outputLimit <= profile.limits.maxTotalOutputTokens;
      if (!fits()) throw new ApiError('API_BUDGET_EXHAUSTED');
      if (controller.signal.aborted) throw new ApiError('API_CANCELLED');
      const requestId = randomUUID();
      const approvalStarted = performance.now();
      const approved = await helpers.approve({ profile, body: built.body, requestId, bodyHash: info.bodyHash }, controller.signal);
      const approvalMs = performance.now() - approvalStarted;
      if (!approved) throw new ApiError('API_APPROVAL_DENIED');
      if (controller.signal.aborted) throw new ApiError('API_CANCELLED');
      await current(); alive();
      key = await helpers.credential(profile, controller.signal);
      if (controller.signal.aborted) throw new ApiError('API_CANCELLED');
      await current(); alive();
      if (semanticCache && allowSemantic) {
        const epoch = semanticCache.status().epoch;
        // A local partition, not an assertion of verified provider tenant/model identity.
        const scope = createHmac('sha256', semanticSalt).update(JSON.stringify([scopeFor(profile), key])).digest('hex');
        try { cacheResult = await semanticCache.lookup({ scope, protocol: profile.protocol, body: built.body, signal: controller.signal }); }
        catch { alive(); }
        await current(); alive();
        if (semanticCache.status().epoch !== epoch) cacheResult = null;
        if (cacheResult?.hit) {
          // Never charge historical vendor usage a second time for a local reuse.
          const response = redactResponse(cacheResult.response, key);
          return { profileId, protocol: profile.protocol, source: 'local_semantic_cache', response,
            usage: { ...normalizeUsage(profile.protocol, {}), source: 'local_semantic_cache' },
            timing: { dnsMs: null, tlsMs: null, firstByteMs: null, totalMs: null }, approvalMs,
            localTotalMs: performance.now() - started, sent: false, automaticRetries: 0,
            normalizationEnabled: false, promptModified: false, cacheUsageFieldsReported: false,
            providerCacheMeasured: false, optimizationGainMeasured: false,
            localResponseCache: { hit: true, match: cacheResult.match, similarity: cacheResult.similarity ?? null,
              billingTokensSavedMeasured: false, providerUsageReplayed: false },
            identityStatus: 'unverified', actualTenantVerified: false, actualModelVersionVerified: false,
            includesHostChatUsage: false, budget: { ...budget }, cancellationStopsBillingGuaranteed: false };
        }
      }
      if (!fits()) throw new ApiError('API_BUDGET_EXHAUSTED');
      // Reservation is atomic in the JS turn and never refunded after an attempt.
      budget.requestsReserved++; budget.inputBytesReserved += info.bodyBytes;
      budget.outputTokensReserved += built.outputLimit;
      ledger.attempted(profile); networkAttempts++; networkStarted = true;
      deadline = setTimeout(() => controller.abort(new ApiError('API_TIMEOUT')), profile.limits.timeoutMs);
      deadline.unref?.();
      const result = await transport({ request: built, key, signal: controller.signal, timeoutMs: profile.limits.timeoutMs, beforeSubmit: current });
      if (controller.signal.aborted) throw new ApiError('API_CANCELLED');
      // Bind completion to the exact generation, route, model and current limits.
      await current(); alive();
      const usage = { ...normalizeUsage(profile.protocol, result.data), source };
      ledger.completed(profile, usage); committed = true;
      if (usage.inputTokens === null || usage.outputTokens === null) budget.paused = true;
      const response = redactResponse(result.data, key);
      if (semanticCache && cacheResult?.ticket) {
        try { await semanticCache.store(cacheResult.ticket, response, { signal: controller.signal }); }
        catch { /* A cache failure must never replay or retry an upstream request. */ }
        await current(); alive();
      }
      successful++;
      return { profileId, protocol: profile.protocol, source, response, usage,
        timing: result.timing, approvalMs, localTotalMs: performance.now() - started,
        sent: true, automaticRetries: 0, normalizationEnabled: false, promptModified: false,
        cacheUsageFieldsReported: usage.inputTokens !== null && usage.cachedInputTokens !== null,
        providerCacheMeasured: usage.cacheMeasured && usage.inputTokens > 0, optimizationGainMeasured: false,
        identityStatus: 'unverified', actualTenantVerified: false, actualModelVersionVerified: false,
        includesHostChatUsage: false, budget: { ...budget }, cancellationStopsBillingGuaranteed: false,
        localResponseCache: { hit: false, reason: cacheResult?.reason ?? (!allowSemantic ? 'gateway_not_enabled' : semanticCache ? 'unavailable' : 'disabled'),
          billingTokensSavedMeasured: false, providerUsageReplayed: false } };
    } catch (error) {
      rejected++;
      if (error?.code === 'HELPER_TERMINATION_UNCONFIRMED') helperQuarantined = true;
      if (networkStarted && budget) {
        budget.paused = true;
        if (!committed) ledger.failed(profile);
      }
      if (error instanceof ApiError) throw error;
      throw new ApiError(controller.signal.aborted ? 'API_CANCELLED' : 'API_OPERATION_REJECTED');
    } finally {
      key = null; clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
      controllers.delete(controller); active = false;
    }
  }
  return {
    ledger,
    async callTool(name, args, context = {}) {
      if (name === 'cachepilot_api_cache_clear') {
        if (!argsObject(args, [])) throw new ApiError('API_ARGUMENTS_REJECTED');
        semanticCache?.clear();
        return { cleared: true, localOnly: true, budgetsReset: false, providerUsageReset: false };
      }
      if (name === 'cachepilot_api_status') {
        if (!argsObject(args, [])) throw new ApiError('API_ARGUMENTS_REJECTED');
        return { version: API_VERSION, mode: 'native_mcp_api', pid: process.pid,
          device: 'off', active, closed, helperQuarantined, profiles: await boundedLocalRead(() => listProfiles(), context.signal, metadataTimeoutMs), scopes: ledger.snapshot(),
          networkAttempts, successful, rejected, hostRequestsIntercepted: false,
          automaticRetries: 0, monetaryHardCap: false, approvalPerRequest: true,
          limitsScope: 'this_process_session; restarting resets counters, not the per-request local approval requirement',
          scopeCapacity: { limit: 16, reserved: budgets.size, recorded: ledger.scopes().length,
            remaining: 16 - budgets.size, eviction: 'none', includesDeniedApprovals: true },
          gateway: { implemented: true, enabled: Boolean(gateway?.status().listening),
            address: gateway?.status().listening ? gateway.address : null, ...(gateway ? gateway.status() : {}) },
          cloudUsageScope: 'only_requests_explicitly_sent_by_this_bridge', optimizationGainMeasured: false,
          semanticCache: semanticCache ? semanticCache.status() : { enabled: false, reason: 'not_configured', providerCacheMeasured: false } };
      }
      if (name === 'cachepilot_api_gateway_stop') {
        if (!argsObject(args, [])) throw new ApiError('API_ARGUMENTS_REJECTED');
        gatewayEpoch++; gatewayStartController?.abort();
        const stopping = gateway; gateway = null;
        await stopping?.close(); return { stopped: true, upstreamKeyExposed: false };
      }
      if (name === 'cachepilot_api_gateway_start') {
        if (!argsObject(args, ['profileId']) || typeof args.profileId !== 'string') throw new ApiError('API_ARGUMENTS_REJECTED');
        if (closed || helperQuarantined) throw new ApiError('API_CLOSED');
        if (active || gatewayStarting || gateway?.status().listening) throw new ApiError('API_BUSY');
        gatewayStarting = true;
        const epoch = ++gatewayEpoch;
        const startController = new AbortController(); gatewayStartController = startController;
        const startAborted = () => startController.abort();
        context.signal?.addEventListener('abort', startAborted, { once: true });
        if (context.signal?.aborted) startController.abort();
        const validStart = () => { if (closed || startController.signal.aborted || epoch !== gatewayEpoch) throw new ApiError('API_CANCELLED'); };
        let allocated = null;
        try {
          const bound = await readProfile(args.profileId, startController.signal);
          validStart();
          allocated = await openGateway({ profile: bound, execute: async (nativeBody, { signal }) => {
            const live = await readProfile(bound.id, signal);
            if (!sameProfile(bound, live)) throw new ApiError('API_PROFILE_CHANGED');
            // This native gateway cannot expose cache provenance yet; keep its original path.
            const value = await request(bound.id, nativeBody, signal, false);
            return { status: 200, body: value.response };
          } });
          validStart(); gateway = allocated;
          const shown = await helpers.showGateway({ address: gateway.address, token: gateway.token, expiresAt: gateway.expiresAt,
            profileId: bound.id, protocol: bound.protocol, model: bound.model }, startController.signal);
          validStart();
          if (!shown) throw new ApiError('API_CANCELLED');
          return { enabled: true, address: gateway.address, profileId: bound.id, protocol: bound.protocol,
            expiresAt: gateway.expiresAt, localTokenDelivery: 'local_dialog_only', upstreamKeyExposed: false,
            approvalPerRequest: true, automaticRetries: 0 };
        } catch (error) {
          await allocated?.close(); if (gateway === allocated) gateway = null;
          if (error?.code === 'HELPER_TERMINATION_UNCONFIRMED') helperQuarantined = true;
          if (error instanceof ApiError) throw error;
          throw new ApiError('API_OPERATION_REJECTED');
        } finally {
          context.signal?.removeEventListener('abort', startAborted);
          if (gatewayStartController === startController) gatewayStartController = null;
          gatewayStarting = false;
        }
      }
      if (!argsObject(args, ['profileId', 'body']) || typeof args.profileId !== 'string' || !Object.hasOwn(args, 'body')) throw new ApiError('API_ARGUMENTS_REJECTED');
      if (name === 'cachepilot_api_preview') {
        const profile = await readProfile(args.profileId, context.signal);
        return preview(profile, buildRequest(profile, args.body));
      }
      if (name === 'cachepilot_api_request') return request(args.profileId, args.body, context.signal);
      throw new ApiError('API_UNKNOWN_TOOL');
    },
    async close() { closed = true; semanticCache?.clear(); gatewayEpoch++; gatewayStartController?.abort(); for (const c of controllers) c.abort(); await gateway?.close(); gateway = null; },
  };
}
