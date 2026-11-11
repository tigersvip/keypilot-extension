import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFillOption, parseFillDate, formatFillDate } from '../src/shared/fillValues';
import { suggestReminderCredential } from '../src/shared/reminderLinks';
import { buildCredential } from '../src/shared/vault';

test('selects exact options without empty, disabled, prefix or tied matches',()=>{
  const options=[{value:'',text:''},{value:'UK',text:'United Kingdom'},{value:'US',text:'United States'}];
  assert.equal(selectFillOption(options,'US','country'),2);
  assert.equal(selectFillOption(options,'United','country'),-1);
  assert.equal(selectFillOption([...options,{value:'USA',text:'United States'}],'United States','country'),-1);
  assert.equal(selectFillOption([{value:'US',text:'United States',disabled:true}],'US','country'),-1);
  assert.equal(selectFillOption(options,'','country'),-1);
  assert.equal(selectFillOption([{value:'x',text:'US — United States'}],'USA','country'),0);
});
test('aliases respect field meaning and visible labels in zero-based month lists',()=>{
  const months=[{value:'0',text:'January'},{value:'1',text:'February'}];
  assert.equal(selectFillOption(months,'1','dobMonth'),0);
  assert.equal(selectFillOption(months,'1','custom'),1);
  assert.equal(selectFillOption([{value:'California',text:'California'},{value:'Canada',text:'Canada'}],'CA','country'),1);
  assert.equal(selectFillOption([{value:'California',text:'California'},{value:'Canada',text:'Canada'}],'CA','state'),0);
  assert.equal(selectFillOption([{value:'01',text:'01'}],'1','dobDay'),0);
  assert.equal(selectFillOption([{value:'1927',text:'1927'},{value:'2027',text:'2027'}],'27','dobYear'),-1);
});
test('date normalization preserves real dates and refuses ambiguous ordering and rollover',()=>{
  for(const value of ['2024-02-29','2024年2月29日','29/02/2024','February 29, 2024','29 Feb 2024'])assert.equal(formatFillDate(value,'date'),'2024-02-29');
  for(const value of ['2025-02-29','2024-02-30','2024-00-10','2024-02-00','03/04/1990','12/31/90','tomorrow'])assert.deepEqual(parseFillDate(value),{});
  assert.equal(formatFillDate('1990-12-31','text','DD/MM/YYYY'),'31/12/1990');
  assert.equal(formatFillDate('1990-12-31','text','MM/DD/YYYY'),'12/31/1990');
  assert.equal(formatFillDate('11/27','month','',true),'2027-11');
  assert.equal(formatFillDate('11/2027','text','MM/YY',true),'11/27');
  assert.deepEqual(parseFillDate('2024-02-00',true),{});
});
test('reminder links require a unique exact host or title, never a suffix or a password match',()=>{
  const first=buildCredential({title:'Server A',url:'https://192.0.2.10',username:'a',password:'private.example.test'});
  const second=buildCredential({title:'Server B',url:'https://admin.example.test',username:'b',password:'secret'});
  assert.equal(suggestReminderCredential('IP Address 192.0.2.10 · 到期',[first,second]),first.id);
  assert.equal(suggestReminderCredential('Server A · 到期',[first,second]),first.id);
  assert.equal(suggestReminderCredential('private.example.test',[first,second]),undefined);
  assert.equal(suggestReminderCredential('evil-admin.example.test',[first,second]),undefined);
  assert.equal(suggestReminderCredential('192.0.2.100',[first,second]),undefined);
  assert.equal(suggestReminderCredential('192.0.2.10',[first,{...first,id:'other'}]),undefined);
});
