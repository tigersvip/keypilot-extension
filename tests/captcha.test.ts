import test from 'node:test';
import assert from 'node:assert/strict';
import {assessAutoCaptcha,captchaCandidates,validCaptchaText,validCaptchaCrop,validCaptchaLength} from '../src/shared/captcha';
import {captchaOrigin,validCaptchaRule,validateCaptchaRules} from '../src/shared/captchaRules';
import {saveCaptchaRule} from '../src/shared/captchaRuleStorage';
import {createVaultSession,persistVaultSession,clearVaultSessionCache} from '../src/shared/vault';
import {prepareEncryptedBackup} from '../src/shared/backupStatus';
import {previewBackup,initializeVaultFromBackup} from '../src/shared/backup';
import {VAULT_STORAGE_KEY} from '../src/shared/storage';
import {createEmptyVault} from '../src/shared/defaults';
import {validateBackup} from '../src/shared/backup';
import {mergeBackupSettings} from '../src/shared/backupSettings';

test('OCR candidates preserve case, reject punctuation and deduplicate independently of whitespace',()=>{
  assert.deepEqual(captchaCandidates([{text:'a7Bc\n',confidence:70},{text:'a 7 Bc',confidence:75},{text:'a7BC',confidence:76},{text:'<bad>',confidence:99},{text:'12345',confidence:NaN}], 'alnum'),[{text:'a7Bc',confidence:75},{text:'a7BC',confidence:76}]);
  assert.deepEqual(captchaCandidates([{text:'O12',confidence:90},{text:'012',confidence:40}], 'digits'),[{text:'012',confidence:40}]);
  assert.equal(validCaptchaText('1','digits'),false);assert.equal(validCaptchaText('12345678901','digits'),false);
});
test('viewport crop must be finite, small, and entirely visible',()=>{
  const crop={x:100,y:150,width:180,height:50,viewportWidth:1000,viewportHeight:800};
  assert.equal(validCaptchaCrop(crop),true);
  for(const patch of [{x:-1},{width:901},{height:301},{y:790},{x:Infinity},{width:NaN},{viewportWidth:0}])assert.equal(validCaptchaCrop({...crop,...patch}),false);
});
test('OCR is opt-in and included in selected backup preferences',()=>{
  const vault=createEmptyVault();assert.equal(vault.settings.captchaAssistEnabled,false);
  const incoming={...vault.settings,captchaAssistEnabled:true};
  assert.equal(mergeBackupSettings(vault.settings,incoming,{}).captchaAssistEnabled,false);
  assert.equal(mergeBackupSettings(vault.settings,incoming,{preferences:true}).captchaAssistEnabled,true);
  validateBackup({...vault,settings:incoming});
  assert.throws(()=>validateBackup({...vault,settings:{...incoming,captchaAssistEnabled:'true' as any}}));
});

test('explicit character counts reject missing digits without padding and preserve leading zeros',()=>{
  assert.equal(validCaptchaText('0012','digits',4),true);
  for(const text of ['012','00123','OO12'])assert.equal(validCaptchaText(text,'digits',4),false);
  assert.deepEqual(captchaCandidates([{text:'012',confidence:98},{text:'0012',confidence:80}],'digits',4),[{text:'0012',confidence:80}]);
  for(const length of [null,'4',NaN,0,1,2.5,11])assert.equal(validCaptchaLength(length),false);
  for(const length of [undefined,2,4,10])assert.equal(validCaptchaLength(length),true);
});

test('automatic recognition preserves case and punctuation without assuming a numeric alphabet',()=>{
  for(const text of ['0012','K9pR','a+7?','8@#2'])assert.equal(validCaptchaText(text,'auto'),true);
  for(const text of ['a b','a\n2','中文','a\u00002'])assert.equal(validCaptchaText(text,'auto'),false);
  const result=assessAutoCaptcha([{text:'K9pR',confidence:88},{text:'K9pR',confidence:84}],{text:'6998',alternatives:[],uncertain:false});
  assert.equal(result.candidates?.[0].text,'K9pR');assert.equal(result.uncertain,false);
  assert.ok(!result.candidates?.some(item=>item.text==='6998'));
  assert.equal(assessAutoCaptcha([{text:'a+7?',confidence:85},{text:'a+7?',confidence:82}],{text:'',alternatives:[],uncertain:false}).candidates?.[0].text,'a+7?');
  validateCaptchaRules({'https://example.test':{mode:'auto',expectedLength:4}});
});

