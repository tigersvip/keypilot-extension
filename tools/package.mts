import {readdir,readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {Script} from 'node:vm';
import {zipSync,unzipSync,type Zippable} from 'fflate';

const root=resolve(import.meta.dirname,'..'),dist=resolve(root,'dist');
const metadata=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
const manifest=JSON.parse(await readFile(resolve(dist,'manifest.json'),'utf8'));
if(manifest.version!==metadata.version)throw new Error('Manifest and package versions differ. Rebuild first.');
if(manifest.version_name&&manifest.version_name!==manifest.version)throw new Error('Displayed extension version differs from the package version.');
// Vite must not extract a shared ESM import into a classic manifest script.
for(const entry of manifest.content_scripts??[])for(const name of entry.js??[])new Script(await readFile(resolve(dist,name),'utf8'),{filename:name});
const files:Zippable={};let expanded=0;
async function collect(directory:string){
 for(const item of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  const path=resolve(directory,item.name);
  if(item.isDirectory())await collect(path);
  else if(item.isFile()){
   const bytes=await readFile(path),key=relative(dist,path).replaceAll('\\','/');expanded+=bytes.length;
   files[key]=[bytes,{mtime:new Date('2026-01-01T00:00:00Z')}];
  }else throw new Error('Unexpected non-file in dist: '+path);
 }
}
await collect(dist);
const bytes=zipSync(files,{level:9});
if(bytes.length>10_000_000||expanded>15_000_000)throw new Error(`Package exceeds size budget: ZIP ${bytes.length}/10000000, installed ${expanded}/15000000 bytes.`);
const unpacked=unzipSync(bytes);
for(const [name,file] of Object.entries(files))if(!Buffer.from(unpacked[name]).equals(Buffer.from((file as [Uint8Array,unknown])[0])))throw new Error('ZIP verification failed: '+name);
const output=resolve(root,`keypilot-extension-v${manifest.version}.zip`);
await writeFile(output,bytes);
const sha256=createHash('sha256').update(bytes).digest('hex');
const release=resolve(root,'output/release');await mkdir(release,{recursive:true});
await writeFile(resolve(release,`keypilot-extension-v${manifest.version}.sha256`),`${sha256}  keypilot-extension-v${manifest.version}.zip\n`);
console.log(JSON.stringify({output,zipBytes:bytes.length,installedBytes:expanded,files:Object.keys(files).length,sha256},null,2));
