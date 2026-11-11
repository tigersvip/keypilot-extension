import { Bell, Plus } from 'lucide-react';
import type { Credential, Reminder } from './types';

export function AccountReminders({credential,reminders}:{credential:Credential;reminders:Reminder[]}) {
  const linked=reminders.filter(item=>item.credentialId===credential.id);
  const active=linked.filter(item=>!item.completedAt).sort((a,b)=>a.dueAt-b.dueAt);
  return <section className="detail-reminder" aria-label="账号到期提醒">
    <div><h3><Bell size={18} aria-hidden="true"/>到期提醒</h3>
      <p>{active.length?`${active.length} 条未完成提醒`:'为这个账号设置续费或到期提醒。'}</p>
      {active.slice(0,2).map(item=><p key={item.id}>{item.title} · <time dateTime={new Date(item.dueAt).toISOString()}>{new Date(item.dueAt).toLocaleString('zh-CN',{hour12:false})}</time></p>)}
    </div>
    <div className="account-reminder-actions">
      {linked.length>0&&<a href={`vault.html?reminderAccount=${encodeURIComponent(credential.id)}#reminders`}>查看 {linked.length} 条提醒</a>}
      <button type="button" onClick={()=>{window.location.href=`vault.html?reminderFor=${encodeURIComponent(credential.id)}#reminders`;}}><Plus size={17} aria-hidden="true"/>添加到期提醒</button>
    </div>
  </section>;
}
