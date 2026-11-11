import { UI_FONT } from '../shared/uiTypography';
import type { FillChoice, QuickFillProfileOptions } from '../shared/quickFill';
export type FormControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
export interface ReviewRow {
  label: string;
  target?: string;
  action: 'fill' | 'replace' | 'skip' | 'missing';
  value: string;
  secret: boolean;
}
interface ControlState { control: FormControl; value: string; checked?: boolean; selected?: boolean[] }
interface UndoEntry { before: ControlState; after: ControlState }
let panel: HTMLElement | null = null;
let cancelPending: (() => void) | undefined;
let expiry: ReturnType<typeof setTimeout> | undefined;
let undoEntries: UndoEntry[] = [];
const read = (control: FormControl): ControlState => ({
  control, value: control.value,
  checked: control instanceof HTMLInputElement && ['checkbox','radio'].includes(control.type) ? control.checked : undefined,
  selected: control instanceof HTMLSelectElement ? Array.from(control.options).map(option => option.selected) : undefined
});
const same = (left: ControlState, right: ControlState) => left.value === right.value && left.checked === right.checked && JSON.stringify(left.selected) === JSON.stringify(right.selected);
export function snapshotControls(): ControlState[] {
  return Array.from(document.querySelectorAll<FormControl>('input,textarea,select')).map(read);
}
export function rememberFill(before: ControlState[]) {
  undoEntries = before.filter(state => state.control.isConnected).map(state => ({before:state,after:read(state.control)})).filter(entry => !same(entry.before, entry.after));
}
export function undoLastFill(): { restored: number; skipped: number } {
  let restored = 0, skipped = 0;
  // Check all controls before changing radio groups, which can mutate their peers.
  const eligible = undoEntries.filter(entry => {
    if (!entry.before.control.isConnected || !same(read(entry.before.control), entry.after)) { skipped++; return false; }
    return true;
  });
  for (const {before} of eligible) {
    const control = before.control;
    if (control instanceof HTMLSelectElement) {
      Array.from(control.options).forEach((option, index) => { option.selected = before.selected?.[index] ?? false; });
    } else if (before.checked !== undefined && control instanceof HTMLInputElement) control.checked = before.checked;
    else {
      const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype,'value')?.set?.call(control,before.value);
    }
    control.dispatchEvent(new Event('input',{bubbles:true}));
    control.dispatchEvent(new Event('change',{bubbles:true}));
    restored++;
  }
  undoEntries = [];
  return {restored,skipped};
}
export function clearFillReview() {
  cancelPending?.(); cancelPending=undefined;
  clearTimeout(expiry); panel?.remove(); panel=null; undoEntries=[];
}
function createPanel(title: string) {
  panel?.remove();
  panel=document.createElement('div');
  panel.id='keypilot-fill-review';
  panel.style.cssText='position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:rgba(15,23,42,.28)';
  const root=panel.attachShadow({mode:'closed'});
  root.innerHTML='<style>:host{font:15px '+UI_FONT+';color:#172338}section{background:white;border:1px solid #dbe3ee;border-radius:12px;padding:20px;width:min(620px,calc(100vw - 48px));max-height:80vh;overflow:auto;box-shadow:0 16px 48px #0002}h2{margin:0 0 12px;font-size:18px}p{line-height:1.6}table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:9px 6px;border-bottom:1px solid #e5eaf0;word-break:break-word}footer{display:flex;gap:8px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap}button{border:1px solid #cbd5e1;padding:8px 12px;border-radius:6px;background:#f8fafc;cursor:pointer;color:#173767}button.primary{background:#2563eb;color:white;border:0}button:disabled{opacity:.5;cursor:default}</style><section role="dialog" aria-modal="true"><h2></h2><div class="body"></div><footer></footer></section>';
  root.querySelector('h2')!.textContent=title;
  root.querySelector('h2')!.id='fill-heading';
  root.querySelector('section')!.setAttribute('aria-labelledby','fill-heading');
  panel.setAttribute('aria-label',title);
  document.documentElement.append(panel);
  return root;
}
export function focusFillReview(): boolean {
  if (!panel?.isConnected) return false;
  panel.dispatchEvent(new Event('keypilot-focus'));
  return true;
}

