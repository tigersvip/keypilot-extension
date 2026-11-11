import {createServer} from 'node:http';
import {caseHtml,caseProfile,formCases} from '../tests/fixtures/formCompatibility';

// Local-only, synthetic forms shared with the automated matrix. This helper is
// not copied into dist and cannot read a user's vault or browser profile.
const escape=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
createServer((request,response)=>{
  const path=new URL(request.url??'/','http://127.0.0.1').pathname;
  const item=formCases.find(item=>path==='/case/'+item.id);
  response.setHeader('Content-Type','text/html; charset=utf-8');
  response.setHeader('Cache-Control','no-store');
  if(item){response.end(caseHtml(item).replace('<form>',`<details><summary>测试资料与预期结果</summary><pre>${escape(JSON.stringify({profile:caseProfile(item),expected:item.expected},null,2))}</pre></details><form>`));return;}
  if(path!=='/'){response.writeHead(404);response.end('Not found');return;}
  response.end('<!doctype html><meta charset="utf-8"><title>表单对照实验室</title><style>body{font:16px system-ui;max-width:900px;margin:32px auto;line-height:1.8}</style><h1>表单对照实验室</h1><p>固定合成样例，不代表真实网站覆盖率。只使用测试资料，每次仅启用一个待测插件。RoboForm 尚未实测，不能据此声称领先。</p><ol>'+formCases.map(item=>`<li><a href="/case/${item.id}">${escape(item.label)}</a></li>`).join('')+'</ol>');
}).listen(4174,'127.0.0.1',()=>console.log('Synthetic form lab: http://127.0.0.1:4174'));
