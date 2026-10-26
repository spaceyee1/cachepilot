import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSupportedNode } from '../vendor/runtime-policy.mjs';

// Print configuration only. Never read credentials or edit a host's settings.
export function createMcpConfig(format = 'mcpServers') {
  if (!['mcpServers', 'server'].includes(format)) throw new Error('MCP_CONFIG_ARGUMENTS_REJECTED');
  const entry = {
    command: process.execPath,
    args: [fileURLToPath(new URL('./api-mcp.mjs', import.meta.url))],
    env: { CACHEPILOT_GPU: 'off', CUDA_VISIBLE_DEVICES: '-1', NVIDIA_VISIBLE_DEVICES: 'none' },
  };
  return format === 'server' ? entry : { mcpServers: { cachepilot: entry } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 0 && !(args.length === 2 && args[0] === '--format')) throw new Error();
    const config = createMcpConfig(args.length ? args[1] : 'mcpServers');
    assertSupportedNode();
    process.stdout.write(JSON.stringify(config, null, 2) + '\n');
  } catch {
    process.stderr.write('MCP_CONFIG_ARGUMENTS_REJECTED\n');
    process.exitCode = 1;
  }
}