export function chooseFillOption(title: string, description: string, choices: FillChoice[]): Promise<string | null> {
  clearFillReview();
  return new Promise(resolve => {
    const previous=document.activeElement;
    const root=createPanel(title), host=panel!;
    const style=document.createElement('style');
    style.textContent='section{width:min(420px,calc(100vw - 48px));box-sizing:border-box}input,button{font:inherit}input{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:6px;padding:10px;margin-bottom:10px}p{margin:0 0 12px;color:#52647d}.choices{display:grid;gap:4px;max-height:42vh;overflow:auto}.choices button{text-align:left;display:grid;gap:3px;background:white;padding:10px 12px;overflow-wrap:anywhere}.choices button:focus,.choices button:hover{background:#edf3ff;color:#173767;outline:2px solid #2563eb;outline-offset:-2px}.choices small{color:#52647d;font-size:13px}';
    root.append(style);
    const body=root.querySelector('.body')!;
    const intro=document.createElement('p');intro.textContent=description;body.append(intro);
    const search=document.createElement('input');search.placeholder='搜索';search.setAttribute('aria-label','搜索填写项目');search.type='search';
    if(choices.length>5)body.append(search);
    const list=document.createElement('div');list.className='choices';body.append(list);
    let settled=false;
    const finish=(value:string|null)=>{
      if(settled)return;settled=true;cancelPending=undefined;clearTimeout(expiry);host.remove();if(panel===host)panel=null;
      if(previous instanceof HTMLElement && previous.isConnected)previous.focus({preventScroll:true});
      resolve(value);
    };
    cancelPending=()=>finish(null);
    const render=()=>{
      list.replaceChildren();
      for(const choice of choices.filter(item=>(item.label+' '+(item.detail??'')).toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()))){
        const button=document.createElement('button');button.type='button';
        const name=document.createElement('span');name.textContent=choice.label;button.append(name);
        if(choice.detail){const detail=document.createElement('small');detail.textContent=choice.detail;button.append(detail);}
        button.onclick=()=>finish(choice.id);list.append(button);
      }
      if(!list.childElementCount){const empty=document.createElement('p');empty.textContent='没有匹配的项目';list.append(empty);}
    };
    search.oninput=render;render();
    const cancel=document.createElement('button');cancel.textContent='取消';cancel.onclick=()=>finish(null);root.querySelector('footer')!.append(cancel);
    const focus=()=>{(search.isConnected?search:list.querySelector('button')??cancel).focus();};
    host.addEventListener('keypilot-focus',focus);
    root.addEventListener('keydown',event=>{
      const key=event as KeyboardEvent;
      if(key.isComposing || key.keyCode===229)return;
      if(key.key==='Escape'){key.preventDefault();key.stopPropagation();finish(null);}
      const buttons=Array.from(list.querySelectorAll('button'));
      if(key.key==='ArrowDown'||key.key==='ArrowUp'){
        key.preventDefault();const current=buttons.indexOf(root.activeElement as HTMLButtonElement);
        buttons[(current+(key.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();
      }
      if(key.key==='Enter' && root.activeElement===search){key.preventDefault();buttons[0]?.click();}
      if(key.key==='Tab'){
        const items=Array.from(root.querySelectorAll<HTMLElement>('input,button'));
        if(key.shiftKey && root.activeElement===items[0]){key.preventDefault();items.at(-1)?.focus();}
        else if(!key.shiftKey && root.activeElement===items.at(-1)){key.preventDefault();items[0]?.focus();}
      }
    });
    expiry=setTimeout(()=>finish(null),120000);focus();
  });
}

export function reviewFill(rows: ReviewRow[], apply: (isCurrent: () => boolean, remember: boolean) => void | Promise<void>, repair?: () => void, profile?: QuickFillProfileOptions & {switchProfile:()=>void}): Promise<boolean> {
  clearFillReview();
  return new Promise(resolve => {
    const previous=document.activeElement;
    const root=createPanel('预览填写内容');
    const host=panel!;let settled=false;
    const isCurrent=()=>!settled && panel===host && host.isConnected;
    const body=root.querySelector('.body')!;
    const intro=document.createElement('p');
    intro.textContent='确认后填写。敏感内容已遮挡；完成后 2 分钟内可撤销，之后手动修改的字段会保留。';
    body.append(intro);
    const table=document.createElement('table');
    const head=document.createElement('tr');
    for(const value of ['资料字段','网页字段','内容','操作']){const th=document.createElement('th');th.textContent=value;head.append(th);}table.append(head);
    const labels={fill:'填写',replace:'覆盖',skip:'跳过已有值',missing:'未匹配'};
    for(const row of rows){
      const tr=document.createElement('tr');
      for(const text of [row.label,row.target||'—',row.secret?'••••••':row.value,labels[row.action]]){const td=document.createElement('td');td.textContent=text;tr.append(td);}
      table.append(tr);
    }
    body.append(table);
    const footer=root.querySelector('footer')!;
    const finish=(ok:boolean) => {if(settled)return;settled=true;cancelPending=undefined;clearTimeout(expiry);host.remove();if(panel===host)panel=null;if(previous instanceof HTMLElement && previous.isConnected)previous.focus({preventScroll:true});resolve(ok);};
    cancelPending=()=>finish(false);
    const remember=document.createElement('input');remember.type='checkbox';remember.checked=profile?.remember??false;
    if(profile){
      const style=document.createElement('style');
      style.textContent='.profile{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}.profile strong{overflow-wrap:anywhere;flex:1}.preference{display:flex;align-items:flex-start;gap:8px;margin:12px 0;line-height:1.5;overflow-wrap:anywhere}input,button{font:inherit}.preference input{margin:5px 0;accent-color:#2563eb}button:focus-visible,input:focus-visible{outline:2px solid #2563eb;outline-offset:2px}section{box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden}.body{overflow:auto;min-height:0}h2,footer{flex-shrink:0}footer{border-top:1px solid #e5eaf0;padding-top:12px;margin-top:12px}@media(max-width:480px){section{padding:16px;max-height:90vh}th:nth-child(2),td:nth-child(2){display:none}td:first-child,th:first-child{min-width:58px}td:last-child,th:last-child{min-width:56px}footer{gap:6px}footer button{padding:8px;font-size:14px}}';root.append(style);
      const heading=document.createElement('div');heading.className='profile';
      const title=document.createElement('strong');title.textContent=profile.title;heading.append(title);
      if(profile.canSwitch){const change=document.createElement('button');change.textContent='切换资料';change.onclick=()=>{finish(false);profile.switchProfile();};heading.append(change);}
      body.prepend(heading);
      const label=document.createElement('label');label.className='preference';
      const text=document.createElement('span');text.textContent='设为此网站默认资料 · '+profile.origin;
      label.append(remember,text);body.append(label);
    }
    const cancel=document.createElement('button');cancel.textContent='取消';cancel.onclick=()=>finish(false);footer.append(cancel);
    if(repair){const button=document.createElement('button');button.textContent='校准未匹配字段';button.onclick=()=>{finish(false);repair();};footer.append(button);}
    const confirm=document.createElement('button');confirm.className='primary';
    const hasFill=rows.some(row=>row.action==='fill'||row.action==='replace');
    const updateConfirm=()=>{confirm.textContent=hasFill?'确认填写':'保存默认设置';confirm.disabled=!hasFill && (!profile || remember.checked===profile.remember);};
    remember.onchange=updateConfirm;updateConfirm();
    confirm.onclick=async()=>{confirm.disabled=true;cancel.focus();try{await apply(isCurrent,remember.checked);finish(true);}catch(error){intro.textContent=error instanceof Error?error.message:'网页已变化，请重新预览。';confirm.disabled=true;if(isCurrent())cancel.focus();}};
    footer.append(confirm);
    root.addEventListener('keydown',event=>{
      const key=event as KeyboardEvent;
      if(key.key==='Escape'){key.preventDefault();key.stopPropagation();finish(false);}
      if(key.key==='Tab'){
        const buttons=Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)'));
        const first=buttons[0],last=buttons[buttons.length-1];
        if(key.shiftKey && root.activeElement===first){key.preventDefault();last?.focus();}
        else if(!key.shiftKey && root.activeElement===last){key.preventDefault();first?.focus();}
      }
    });
    panel!.addEventListener('keypilot-focus',()=>{(confirm.disabled?cancel:confirm).focus();});
    (confirm.disabled?cancel:confirm).focus();expiry=setTimeout(()=>finish(false),120000);
  });
}
export function showFillResult(count:number,repair?:()=>void){
  clearTimeout(expiry);
  const root=createPanel('填写完成');
  panel!.style.cssText='position:fixed;right:20px;bottom:20px;z-index:2147483647';
  root.querySelector('section')!.removeAttribute('aria-modal');
  root.querySelector('.body')!.textContent=count?'已填写 '+count+' 个字段。可以撤销本次填写，或校准后重新预览。':'网页内容未改动。默认资料设置将在密码库中保存。';
  const footer=root.querySelector('footer')!;
  const undo=document.createElement('button');undo.textContent='撤销本次填写';
  undo.onclick=()=>{const result=undoLastFill();root.querySelector('.body')!.textContent='已撤销 '+result.restored+' 个字段，保留 '+result.skipped+' 个已被修改的字段。';undo.disabled=true;};
  footer.append(undo);
  if(repair){const button=document.createElement('button');button.textContent='校准字段';button.onclick=()=>{clearFillReview();repair();};footer.append(button);}
  const close=document.createElement('button');close.textContent='完成';close.onclick=()=>clearFillReview();footer.append(close);close.focus();
  expiry=setTimeout(clearFillReview,120000);
}

export function showRepairReady(retry: () => void) {
  clearFillReview();
  const root=createPanel('字段绑定已保存');
  root.querySelector('.body')!.textContent='现在可重新测试。登录账号只填写，不会自动提交；资料填写会重新显示预览。';
  const button=document.createElement('button');button.textContent='重新测试';button.className='primary';
  button.onclick=()=>{clearFillReview();retry();};
  const cancel=document.createElement('button');cancel.textContent='稍后';cancel.onclick=clearFillReview;
  root.querySelector('footer')!.append(cancel,button);button.focus();
  expiry=setTimeout(clearFillReview,120000);
}
