import { readFile, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verifyPackage(root) {
  const changed=[], missing=[];
  const manifestPath=path.join(root,'MANIFEST.sha256.json');
  const manifestStat=await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size>1048576) throw Error('MANIFEST_REJECTED');
  const data=JSON.parse(await readFile(manifestPath,'utf8'));
  if (data.version!==1 || data.hashAlgorithm!=='SHA-256' || !Array.isArray(data.files) || !data.files.length || data.files.length>1000) throw Error('MANIFEST_REJECTED');
  const seen=new Set();
  for(const item of data.files){
    const name=item?.path;
    if(typeof name!=='string' || !/^[A-Za-z0-9_.\/-]+$/.test(name) || name.split('/').some(p=>!p||p==='.'||p==='..') || seen.has(name.toLowerCase()) || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes<0 || item.bytes>125829120) throw Error('MANIFEST_REJECTED');
    seen.add(name.toLowerCase());
    let cursor=root, stat;
    try{
      const parts=name.split('/');
      for(let i=0;i<parts.length;i++){
        cursor=path.join(cursor,parts[i]);stat=await lstat(cursor);
        if(stat.isSymbolicLink() || (i<parts.length-1 && !stat.isDirectory())) throw Error('MANIFEST_REJECTED');
      }
      if(!stat.isFile())throw Error('MANIFEST_REJECTED');
      const hash=createHash('sha256');for await(const block of createReadStream(cursor))hash.update(block);
      if(stat.size!==item.bytes || hash.digest('hex')!==item.sha256)changed.push(name);
    }catch(error){if(error.code==='ENOENT')missing.push(name);else throw error;}
  }
  return {valid:!changed.length&&!missing.length,files:data.files.length,changed,missing,extraChecked:false,authenticityProof:false};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const result=await verifyPackage(fileURLToPath(new URL('../',import.meta.url)));process.stdout.write(JSON.stringify(result)+'\n');if(!result.valid)process.exitCode=1;}
  catch{process.stderr.write('MANIFEST_REJECTED\n');process.exitCode=1;}
}
