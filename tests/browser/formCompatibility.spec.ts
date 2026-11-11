import {test,expect,chromium,type BrowserContext,type Worker,type Page} from '@playwright/test';
import {resolve} from 'node:path';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createEmptyVault} from '../../src/shared/defaults';
import {createEncryptedVault,exportVaultKey} from '../../src/shared/crypto';
import {caseHtml,caseProfile,formCases,type FormCase} from '../fixtures/formCompatibility';

let context:BrowserContext,worker:Worker;
const evidence=resolve(process.env.TEMP??tmpdir(),'keypilot-forms-v1.16.0');
const measurements:unknown[]=[];
test.beforeEach(async()=>{
  const extension=resolve('dist');context=await chromium.launchPersistentContext('',{channel:'chromium',headless:true,args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--mute-audio']});
  worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  const vault=createEmptyVault(),{encryptedVault,key}=await createEncryptedVault('Synthetic-forms!42',vault);
  const cache={vault,encryptedVault,exportedKey:await exportVaultKey(key),cachedAt:Date.now(),sessionId:'form-comparison'};
  await worker.evaluate(async cache=>{await chrome.storage.local.set({'keypilot.encryptedVault':cache.encryptedVault});await chrome.storage.session.set({'keypilot.unlockedSession':cache,'keypilot.sessionState':{id:cache.sessionId,expiresAt:0,highSecurity:false}});},cache);
});
test.afterEach(async()=>{await context?.close();});
test.afterAll(async()=>{
  await mkdir(evidence,{recursive:true});const manifest=JSON.parse(await readFile(resolve('dist/manifest.json'),'utf8'));
  await writeFile(resolve(evidence,'results.json'),JSON.stringify({version:manifest.version,platform:process.platform,kind:'synthetic regression; not real-site or competitor accuracy',roboform:'not measured',expectedCases:formCases.length,complete:measurements.length===formCases.length,cases:measurements},null,2));
});
async function openCase(item:FormCase){
  await context.route('https://forms.example.test/**',route=>route.fulfill({contentType:'text/html',body:caseHtml(item)}));
  const page=await context.newPage();await page.goto('https://forms.example.test/'+item.id);
  await expect(page).toHaveTitle('KeyPilot form comparison · '+item.id);await expect(page.locator('form')).toBeVisible();
  return page;
}
async function start(page:Page,item:FormCase){
  await worker.evaluate(async({url,profile})=>{
    const tab=(await chrome.tabs.query({url}))[0];
    // Keep the real closed shadow root; retain a reference only in this test's
    // isolated world so assertions can inspect the actual preview text.
    await chrome.scripting.executeScript({target:{tabId:tab.id!},func:()=>{
      const native=Element.prototype.attachShadow;Element.prototype.attachShadow=function(init){const root=native.call(this,init);if(this.id==='keypilot-fill-review')(globalThis as any).testReviewRoot=root;return root;};
    }});
    (globalThis as any).formResult=chrome.tabs.sendMessage(tab.id!,{type:'KEYPILOT_FILL_PROFILE',profile});
  },{url:page.url(),profile:caseProfile(item)});
  await expect(page.locator('#keypilot-fill-review')).toHaveAttribute('aria-label','预览填写内容');
}
async function previewText(page:Page){return worker.evaluate(async url=>{const tab=(await chrome.tabs.query({url}))[0];return (await chrome.scripting.executeScript({target:{tabId:tab.id!},func:()=>(globalThis as any).testReviewRoot?.textContent}))[0].result as string;},page.url());}
for(const item of formCases)test(`form matrix: ${item.id}`,async()=>{
  const page=await openCase(item),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const started=Date.now();await start(page,item);
  if(item.issue)expect(await previewText(page)).toContain(item.issue);
  if(item.id==='binding-reused'){
    for(const width of [1280,390]){await page.setViewportSize({width,height:800});await mkdir(evidence,{recursive:true});await page.screenshot({path:resolve(evidence,`binding-changed-${width}.png`)});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
  }
  await page.keyboard.press('Enter');await expect(page.locator('#keypilot-fill-review')).toHaveAttribute('aria-label','填写完成');
  const expected={baseline:'Example Person',...item.expected},actual=await page.locator('body > form').locator('input,select,textarea').evaluateAll(nodes=>Object.fromEntries(nodes.map(node=>[node.id,(node as HTMLInputElement).value])));
  const result=await worker.evaluate(()=>(globalThis as any).formResult);
  measurements.push({id:item.id,expectedFields:Object.keys(expected).length,correctFields:Object.entries(expected).filter(([key,value])=>actual[key]===value).length,unexpectedChanges:Object.keys(actual).filter(key=>!(key in expected)&&actual[key]!==''),elapsedMs:Date.now()-started,confirmationActions:1});
  expect(actual).toEqual(expected);expect(await page.evaluate(()=>(window as any).submissions)).toBe(0);expect(errors).toEqual([]);
  expect(result.filledCount).toBe(Object.values(expected).filter(Boolean).length);
});
test('preview rejects a field meaning or option change before confirmation',async()=>{
  for(const id of ['english-email','country-empty-placeholder']){
    const item=formCases.find(item=>item.id===id)!,page=await openCase(item);await start(page,item);
    await page.locator('#target').evaluate(element=>{if(element instanceof HTMLSelectElement)element.options[2].textContent='Another country';else element.setAttribute('autocomplete','off');});
    await page.keyboard.press('Enter');await expect.poll(()=>previewText(page)).toContain('网页字段已变化');
    await expect(page.locator('#baseline')).toHaveValue('');await expect(page.locator('#target')).toHaveValue('');await page.close();
  }
});

test('reactive form changes during filling do not receive values from the stale plan',async()=>{
  const item=formCases.find(item=>item.id==='english-email')!,page=await openCase(item);await start(page,item);
  await page.locator('#baseline').evaluate(element=>element.addEventListener('input',()=>{const target=document.querySelector<HTMLInputElement>('#target')!;target.value='user-edited@example.test';target.setAttribute('autocomplete','off');},{once:true}));
  await page.keyboard.press('Enter');await expect(page.locator('#keypilot-fill-review')).toHaveAttribute('aria-label','填写完成');
  await expect(page.locator('#baseline')).toHaveValue('Example Person');await expect(page.locator('#target')).toHaveValue('user-edited@example.test');
  const result=await worker.evaluate(()=>(globalThis as any).formResult);expect(result.filledCount).toBe(1);expect(result.diagnostics).toContainEqual(expect.objectContaining({key:'email',status:'missing',reason:expect.stringContaining('填写期间变化')}));
});
