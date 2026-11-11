import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, QrCode, ShieldCheck } from 'lucide-react';
import { authorizeSensitiveAction } from './sensitiveActions';
import { generateTotp, parseTotpInput, validateTotpConfig } from './totp';
import { persistVaultSession } from './vault';
import type { Credential, TotpAccount, UnlockedVaultSession } from './types';
import type { TotpImportAccount } from './totpImport';
import './authenticator.css';
import { TotpAccountRow } from './TotpAccountRow';
import { useTotpClock } from './useTotpClock';

const TotpImportPanel = lazy(() => import('./TotpImportPanel'));

export function AuthenticatorPanel({ session, onChange, compact = false }: { session: UnlockedVaultSession; onChange: (session: UnlockedVaultSession) => void; compact?: boolean }) {
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<TotpAccount | 'new'>();
  const [importing, setImporting] = useState(false);
  const [removing, setRemoving] = useState<TotpAccount>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const now = useTotpClock();
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (removing) dialog.current?.showModal(); }, [removing]);
  const all = session.vault.totpAccounts ?? [];
  const active = all.filter(item => !item.deletedAt);
  const removed = all.filter(item => item.deletedAt);
  const filtered = active.filter(item => `${item.issuer} ${item.account}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  async function save(item: TotpAccount) {
    // Merge against the editing session so concurrent edits cannot silently overwrite it.
    const duplicate = active.find(other => other.id !== item.id && other.secret === item.secret && other.algorithm === item.algorithm && other.digits === item.digits && other.period === item.period);
    if (duplicate) throw new Error('这个动态验证码已存在，请查看已有记录。');
    const exists = all.some(other => other.id === item.id);
    const next = await persistVaultSession(session, { ...session.vault, totpAccounts: exists ? all.map(other => other.id === item.id ? item : other) : [...all, item] });
    onChange(next); setEditor(undefined); setNotice('身份验证器已保存。');
  }
  async function edit(item: TotpAccount) {
    try { if (await authorizeSensitiveAction() && alive.current) setEditor(item); }
    catch { setNotice('密码库已锁定，请重新解锁。'); }
  }
  async function importAccounts(accounts: TotpImportAccount[]) {
    const { importTotpAccounts } = await import('./totpImportStorage');
    const result = await importTotpAccounts(session, accounts);
    if (!alive.current) return;
    onChange(result.session); setImporting(false);
    setNotice(`已导入 ${result.added} 个账号。${result.skipped ? `已跳过 ${result.skipped} 个已存在的账号。` : ''}`);
  }
  async function changeRemoved(item: TotpAccount, deleted: boolean) {
    setBusy(true); setNotice('');
    try {
      const next = await persistVaultSession(session, { ...session.vault, totpAccounts: all.map(other => other.id === item.id ? { ...other, deletedAt: deleted ? Date.now() : undefined, updatedAt: Date.now() } : other) });
      onChange(next); setRemoving(undefined); setNotice(deleted ? '已移除，可在下方恢复。' : '已恢复身份验证器。');
    } catch { setNotice('保存失败，记录可能已在其他页面修改，请刷新后重试。'); }
    finally { setBusy(false); }
  }
  return <section className="kp-authenticator" aria-label="身份验证器">
    <header>{!compact && <div><h2><ShieldCheck size={24} />身份验证器</h2><p>管理网站的动态验证码，密钥保存在本地加密密码库中。</p></div>}
      {!editor && !importing && <div className="kp-totp-header-actions"><button type="button" onClick={() => { setImporting(true); setNotice(''); }}><QrCode size={18} />导入二维码</button><button type="button" className="primary" onClick={() => { setEditor('new'); setNotice(''); }}><Plus size={18} />添加验证码</button></div>}
    </header>
    {importing ? <Suspense fallback={<p role="status">正在打开导入…</p>}><TotpImportPanel existing={all} onImport={importAccounts} onCancel={() => setImporting(false)} /></Suspense> : editor ? <TotpEditor credentials={session.vault.credentials} key={typeof editor === 'string' ? 'new' : editor.id} item={editor === 'new' ? undefined : editor} onSave={save} onCancel={() => setEditor(undefined)} /> : <>
      {!!active.length && <input className="kp-totp-search" aria-label="搜索动态验证码" placeholder="搜索服务或账号" value={query} onChange={event => setQuery(event.target.value)} />}
      {!!active.length && <p className="kp-totp-count">{query.trim() ? `${filtered.length} 个匹配 · ` : ''}{active.length} 个验证码</p>}
      <div className="kp-totp-list">
        {filtered.map(item => <TotpAccountRow linkedName={session.vault.credentials.find(credential => credential.id === item.credentialId)?.title} key={`${item.id}:${item.updatedAt}:${session.vault.settings.requireMasterPasswordForReveal}`} item={item} now={now} requireVerification={session.vault.settings.requireMasterPasswordForReveal} onEdit={() => void edit(item)} onRemove={() => setRemoving(item)} />)}
        {!filtered.length && <p className="kp-totp-empty">{active.length ? '没有匹配的验证码，请换个关键词。' : '还没有动态验证码。可以导入 Google 或网站的二维码，也可以点击“添加验证码”输入密钥。'}</p>}
      </div>
      <details className="kp-totp-help"><summary>验证码无效？</summary><p>验证码按设备时间刷新。请检查系统日期和时间是否准确；临近过期时可等待下一组。</p></details>
      {!!removed.length && <details className="kp-totp-removed"><summary>已移除（{removed.length}）</summary>{removed.map(item => <div key={item.id}><span>{item.issuer || item.account} {item.issuer ? item.account : ''}</span><button type="button" disabled={busy} onClick={() => void changeRemoved(item, false)}>恢复</button></div>)}</details>}
    </>}
    {notice && <p role="status">{notice}</p>}
    {removing && <dialog ref={dialog} aria-labelledby="kp-totp-delete-title" onCancel={() => setRemoving(undefined)}>
      <h3 id="kp-totp-delete-title">移除身份验证器？</h3><p>{removing.issuer} · {removing.account}</p><p>移除后可在“已移除”中恢复。</p>
      <footer><button type="button" disabled={busy} onClick={() => setRemoving(undefined)}>取消</button><button type="button" disabled={busy} onClick={() => void changeRemoved(removing, true)}>确认移除</button></footer>
    </dialog>}
  </section>;
}

function TotpEditor({ item, onSave, onCancel, credentials }: { credentials: Credential[]; item?: TotpAccount; onSave: (item: TotpAccount) => Promise<void>; onCancel: () => void }) {
  const [input, setInput] = useState('');
  const [credentialId, setCredentialId] = useState(item?.credentialId ?? '');
  const [issuer, setIssuer] = useState(item?.issuer ?? '');
  const [account, setAccount] = useState(item?.account ?? '');
  const [algorithm, setAlgorithm] = useState<TotpAccount['algorithm']>(item?.algorithm ?? 'SHA1');
  const [digits, setDigits] = useState<6 | 8>(item?.digits ?? 6);
  const [period, setPeriod] = useState(item?.period ?? 30);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  function readLink() {
    try { const parsed = parseTotpInput(input); setInput(parsed.secret); setIssuer(parsed.issuer || issuer); setAccount(parsed.account || account); setAlgorithm(parsed.algorithm); setDigits(parsed.digits); setPeriod(parsed.period); setError(''); }
    catch (err) { setError(err instanceof Error ? err.message : '无法读取链接。'); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      const uri = /^otpauth:/i.test(input.trim()) ? parseTotpInput(input) : undefined;
      const config = uri ?? validateTotpConfig({secret: input.trim() || item?.secret || '', algorithm, digits, period});
      const nextAccount = account.trim() || uri?.account || '';
      const nextIssuer = issuer.trim() || uri?.issuer || '';
      if (!nextAccount) throw new Error('请填写账号名称，或粘贴包含账号的设置链接。');
      if (nextAccount.length > 200 || nextIssuer.length > 200) throw new Error('服务名称和账号最多 200 个字符。');
      await generateTotp(config);
      await onSave({ ...item, credentialId: credentialId || undefined, id: item?.id ?? crypto.randomUUID(), createdAt: item?.createdAt ?? Date.now(), updatedAt: Date.now(), ...config, issuer: nextIssuer, account: nextAccount });
      setInput('');
    } catch (err) { setError(err instanceof Error && !/VAULT_/.test(err.message) ? err.message : '保存失败，密码库可能已锁定或记录已被修改。'); }
    finally { setBusy(false); }
  }
  return <form className="kp-totp-editor" onSubmit={event => void submit(event)} autoComplete="off">
    <h3>{item ? '编辑身份验证器' : '添加动态验证码'}</h3>
    <label>密钥或 otpauth 链接<input type="password" autoComplete="off" spellCheck={false} maxLength={4096} value={input} onChange={event => setInput(event.target.value)} placeholder={item ? '留空保留原密钥' : '粘贴网站提供的密钥或 otpauth://totp/ 链接'} /></label>
    <button type="button" className="kp-totp-read" disabled={!input || busy} onClick={readLink}>读取密钥或链接</button>
    <div className="kp-totp-form-grid"><label>服务名称<input value={issuer} maxLength={200} onChange={event => setIssuer(event.target.value)} placeholder="例如 GitHub" /></label><label>账号<input value={account} maxLength={200} onChange={event => setAccount(event.target.value)} placeholder="邮箱或账号名称" /></label></div>
    <label>关联登录账号<select value={credentialId} onChange={event=>setCredentialId(event.target.value)}><option value="">暂不关联</option>{credentials.map(credential=><option key={credential.id} value={credential.id}>{credential.title} · {credential.username} · {credential.domain}</option>)}</select></label>
    <details><summary>高级参数</summary><div className="kp-totp-form-grid">
      <label>算法<select value={algorithm} onChange={event => setAlgorithm(event.target.value as TotpAccount['algorithm'])}><option>SHA1</option><option>SHA256</option><option>SHA512</option></select></label>
      <label>验证码位数<select value={digits} onChange={event => setDigits(Number(event.target.value) as 6 | 8)}><option value={6}>6 位</option><option value={8}>8 位</option></select></label>
      <label>刷新周期（秒）<input type="number" min={1} max={86400} value={period} onChange={event => setPeriod(Number(event.target.value))} /></label>
    </div></details>
    {error && <p role="alert">{error}</p>}
    <footer><button type="button" disabled={busy} onClick={onCancel}>取消</button><button type="submit" disabled={busy} className="primary">{busy ? '正在保存…' : '保存身份验证器'}</button></footer>
  </form>;
}
