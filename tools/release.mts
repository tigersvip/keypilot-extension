import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..');
const read=(name:string)=>readFile(resolve(root,name),'utf8');
const json=async(name:string)=>JSON.parse(await read(name));
const {version}=await json('package.json');
if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('Expected a stable x.y.z version.');
const mode=process.argv[2]??'check';
if(!['check','sync','notes'].includes(mode))throw new Error('Use check, sync or notes.');
const block=`<!-- current-release:start -->\n当前源码版本：**${version}**。安装包：\`keypilot-extension-v${version}.zip\`。\n\n在 [Releases](https://github.com/tigersvip/keypilot-extension/releases) 查看已发布的安装包、更新说明与 SHA-256 校验文件；开发分支版本不一定已经发布。\n<!-- current-release:end -->`;
const pattern=/<!-- current-release:start -->[\s\S]*?<!-- current-release:end -->/;
const readme=(await read('README.md')).replaceAll('\r\n','\n');
if(!pattern.test(readme))throw new Error('README current-release markers are missing.');
const manifest=await json('public/manifest.json'),lock=await json('package-lock.json');
if(mode==='sync'){
  manifest.version=version;manifest.version_name=version;lock.version=version;lock.packages[''].version=version;
  for(const [name,value] of [['public/manifest.json',manifest],['package-lock.json',lock]] as const)await writeFile(resolve(root,name),JSON.stringify(value,null,2)+'\n');
  await writeFile(resolve(root,'README.md'),readme.replace(pattern,()=>block));
}else{
  if(manifest.version!==version || manifest.version_name!==version || lock.version!==version || lock.packages[''].version!==version)throw new Error('Version mismatch: run npm run version:sync.');
  if(readme.match(pattern)?.[0]!==block)throw new Error('README version is stale: run npm run version:sync.');
  if(process.env.GITHUB_REF_TYPE==='tag' && process.env.GITHUB_REF_NAME!==`v${version}`)throw new Error('Release tag does not match package version.');
  const changelog=(await read('CHANGELOG.md')).replaceAll('\r\n','\n');
  const section=changelog.split(/^## /m).slice(1).find(section=>section.startsWith(version+' — '));
  if(!section?.trim() || section.trim().split('\n').length<3)throw new Error('Current version needs CHANGELOG release notes.');
  if(mode==='notes'){
    const out=resolve(root,'output/release');await mkdir(out,{recursive:true});
    await writeFile(resolve(out,'notes.md'),'## '+section.trim()+'\n');
  }
}
console.log(`Release ${version}: ${mode} passed.`);
