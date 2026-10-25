import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { verifyPackage } from '../scripts/verify.mjs';
async function fixture(){
  const root=await mkdtemp(fileURLToPath(new URL('./verify-fixture-',import.meta.url)));
  const row={path:'sample.txt',bytes:7,sha256:createHash('sha256').update('fixture').digest('hex')};
  const manifest={version:1,hashAlgorithm:'SHA-256',files:[row]};
  const save=()=>writeFile(path.join(root,'MANIFEST.sha256.json'),JSON.stringify(manifest));
  await writeFile(path.join(root,'sample.txt'),'fixture');await save();return{root,row,manifest,save};
}
test('manifest verifies bytes without asserting authenticity or unchecked extra files',async()=>{
  const f=await fixture();const r=await verifyPackage(f.root);assert.equal(r.valid,true);assert.equal(r.authenticityProof,false);assert.equal(r.extraChecked,false);
});
test('changed and missing files are distinguished',async()=>{
  const f=await fixture();await writeFile(path.join(f.root,'sample.txt'),'changed');let r=await verifyPackage(f.root);assert.deepEqual(r.changed,['sample.txt']);assert.equal(r.valid,false);
  await unlink(path.join(f.root,'sample.txt'));r=await verifyPackage(f.root);assert.deepEqual(r.missing,['sample.txt']);
});
test('manifest cannot traverse outside the selected package',async()=>{
  for(const name of ['../secret','C:/Windows/test','folder/../secret','/absolute','folder\\secret']){
    const f=await fixture();f.row.path=name;await f.save();await assert.rejects(verifyPackage(f.root),/MANIFEST_REJECTED/);
  }
});
test('case-insensitive duplicate entries and malformed hashes are rejected',async()=>{
  const f=await fixture();f.manifest.files.push({...f.row,path:'SAMPLE.txt'});await f.save();await assert.rejects(verifyPackage(f.root),/MANIFEST_REJECTED/);
  f.manifest.files=[{...f.row,sha256:'not-a-hash'}];await f.save();await assert.rejects(verifyPackage(f.root),/MANIFEST_REJECTED/);
});
