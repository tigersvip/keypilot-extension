import { createEmptyVault } from '../../src/shared/defaults';
import { buildCredential } from '../../src/shared/vault';
import type { VaultPlain } from '../../src/shared/types';

// Synthetic records and a public RFC 6238 test key only.
export function completeBackupFixture(): VaultPlain {
  const vault = createEmptyVault();
  vault.credentials = [buildCredential({title:'Synthetic backup login',url:'https://backup.example.test',username:'backup-user',password:'Backup-only!42'})];
  vault.totpAccounts = [{id:'backup-totp',issuer:'Backup example',account:'synthetic@example.test',secret:'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',algorithm:'SHA1',digits:8,period:30,createdAt:1,updatedAt:1}];
  vault.secureNotes = [{id:'backup-note',title:'Synthetic note',note:'Synthetic note contents',createdAt:1,updatedAt:1}];
  vault.identities = [{id:'backup-identity',title:'Synthetic identity',fullName:'Example Person',createdAt:1,updatedAt:1}];
  vault.fillProfiles = [{id:'backup-profile',privacyVersion:1,title:'Synthetic profile',countryCode:'US',category:'identity',createdAt:1,updatedAt:1,fields:[{key:'dob',label:'出生日期',value:'1990-01-02',group:'personal',sensitivity:'normal'},{key:'cardNumber',label:'卡号',value:'4111111111111111',group:'payment',sensitivity:'secret'}]}];
  vault.folders = [{id:'backup-folder',name:'Synthetic folder',createdAt:1,updatedAt:1}];
  vault.deletedItems = [{id:'backup-deleted',kind:'secureNote',deletedAt:2,item:{...vault.secureNotes[0],id:'removed-note',title:'Removed synthetic note'}}];
  vault.settings = {...vault.settings,openStartPageOnLogin:false,autoFill:false,clearClipboardSeconds:15,
    blacklist:['blocked.example.test'],inlineBlacklist:['inline.example.test'],
    inlineSilentRules:[{id:'silent-1',domain:'silent.example.test',reason:'manual-hide',source:'manual',confidence:1,matchCount:1,createdAt:1,updatedAt:1}],
    autoTotpOrigins:['https://backup.example.test'],
    siteLoginSettings:{'https://backup.example.test':{autoSubmit:false,fillEnabled:true}},
    siteRules:[{id:'backup-rule',domain:'backup.example.test',source:'manual-binding',pageMode:'login',createdAt:1,updatedAt:1}],
    fillImportMappingTemplates:[{id:'backup-template',name:'Synthetic mapping',sourceType:'csv',category:'identity',countryCode:'US',headerSignature:'Name',columns:['Name'],overrides:[{column:'Name',key:'fullName'}],useCount:1,createdAt:1,updatedAt:1}],
    fillImportBatches:[{sourceKey:'synthetic-batch',sourceName:'synthetic.csv',sourceType:'csv',category:'identity',countryCode:'US',totalRows:20,importedCount:10,nextOffset:10,prefix:'Example',numberStart:1,numberPadding:2,order:'source',createdAt:1,updatedAt:1}]};
  return vault;
}
