import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const executable = fileURLToPath(new URL('../ui/CachePilot.ApiLocalHelper.exe', import.meta.url));
// No bind/read mode is executed by these tests; no profile or real key is read.
function run(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = []; let count = 0;
    const timer = setTimeout(() => { child.kill(); reject(Error('native helper test timeout')); }, 10000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', chunk => { count += chunk.length; if (count > 16384) { child.kill(); reject(Error('unexpected output size')); } else chunks.push(chunk); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
test('native self-test protects only an in-memory synthetic marker with DPAPI', async () => {
  const result = await run(['self-test']);
  assert.equal(result.code, 0); assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { passed: true, syntheticMarker: true, realCredentialUsed: false, networkRequests: 0, configurationRead: false, configurationWritten: false, gpu: 'off' });
  assert.ok(!result.stdout.includes('CACHEPILOT_SYNTHETIC_MARKER_NOT_A_CREDENTIAL'));
});
test('unknown mode and extra arguments are rejected without exposing inputs', async () => {
  for (const args of [[], ['unknown-mode'], ['self-test', 'SYNTHETIC_PRIVATE_ARGUMENT']]) {
    const result = await run(args);
    assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, 'LOCAL_HELPER_REJECTED\n');
  }
});
test('approve refuses malformed, oversized, invalid-UTF8 and wrong-shape input before a dialog', async () => {
  for (const input of ['{', '{}', 'x'.repeat(81921), Buffer.from([0xff, 0xfe, 0xfd]), JSON.stringify({ bodyText: 'SYNTHETIC_PRIVATE_TEXT' })]) {
    const result = await run(['approve'], input);
    assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, 'LOCAL_HELPER_REJECTED\n');
  }
});
test('gateway refuses malformed and non-loopback details before a dialog', async () => {
  for (const input of ['{}', 'x'.repeat(8193), JSON.stringify({ address: 'http://remote.invalid:9999', expiresAt: '2099-01-01T00:00:00Z', model: 'fixture-model', profileId: 'offline-fixture', protocol: 'openai-chat', token: 'A'.repeat(43) })]) {
    const result = await run(['gateway'], input);
    assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, 'LOCAL_HELPER_REJECTED\n');
  }
});
