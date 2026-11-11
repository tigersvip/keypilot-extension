import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {zipSync,strToU8} from 'fflate';
const root=resolve('ocr-lab-dist');let html=await readFile(resolve(root,'index.html'),'utf8');
const scripts=[...html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/g)];
for(const match of scripts){
 if(!/^\.\/assets\/[\w.-]+\.js$/.test(match[1]))throw new Error('Unexpected asset path');
 // A replacement string would interpret minified expressions such as `$&`
 // as replacement tokens and splice HTML into the JavaScript source.
 const code=await readFile(resolve(root,match[1]),'utf8');html=html.replace(match[0],()=>`<script type="module">${code.replace(/<\/script/gi,'<\\/script')}</script>`);
}
for(const match of [...html.matchAll(/<link\b[^>]*href="([^"]+\.css)"[^>]*>/g)]){
 if(!/^\.\/assets\/[\w.-]+\.css$/.test(match[1]))throw new Error('Unexpected style path');
 const css=await readFile(resolve(root,match[1]),'utf8');html=html.replace(match[0],()=>'<style>'+css+'</style>');
}
const name='KeyPilot-数字识别原型.html';await writeFile(resolve(root,name),html);
const archive=zipSync({[name]:strToU8(html)},{level:9});await writeFile(resolve(root,'keypilot-digit-lab-prototype-v2.zip'),archive);
console.log(JSON.stringify({htmlBytes:Buffer.byteLength(html),zipBytes:archive.length,path:resolve(root,name)}));
