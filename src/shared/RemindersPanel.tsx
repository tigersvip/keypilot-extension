import { suggestReminderCredential } from './reminderLinks';
import { useEffect, useRef, useState } from 'react';
import { Bell, Check, Pencil, Plus, Trash2 } from 'lucide-react';
import { ReminderSettings } from './ReminderSettings';
import { parseReminderText, type ReminderCandidate } from './reminderParser';
import { dateFromInput, localDateInput, REMINDER_INDEX_KEY, REMINDER_LIMIT, reminderIsPending, reminderTimes, validateReminder } from './reminders';
import { persistVaultSession, restoreCachedVaultSession } from './vault';
import type { Reminder, UnlockedVaultSession, VaultPlain } from './types';
import '../styles/reminders.css';

type Draft = ReminderCandidate & { selected: boolean; credentialId?: string };
type Filter = 'pending' | 'upcoming' | 'all' | 'completed';
export function RemindersPanel({ session, onChange }: { session: UnlockedVaultSession; onChange: (session: UnlockedVaultSession) => void }) {
  const [linked] = useState(() => new URLSearchParams(window.location.search).get('reminderFor'));
  const [accountFilter,setAccountFilter]=useState(()=>new URLSearchParams(window.location.search).get('reminderAccount')??'');
  const credential = session.vault.credentials.find(item => item.id === linked);
  const accounts=new Map(session.vault.credentials.map(item=>[item.id,item]));
  const [form, setForm] = useState<'new' | 'paste' | null>(credential ? 'new' : null);
  const [editing, setEditing] = useState<Reminder | null>(null);
  const [title, setTitle] = useState(credential ? `${credential.title} · 到期` : '');
  const [date, setDate] = useState(''), [leadDays, setLeadDays] = useState(0), [credentialId, setCredentialId] = useState(credential?.id ?? '');
  const [text, setText] = useState(''), [drafts, setDrafts] = useState<Draft[]>([]);
  const [filter, setFilter] = useState<Filter>('all'), [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [limit, setLimit] = useState(100), [now, setNow] = useState(Date.now());
  const editorRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if(!linked&&!accountFilter)return;
    const url = new URL(window.location.href);

    url.searchParams.delete('reminderFor');url.searchParams.delete('reminderAccount');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, [linked, accountFilter]);
  useEffect(() => {
    if (!form || !session.vault.settings.remindersEnabled) return;
    const editor = editorRef.current;
    editor?.scrollIntoView({ block: 'start' });
    editor?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea')?.focus({ preventScroll: true });
  }, [form, editing?.id, session.vault.settings.remindersEnabled]);
  useEffect(() => {
    let disposed = false;
    const refresh = () => { setNow(Date.now()); void restoreCachedVaultSession().then(next => { if (next && !disposed) onChange(next); }).catch(() => undefined); };
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => { if (area === 'local' && changes[REMINDER_INDEX_KEY]) refresh(); };
    const timer = setInterval(() => setNow(Date.now()), 15000);
    chrome.storage?.onChanged.addListener(changed); window.addEventListener('focus', refresh);
    return () => { disposed = true; clearInterval(timer); chrome.storage?.onChanged.removeListener(changed); window.removeEventListener('focus', refresh); };
  }, [onChange]);
  const allItems=session.vault.reminders??[];
  const items=allItems.filter(item=>!accountFilter||item.credentialId===accountFilter);
  const selected = drafts.filter(item => item.selected);
  const counts = { all: items.length, pending: items.filter(item => reminderIsPending(item, now)).length,
    upcoming: items.filter(item => !item.completedAt && reminderTimes(item).some(time => time > now && !item.acknowledged.includes(time))).length,
    completed: items.filter(item => item.completedAt).length };
  const shown = items.filter(item => (!search || [item.title,accounts.get(item.credentialId??'')?.title,accounts.get(item.credentialId??'')?.domain].filter(Boolean).join(' ').toLowerCase().includes(search.trim().toLowerCase())) && (filter === 'all' ||
    filter === 'pending' && reminderIsPending(item, now) || filter === 'completed' && item.completedAt ||
    filter === 'upcoming' && !item.completedAt && reminderTimes(item).some(time => time > now && !item.acknowledged.includes(time))))
    .sort((a, b) => Number(reminderIsPending(b, now)) - Number(reminderIsPending(a, now)) || a.dueAt - b.dueAt);
  async function save(change: (vault: VaultPlain) => VaultPlain, message: string) {
    setBusy(true); setError('');
    try {
      const next = change(session.vault);
      if ((next.reminders?.length ?? 0) > REMINDER_LIMIT) throw new Error(`最多保存 ${REMINDER_LIMIT} 条提醒，请先清理已完成事项。`);
      next.reminders?.forEach(validateReminder);
      onChange(await persistVaultSession(session, next)); setNotice(message); return true;
    } catch (cause) { setError(cause instanceof Error && !cause.message.startsWith('VAULT_') ? cause.message : '保存失败，密码库可能已锁定或在其他页面发生修改，请重新打开后重试。'); return false; }
    finally { setBusy(false); }
  }
  function openNew() { setEditing(null); setTitle(accounts.get(accountFilter)?accounts.get(accountFilter)!.title+' · 到期':''); setDate(''); setLeadDays(0); setCredentialId(accounts.has(accountFilter)?accountFilter:''); setForm('new'); setError(''); setNotice(''); }
  async function submit() {
    const candidates = form === 'paste' ? selected : [{ title, date,credentialId }];
    if (!candidates.length) { setError('请至少选择一条提醒。'); return; }
    if (candidates.some(item => !item.title.trim() || dateFromInput(item.date) === null)) { setError('请补全选中事项的标题和有效日期。'); return; }
    if(candidates.some(item=>item.credentialId&&!accounts.has(item.credentialId))){setError('关联账号已不可用，请重新选择或取消关联。');return;}
    const timestamp = Date.now();
    const additions: Reminder[] = candidates.map(item => ({
      id: editing?.id ?? crypto.randomUUID(), revision: crypto.randomUUID(), title: item.title.trim(), dueAt: dateFromInput(item.date)!, leadDays,
      credentialId: item.credentialId || undefined, acknowledged: [], createdAt: editing?.createdAt ?? timestamp, updatedAt: timestamp
    }));
    if (await save(vault => ({ ...vault, reminders: [...(vault.reminders ?? []).filter(item => item.id !== editing?.id), ...additions] }), `已保存 ${additions.length} 条提醒。`)) {
      setForm(null); setText(''); setDrafts([]); setEditing(null);
    }
  }
  async function acknowledge(item: Reminder) {
    setBusy(true); setError('');
    try {
      const result = await chrome.runtime.sendMessage({ type: 'KEYPILOT_REMINDER_ACK', targets: [{ id: item.id, revision: item.revision, times: reminderTimes(item).filter(time => time <= Date.now()) }] });
      if (!result?.ok) throw new Error();
      const next = await restoreCachedVaultSession(); if (next) onChange(next);
      setNotice('已确认收到。后续提醒时间仍然保留。');
    } catch { setError('确认失败，请重试。'); } finally { setBusy(false); }
  }
  return <section className="kp-reminders reminder-center" aria-label="提醒中心">
    <header className="reminder-heading"><div><h1><Bell size={24} />提醒中心</h1><p className="reminder-muted">到期事项集中管理，重要的事及时确认。</p></div><div className="reminder-actions"><button disabled={!session.vault.settings.remindersEnabled || busy} onClick={() => { setForm('paste'); setEditing(null); setError(''); setNotice(''); }} type="button">粘贴文字识别</button><button className="reminder-primary" disabled={!session.vault.settings.remindersEnabled || busy} onClick={openNew} type="button"><Plus size={18} />新建提醒</button></div></header>
    <details className="reminder-config" open={session.vault.settings.remindersEnabled ? undefined : true}><summary>提醒开关与声音{!session.vault.settings.remindersEnabled && ' · 当前已关闭'}</summary><ReminderSettings session={session} onChange={onChange} /></details>
    {error && <p className="reminder-error" role="alert">{error}</p>}{notice && <p className="reminder-notice" role="status">{notice}</p>}
    {form && session.vault.settings.remindersEnabled && <form ref={editorRef} className="reminder-editor" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <h2>{editing ? '编辑提醒' : form === 'paste' ? '从文字创建提醒' : '新建提醒'}</h2>
      {form === 'paste' ? <>
        <label>粘贴待办或到期信息<textarea aria-label="粘贴待办或到期信息" rows={6} maxLength={50000} value={text} placeholder={'例如：\n服务器 A 到期时间 2026-11-17\n服务器 B 到期时间 2026-12.1'} onChange={event => { setText(event.target.value); setDrafts([]); }} /></label>
        <p className="reminder-muted">本地识别常见数字日期、中文日期、今天／明天／几天后。未注明时间暂设 09:00；有歧义的日期需手动填写。账号、密码行不作为提醒标题保存。</p>
        <button type="button" disabled={busy || !text.trim()} onClick={() => { setError(''); try { const parsed = parseReminderText(text); setDrafts(parsed.map(item => ({ ...item, selected: true,credentialId:suggestReminderCredential(item.title,session.vault.credentials) }))); if (!parsed.length) setError('没有找到可识别的日期，请补充年月日或手动新建。'); } catch (cause) { setError((cause as Error).message); } }}>识别并预览</button>
        {drafts.length > 0 && <div className="reminder-preview"><p>识别到 {drafts.length} 条，请核对标题和日期后保存。</p>{drafts.map((item, index) => <div className="reminder-draft" key={index}>
          <label className="reminder-draft-check"><input type="checkbox" checked={item.selected} onChange={event => setDrafts(current => current.map((value, i) => i === index ? { ...value, selected: event.target.checked } : value))} />事项 {index + 1}</label>
          <label>标题<input aria-label={`事项 ${index + 1} 标题`} maxLength={200} value={item.title} onChange={event => { const value = event.target.value; setDrafts(current => current.map((item, i) => i === index ? { ...item, title: value } : item)); }} /></label>
          <label>到期时间<input type="datetime-local" step="1" aria-label={`事项 ${index + 1} 到期时间`} value={item.date} onChange={event => { const value = event.target.value; setDrafts(current => current.map((item, i) => i === index ? { ...item, date: value, issue: undefined } : item)); }} /></label>
          <label>关联账号（请核对）<select aria-label={`事项 ${index+1} 关联账号`} value={item.credentialId??''} onChange={event=>{const value=event.target.value;setDrafts(current=>current.map((item,i)=>i===index?{...item,credentialId:value||undefined}:item));}}><option value="">不关联</option>{session.vault.credentials.map(account=><option key={account.id} value={account.id}>{account.title} · {account.username} · {account.domain}</option>)}</select></label>
          <p className={item.issue ? 'reminder-error' : 'reminder-muted'}>{item.source} · {item.issue || item.note}</p>
        </div>)}</div>}
      </> : <div className="reminder-form-grid"><label>提醒标题<input aria-label="提醒标题" required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></label><label>到期时间<input aria-label="到期时间" required type="datetime-local" step="1" value={date} onChange={event => setDate(event.target.value)} /></label><label>关联账号（可选）<select value={credentialId} onChange={event => setCredentialId(event.target.value)}><option value="">不关联</option>{credentialId&&!accounts.has(credentialId)&&<option value={credentialId}>原关联账号已不可用，请重新选择</option>}{session.vault.credentials.map(item => <option value={item.id} key={item.id}>{item.title} · {item.username} · {item.domain}</option>)}</select></label></div>}
      <label className="reminder-lead">提醒方式<select aria-label="提醒方式" value={leadDays} onChange={event => setLeadDays(Number(event.target.value))}><option value={0}>仅到期时提醒</option><option value={1}>提前 1 天 + 到期时</option><option value={3}>提前 3 天 + 到期时</option><option value={7}>提前 7 天 + 到期时</option></select></label>
      <p className="reminder-muted">按电脑本地时间保存。已过的提醒时间会立即补提醒；编辑日期会重新开始确认。</p>
      <div className="reminder-actions"><button type="submit" className="reminder-primary" disabled={busy || form === 'paste' && !drafts.length}>{busy ? '正在保存…' : form === 'paste' ? `保存选中 ${selected.length} 条` : '保存提醒'}</button><button type="button" disabled={busy} onClick={() => { setForm(null); setText(''); setDrafts([]); setError(''); }}>取消</button></div>
    </form>}
    <label className="reminder-account-filter">关联账号<select aria-label="按关联账号筛选提醒" value={accountFilter} onChange={event=>{setAccountFilter(event.target.value);setLimit(100);}}><option value="">全部账号和未关联事项</option>{accountFilter&&!accounts.has(accountFilter)&&<option value={accountFilter}>原关联账号已不可用</option>}{session.vault.credentials.map(account=><option key={account.id} value={account.id}>{account.title} · {account.domain}</option>)}</select></label>
    <div className="reminder-list-bar"><nav aria-label="提醒分类">{([['all', '全部'], ['pending', '待确认'], ['upcoming', '即将提醒'], ['completed', '已完成']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => { setFilter(value); setLimit(100); }}>{label} <span>{counts[value]}</span></button>)}</nav><input type="search" aria-label="搜索提醒" placeholder="搜索提醒" value={search} onChange={event => { setSearch(event.target.value); setLimit(100); }} /></div>
    <div className="reminder-list">{shown.slice(0, limit).map(item => <article className="reminder-row" key={item.id}>
      <Bell size={19} className={reminderIsPending(item, now) ? 'reminder-due' : 'reminder-muted'} /><div className="reminder-row-copy"><h2>{item.title}</h2>{item.credentialId&&(accounts.has(item.credentialId)?<a className="reminder-account-link" href={`vault.html?loginFor=${encodeURIComponent(item.credentialId)}#logins`}>查看账号：{accounts.get(item.credentialId)!.title} · {accounts.get(item.credentialId)!.domain}</a>:<small className="reminder-muted">原关联账号已不可用</small>)}<p><time dateTime={new Date(item.dueAt).toISOString()}>{new Date(item.dueAt).toLocaleString('zh-CN', { hour12: false })}</time>{item.leadDays > 0 && ` · 提前 ${item.leadDays} 天提醒`}</p><span className={reminderIsPending(item, now) ? 'reminder-due' : 'reminder-muted'}>{item.completedAt ? '已完成' : reminderIsPending(item, now) ? '待确认' : reminderTimes(item).every(time => item.acknowledged.includes(time)) ? '已确认收到' : '等待提醒'}</span></div>
      <div className="reminder-row-actions">{reminderIsPending(item, now) && session.vault.settings.remindersEnabled && <button type="button" disabled={busy} onClick={() => void acknowledge(item)}>确认收到</button>}{!item.completedAt && <button type="button" disabled={busy} aria-label={`完成 ${item.title}`} title="完成事项，取消后续提醒" onClick={() => void save(vault => ({ ...vault, reminders: vault.reminders?.map(value => value.id === item.id ? { ...value, completedAt: Date.now(), updatedAt: Date.now() } : value) }), '事项已完成，后续提醒已取消。')}><Check size={17} /></button>}
      <button type="button" disabled={busy} aria-label={`编辑 ${item.title}`} onClick={() => { setEditing(item); setTitle(item.title); setDate(localDateInput(item.dueAt)); setLeadDays(item.leadDays); setCredentialId(item.credentialId ?? ''); setForm('new'); setError(''); }}><Pencil size={17} /></button>
      <button type="button" disabled={busy} aria-label={`删除 ${item.title}`} onClick={() => { if (window.confirm(`删除“${item.title}”？此事项的后续提醒也会取消。`)) void save(vault => ({ ...vault, reminders: vault.reminders?.filter(value => value.id !== item.id) }), '提醒已删除。'); }}><Trash2 size={17} /></button></div>
    </article>)}{!shown.length && <p className="reminder-empty">{items.length ? '没有符合条件的提醒。' : '还没有提醒。开启后，可以手动新建或粘贴文字批量识别。'}</p>}</div>
    {shown.length > limit && <button type="button" onClick={() => setLimit(limit + 100)}>显示更多</button>}
  </section>;
}
