import type { FillFieldBinding, FillProfilePayload } from '../../src/shared/types';

export interface FormCase {id:string;label:string;key:string;value:string;html:string;expected:Record<string,string>;binding?:FillFieldBinding;issue?:string}
const select=(label:string,autocomplete:string,options:string)=>`<label>${label}<select id="target" autocomplete="${autocomplete}">${options}</select></label>`;
const input=(label:string,autocomplete:string,type='text',extra='')=>`<label>${label}<input id="target" autocomplete="${autocomplete}" type="${type}" ${extra}></label>`;
const empty='<option value=""></option>',choose='<option value="">Please choose</option>';
const option=(value:string,label=value)=>`<option value="${value}">${label}</option>`;
const binding:FillFieldBinding={key:'email',selector:'#old',id:'old',name:'old',index:1,tagName:'input',type:'email',autocomplete:'email',controlLabel:'Email'};
export const formCases:FormCase[]=[
  {id:'english-email',label:'English email',key:'email',value:'person@example.test',html:input('Email','email','email'),expected:{target:'person@example.test'}},
  {id:'chinese-email',label:'中文邮箱',key:'email',value:'person@example.test',html:input('电子邮件','email','email'),expected:{target:'person@example.test'}},
  {id:'address-textarea',label:'Multi-line address',key:'address',value:'123 Example Street\nUnit 2',html:'<label>Street address<textarea id="target" autocomplete="street-address"></textarea></label>',expected:{target:'123 Example Street\nUnit 2'}},
  {id:'postal-leading-zero',label:'Postal leading zero',key:'postalCode',value:'00120',html:input('Postal code','postal-code'),expected:{target:'00120'}},
  {id:'country-empty-placeholder',label:'Empty placeholder',key:'country',value:'US',html:select('Country','country',empty+option('UK','United Kingdom')+option('US','United States')),expected:{target:'US'}},
  {id:'country-canada',label:'Canada ISO code',key:'country',value:'CA',html:select('Country','country',choose+option('California')+option('Canada')),expected:{target:'Canada'}},
  {id:'country-uk',label:'UK country alias',key:'country',value:'UK',html:select('Country','country',choose+option('GB','United Kingdom')),expected:{target:'GB'}},
  {id:'country-china',label:'中国与 ISO 代码',key:'country',value:'中国',html:select('国家','country',choose+option('CN','China')),expected:{target:'CN'}},
  {id:'country-germany',label:'German country name',key:'country',value:'Germany',html:select('Country','country',choose+option('DE','德国')),expected:{target:'DE'}},
  {id:'country-decorated',label:'Decorated country label',key:'country',value:'USA',html:select('Country','country',choose+option('840','US — United States')),expected:{target:'840'}},
  {id:'state-full-name',label:'US state full name',key:'state',value:'California',html:select('State','address-level1',choose+option('CA')+option('TX')),expected:{target:'CA'}},
  {id:'state-abbreviation',label:'US state abbreviation',key:'state',value:'NY',html:select('State','address-level1',choose+option('New York')+option('New Jersey')),expected:{target:'New York'}},
  {id:'zero-based-month',label:'Zero-based month options',key:'dobMonth',value:'1',html:select('Birth month','bday-month',choose+option('0','January')+option('1','February')),expected:{target:'0'}},
  {id:'named-month',label:'Named month to number',key:'dobMonth',value:'September',html:select('Birth month','bday-month',choose+option('09','9月')),expected:{target:'09'}},
  {id:'padded-day',label:'Zero padded day',key:'dobDay',value:'2',html:select('Birth day','bday-day',choose+option('01')+option('02')),expected:{target:'02'}},
  {id:'year-no-guess',label:'Ambiguous two-digit year',key:'dobYear',value:'27',html:select('Birth year','bday-year',choose+option('1927')+option('2027')),expected:{target:''},issue:'选项不匹配'},
  {id:'date-iso',label:'ISO date',key:'dob',value:'1990-12-31',html:input('Date of birth','bday','date'),expected:{target:'1990-12-31'}},
  {id:'date-chinese',label:'中文日期',key:'dob',value:'1990年12月31日',html:input('出生日期','bday','date'),expected:{target:'1990-12-31'}},
  {id:'date-unambiguous-dmy',label:'Unambiguous day-first date',key:'dob',value:'31/12/1990',html:input('Date of birth','bday','date'),expected:{target:'1990-12-31'}},
  {id:'date-named',label:'English named date',key:'dob',value:'December 31, 1990',html:input('Date of birth','bday','date'),expected:{target:'1990-12-31'}},
  {id:'date-ambiguous',label:'Ambiguous day/month order',key:'dob',value:'03/04/1990',html:input('Date of birth','bday','date'),expected:{target:''},issue:'日期无效或顺序不明确'},
  {id:'date-invalid-leap',label:'Reject calendar rollover',key:'dob',value:'2025-02-29',html:input('Date of birth','bday','date'),expected:{target:''},issue:'日期无效'},
  {id:'date-valid-leap',label:'Valid leap date',key:'dob',value:'2024-02-29',html:input('Date of birth','bday','date'),expected:{target:'2024-02-29'}},
  {id:'date-mask-dmy',label:'Day-first website mask',key:'dob',value:'1990-12-31',html:input('Date of birth','bday','text','placeholder="DD/MM/YYYY"'),expected:{target:'31/12/1990'}},
  {id:'date-mask-mdy',label:'Month-first website mask',key:'dob',value:'1990-12-31',html:input('Date of birth','bday','text','placeholder="MM/DD/YYYY"'),expected:{target:'12/31/1990'}},
  {id:'card-expiry-month',label:'Card expiry native month',key:'cardExpiry',value:'11/27',html:input('Card expiry','cc-exp','month'),expected:{target:'2027-11'}},
  {id:'option-duplicate',label:'Duplicate option ambiguity',key:'country',value:'United States',html:select('Country','country',choose+option('1','United States')+option('2','United States')),expected:{target:''},issue:'选项不匹配'},
  {id:'option-disabled',label:'Disabled option',key:'country',value:'US',html:select('Country','country',choose+'<optgroup disabled label="Unavailable">'+option('US','United States')+'</optgroup>'),expected:{target:''},issue:'选项不匹配'},
  {id:'option-prefix',label:'No partial country guess',key:'country',value:'United',html:select('Country','country',choose+option('UK','United Kingdom')+option('US','United States')),expected:{target:''},issue:'选项不匹配'},
  {id:'unrelated-select',label:'No fill based only on option value',key:'country',value:'US',html:select('Delivery service','',choose+option('US','US')+option('GB','GB')),expected:{target:''}},
  {id:'binding-moved',label:'Moved binding with stable label',key:'email',value:'person@example.test',binding,html:input('Email','email','email'),expected:{target:'person@example.test'}},
  {id:'binding-reused',label:'Reused ID has a different meaning',key:'email',value:'person@example.test',binding:{...binding,id:'target',selector:'#target'},html:input('Tax number','off','text'),expected:{target:''},issue:'原绑定已变化'},
  {id:'binding-position',label:'Deleted binding cannot select by position',key:'email',value:'person@example.test',binding,html:input('Order number','off'),expected:{target:''},issue:'原绑定已变化'},
  {id:'binding-duplicate-label',label:'Ambiguous relocated binding',key:'email',value:'person@example.test',binding,html:input('Email','email','email')+'<label>Email<input id="other" autocomplete="email" type="email"></label>',expected:{target:'',other:''},issue:'原绑定已变化'}
];
export function caseProfile(item:FormCase):FillProfilePayload {
  return {id:'benchmark',title:'Synthetic business profile',countryCode:'US',category:'identity',onlyEmpty:true,fields:[
    {key:'fullName',label:'Full name',value:'Example Person',group:'personal',sensitivity:'normal'},
    {key:item.key,label:item.key,value:item.value,group:'personal',sensitivity:item.key==='cardExpiry'?'secret':'normal'}
  ],...(item.binding?{siteBinding:{id:'benchmark-binding',domain:'forms.example.test',fields:[item.binding],createdAt:1,updatedAt:1}}:{})};
}
export function caseHtml(item:FormCase):string {
  return `<!doctype html><meta charset="utf-8"><title>KeyPilot form comparison · ${item.id}</title><style>body{font:16px system-ui;color:#172338;margin:24px;max-width:680px}label{display:block;margin:18px 0}input,select,textarea{display:block;box-sizing:border-box;width:100%;font:inherit;padding:10px}button{font:inherit;padding:10px}</style><h1>${item.label}</h1><p>Synthetic data only. No information is submitted.</p><form><label>Full name<input id="baseline" autocomplete="name"></label>${item.html}<button>Save</button></form><script>window.submissions=0;document.querySelector('form').onsubmit=event=>{event.preventDefault();window.submissions++}</script>`;
}
