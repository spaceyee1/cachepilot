import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { API_VERSION } from '../api/version.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
test('standalone candidate package metadata agrees with the MCP version and declares its local executor',async()=>{
  const plugin=JSON.parse(await readFile(path.join(root,'.codex-plugin/plugin.json'),'utf8'));
  const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  assert.equal(plugin.version,API_VERSION);assert.equal(pkg.version,API_VERSION);assert.equal(plugin.requires_local_executor,true);
  for(const name of ['displayName','shortDescription','longDescription','developerName','category'])assert.equal(typeof plugin.interface[name],'string');
  assert.ok(Array.isArray(plugin.interface.capabilities));assert.match(plugin.description,/uninstalled candidate/);
});
test('both listing icon references resolve to a bounded square original SVG without executable or external content',async()=>{
  const plugin=JSON.parse(await readFile(path.join(root,'.codex-plugin/plugin.json'),'utf8'));
  for(const field of ['composerIcon','logo']){
    const name=plugin.interface[field];assert.match(name,/^\.\/assets\/[a-z0-9-]+\.svg$/);
    const p=path.resolve(root,name);assert.ok(p.startsWith(path.resolve(root)+path.sep));
    const stat=await lstat(p);assert.ok(stat.isFile()&&!stat.isSymbolicLink());assert.ok(stat.size<5*1024*1024);
    const svg=await readFile(p,'utf8');assert.match(svg,/<svg\s/);assert.match(svg,/width="96" height="96" viewBox="0 0 96 96"/);
    assert.doesNotMatch(svg,/<(?:script|foreignObject|image)\b|\bon\w+\s*=|(?:href|url)\s*[=(]|<!DOCTYPE|<!ENTITY/i);
  }
});
