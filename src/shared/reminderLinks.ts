import type { Credential } from './types';

// Only unique, exact host/title evidence can suggest a link. The draft remains
// editable; never inspect credential passwords or retain the pasted source.
export function suggestReminderCredential(title:string,credentials:Credential[]):string|undefined {
  const text=title.normalize('NFKC').toLocaleLowerCase();
  const matches=credentials.filter(credential=>{
    let host='';try{host=new URL(credential.url).hostname.toLowerCase();}catch{return false;}
    const escaped=host.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const exactHost=host&&new RegExp('(^|[^a-z0-9.-])'+escaped+'($|[^a-z0-9.-])','i').test(text);
    const clean=text.replace(/\s*[·：:]?\s*(到期|续费|expiry|expires?)\s*$/i,'').trim();
    return exactHost||Boolean(clean&&clean===credential.title.normalize('NFKC').trim().toLocaleLowerCase());
  });
  return matches.length===1?matches[0].id:undefined;
}