test('engine disagreement, unsupported single guesses and case ambiguity require explicit review',()=>{
  const digit={text:'5671',alternatives:[],uncertain:false};
  const conflict=assessAutoCaptcha([{text:'6671',confidence:90},{text:'6671',confidence:88}],digit);
  assert.equal(conflict.uncertain,true);assert.ok(conflict.candidates?.some(item=>item.text==='5671'));
  assert.equal(assessAutoCaptcha([],digit).uncertain,true);
  const lookalike=assessAutoCaptcha([{text:'A827',confidence:92},{text:'A827',confidence:89}],{...digit,text:'4827'});
  assert.equal(lookalike.uncertain,true);assert.ok(lookalike.candidates?.some(item=>item.text==='4827'));
  assert.equal(assessAutoCaptcha([{text:'a7B',confidence:90},{text:'A7B',confidence:88}],{text:'',alternatives:[],uncertain:false}).uncertain,true);
  const agreed=assessAutoCaptcha([{text:'0012',confidence:60}],{...digit,text:'0012'},4);
  assert.equal(agreed.uncertain,false);assert.equal(agreed.candidates?.[0].text,'0012');
  assert.equal(assessAutoCaptcha([{text:'012',confidence:95}],{...digit,text:'012'},4).error,'LENGTH_MISMATCH');
});
test('website rules are exact-origin, bounded and exclude images, answers and selectors',()=>{
  assert.equal(captchaOrigin('https://example.test:8443/login?secret=hidden'),'https://example.test:8443');
  const rules={'https://example.test':{mode:'digits',expectedLength:4}};
  validateCaptchaRules(rules);assert.equal(validCaptchaRule({mode:'alnum'}),true);
  for(const bad of [[],null,{'https://example.test/login':{mode:'digits'}},{'http://example.test':{mode:'digits',expectedLength:3.5}},{'https://example.test':{mode:'digits',image:'data:image/png;base64,x'}},{'https://example.test':{mode:'digits',answer:'1234'}},{'*.example.test':{mode:'digits'}},{'file:///tmp':{mode:'digits'}},Object.fromEntries(Array.from({length:501},(_,i)=>[`https://site${i}.test`,{mode:'digits'}]))])assert.throws(()=>validateCaptchaRules(bad));
  const current=createEmptyVault(),incoming={...current.settings,captchaSiteRules:rules as any};
  assert.deepEqual(mergeBackupSettings(current.settings,incoming,{preferences:true}).captchaSiteRules,{});
  assert.deepEqual(mergeBackupSettings(current.settings,incoming,{siteRules:true}).captchaSiteRules,rules);
  validateBackup({...current,settings:incoming});
  assert.throws(()=>validateBackup({...current,settings:{...incoming,captchaSiteRules:{'https://example.test':{mode:'digits',expectedLength:1}}}}));
});
test('rules survive encrypted export/restore and concurrent sites, while locking blocks writes',async()=>{
  function area(){const data:Record<string,unknown>={};return {async get(key:string){return structuredClone({[key]:data[key]});},async set(values:Record<string,unknown>){Object.assign(data,structuredClone(values));},async remove(key:string){delete data[key];}};}
  Object.assign(globalThis,{chrome:{storage:{local:area(),session:area()}}});
  const initial=await createVaultSession('Synthetic-captcha!42');
  await assert.rejects(persistVaultSession(initial,{...initial.vault,settings:{...initial.vault.settings,captchaSiteRules:Object.fromEntries(Array.from({length:501},(_,i)=>[`https://site${i}.test`,{mode:'digits' as const}]))}}),/验证码网站规则/);
  await saveCaptchaRule(initial,'https://first.test/login',{mode:'digits',expectedLength:4});
  let next=await saveCaptchaRule(initial,'https://second.test:8443/sign-in',{mode:'alnum',expectedLength:6});
  assert.equal(Object.keys(next.vault.settings.captchaSiteRules!).length,2);
  const stale=next;
  next=await saveCaptchaRule(next,'https://first.test',{mode:'auto',expectedLength:5,disabled:true});
  await assert.rejects(saveCaptchaRule(stale,'https://first.test',{mode:'digits',expectedLength:6}),/VAULT_WRITE_CONFLICT/);
  next=await saveCaptchaRule(next,'https://second.test:8443',null);
  assert.deepEqual(Object.keys(next.vault.settings.captchaSiteRules!),['https://first.test']);
  const other=await persistVaultSession(stale,{...stale.vault,settings:{...stale.vault.settings,autoFill:false}});
  assert.equal(other.vault.settings.captchaSiteRules!['https://first.test'].expectedLength,5);
  assert.equal(other.vault.settings.captchaSiteRules!['https://first.test'].disabled,true);
  assert.equal(other.vault.settings.captchaSiteRules!['https://second.test:8443'],undefined);
  const backup=await prepareEncryptedBackup(other),serialized=JSON.stringify(backup.encryptedVault);
  assert.ok(!serialized.includes('first.test'));
  await clearVaultSessionCache();await assert.rejects(saveCaptchaRule(other,'https://third.test',{mode:'digits'}),/VAULT_LOCKED/);
  await chrome.storage.local.remove(VAULT_STORAGE_KEY);
  const restored=await initializeVaultFromBackup(await previewBackup(new File([serialized],'test.json'),'Synthetic-captcha!42'));
  assert.deepEqual(restored.vault.settings.captchaSiteRules,{'https://first.test':{mode:'auto',expectedLength:5,disabled:true}});
});

test('per-site opt-out is strictly boolean and included only in selected site-rule backups',()=>{
  for(const disabled of [true,false,undefined])assert.equal(validCaptchaRule({mode:'auto',disabled}),true);
  for(const disabled of ['true',1,null,{},[]])assert.equal(validCaptchaRule({mode:'auto',disabled}),false);
  const current=createEmptyVault(),rules={'https://example.test:8443':{mode:'auto' as const,disabled:true,expectedLength:4}},incoming={...current.settings,captchaSiteRules:rules};
  validateBackup({...current,settings:incoming});
  assert.deepEqual(mergeBackupSettings(current.settings,incoming,{preferences:true}).captchaSiteRules,{});
  assert.deepEqual(mergeBackupSettings(current.settings,incoming,{siteRules:true}).captchaSiteRules,rules);
  assert.equal(rules['https://example.test:8443'].disabled,true);
});
