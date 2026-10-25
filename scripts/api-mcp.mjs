import { serveStdio } from '../vendor/mcp-stdio.mjs';
import { assertSupportedNode } from '../vendor/runtime-policy.mjs';
import { apiTools, createApiRuntime } from '../api/runtime.mjs';
import { startApiPublisher } from '../api/publisher.mjs';
import { API_VERSION } from '../api/version.mjs';
import { loadSemanticConfiguration } from '../api/semantic-config.mjs';

// Credentials are read only by the local DPAPI helper, after local approval.
for (const name of Object.keys(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name)) delete process.env[name];
try {
  assertSupportedNode();
  if (process.argv.length !== 2) throw Error();
  const semantic = await loadSemanticConfiguration(process.env.CACHEPILOT_SEMANTIC_CONFIG);
  const runtime = createApiRuntime({ semanticCache: semantic.cache });
  const publisher = startApiPublisher(runtime.ledger, { enabled: process.platform === 'win32' && process.env.CACHEPILOT_API_MONITOR !== 'off' });
  const errorMessages = Object.fromEntries([
    'API_CLOSED', 'API_CANCELLED', 'API_BUSY', 'API_NETWORK_DISABLED', 'API_BUDGET_EXHAUSTED',
    'API_APPROVAL_DENIED', 'API_PROFILE_CHANGED', 'API_OPERATION_REJECTED', 'API_ARGUMENTS_REJECTED',
    'API_UNKNOWN_TOOL', 'API_ENDPOINT_REJECTED', 'API_CREDENTIAL_REJECTED', 'API_DNS_REJECTED',
    'API_RESPONSE_LIMIT', 'API_REDIRECT_REFUSED', 'API_AUTH_REJECTED', 'API_RATE_LIMITED',
    'API_UPSTREAM_REJECTED', 'API_RESPONSE_FORMAT', 'API_RESPONSE_INCOMPLETE', 'API_TRANSPORT_FAILED',
    'API_TLS_REJECTED', 'API_TIMEOUT', 'API_METADATA_TIMEOUT', 'API_SCOPE_LIMIT', 'API_COUNTER_LIMIT', 'API_LOCAL_HELPER_UNCONFIRMED',
  ].map(code => [code, 'CachePilot API request was refused or incomplete. Check local profile, approval and limits. No automatic retry was made.']));
  const server = serveStdio({ name: 'cachepilot-api', version: API_VERSION, tools: apiTools,
    callTool: (name, args, context) => runtime.callTool(name, args, context),
    close: async () => { publisher.close(); await runtime.close(); await semantic.encoder?.close(); }, errorMessages,
    maxFrameBytes: 131072, maxOutputBytes: 2097152, maxPendingRequests: 2,
  });
  await server.closed;
} catch {
  process.stderr.write('CachePilot API bridge could not start. No credential or request details were logged.\n');
  process.exitCode = 1;
}
