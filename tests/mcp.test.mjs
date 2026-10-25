import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { once } from 'node:events';
import { API_VERSION } from '../api/version.mjs';

test('actual candidate MCP process initializes, lists tools and reports its own empty API scope', { timeout: 15000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const sandbox = path.join(root, 'tests', '.mcp-offline-fixture-' + process.pid);
  await mkdir(sandbox, { recursive: false });
  const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(root, 'tests', 'offline-guard.mjs')).href, path.join(root, 'scripts', 'api-mcp.mjs')],
    { cwd: root, windowsHide: true, env: { ...process.env, LOCALAPPDATA: sandbox, CACHEPILOT_API_MONITOR:'off' }, stdio: ['pipe','pipe','pipe'] });
  let raw = '', errorText = '', exited = false; const responses = new Map();
  child.once('close', () => { exited = true; });
  child.stdin.on('error', () => {});
  child.once('error', error => { errorText += error.code ?? 'SPAWN_ERROR'; });
  child.stdout.on('data', b => { raw += b.toString(); let n; while ((n = raw.indexOf('\n')) >= 0) { const line = raw.slice(0,n); raw = raw.slice(n+1); const value = JSON.parse(line); if (value.id !== undefined) responses.set(value.id,value); } });
  child.stderr.on('data', b => { errorText += b.toString(); });
  const wait = async id => {
    const until = Date.now()+5000;
    while (!responses.has(id) && Date.now()<until && !exited) await new Promise(r=>setTimeout(r,10));
    assert.ok(responses.has(id), 'MCP response missing; fixed stderr=' + errorText); return responses.get(id);
  };
  const send = value => child.stdin.write(JSON.stringify(value)+'\n');
  try {
    send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'cachepilot-offline-candidate-test',version:'0'}}});
    assert.equal((await wait(1)).result.serverInfo.version,API_VERSION);
    send({jsonrpc:'2.0',method:'notifications/initialized'});
    send({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});
    const tools=(await wait(2)).result.tools.map(t=>t.name);
    for(const name of ['cachepilot_api_status','cachepilot_api_preview','cachepilot_api_request'])assert.ok(tools.includes(name));
    send({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'cachepilot_api_status',arguments:{}}});
    const statusResult=(await wait(3)).result;
    const status=statusResult.structuredContent??JSON.parse(statusResult.content.find(c=>c.type==='text').text);
    assert.equal(status.pid,child.pid);assert.equal(status.device,'off');assert.equal(status.networkAttempts,0);assert.deepEqual(status.profiles,[]);assert.deepEqual(status.scopes,[]);assert.equal(status.hostRequestsIntercepted,false);
    send({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'cachepilot_api_request',arguments:{profileId:'missing-offline-profile',body:{}}}});
    const failure=(await wait(4)).result;assert.equal(failure.isError,true);assert.ok(!JSON.stringify(failure).includes('credentialCipher'));
  } finally {
    if (!exited) {
      const closed=once(child,'close');child.stdin.end();
      const graceful=await Promise.race([closed.then(()=>true),new Promise(r=>setTimeout(()=>r(false),1000))]);
      if (!graceful && !exited) { child.kill(); await Promise.race([closed,new Promise(r=>setTimeout(r,1000))]); }
    }
    assert.ok(path.resolve(sandbox).startsWith(path.resolve(root)+path.sep));
    assert.ok(path.basename(sandbox)==='.mcp-offline-fixture-'+process.pid);
    await rm(sandbox,{recursive:true,force:true});
  }
});
