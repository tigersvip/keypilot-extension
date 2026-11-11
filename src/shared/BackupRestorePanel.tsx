import { useEffect, useMemo, useRef, useState } from 'react';
import { backupMergeSummary, backupMergeConflicts, initializeVaultFromBackup, previewBackup, restoreBackup, type BackupPreview } from './backup';
import type { BackupConflictChoice, BackupConflictChoices } from './backupMerge';
import { backupSettingsChanges, type BackupSettingsSelection } from './backupSettings';
import { BackupContents } from './BackupContents';
import { getRecoverySnapshots, type RecoverySnapshot } from './storage';
import type { UnlockedVaultSession } from './types';
import './shared-ui.css';
import './credential-security.css';

export function InitialBackupRestore({ onRestored }: { onRestored: (session: UnlockedVaultSession) => void }) {
  return <details className="kp-initial-restore"><summary>已有备份？直接恢复</summary><BackupRestorePanel onRestored={onRestored} /></details>;
}

export function BackupRestorePanel({ session, onRestored }: { session?: UnlockedVaultSession; onRestored: (session: UnlockedVaultSession) => void }) {
  const [file, setFile] = useState<File>();
  const [password, setPassword] = useState('');
  const [preview, setPreview] = useState<BackupPreview>();
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [selected, setSelected] = useState<BackupSettingsSelection>({});
  const [choices, setChoices] = useState<BackupConflictChoices>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [snapshots, setSnapshots] = useState<RecoverySnapshot[]>([]);
  const alive = useRef(true), processing = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    if (session) void getRecoverySnapshots().then(value => { if (active) setSnapshots(value ?? []); });
    return () => { active = false; };
  }, [session?.encryptedVault]);
  const current = preview?.currentVault;
  const summary = useMemo(() => preview && current ? backupMergeSummary(current, preview.vault, choices) : [], [preview, current, choices]);
  const conflicts = useMemo(() => preview && current ? backupMergeConflicts(current, preview.vault, choices) : [], [preview, current, choices]);
  const settingChanges = useMemo(() => preview && current ? backupSettingsChanges(current.settings, preview.vault.settings) : [], [preview, current]);

  async function inspect() {
    if (processing.current) return;
    if (!file || !password) { setMessage('请选择备份并输入备份对应的主密码。'); return; }
    processing.current = true; setBusy(true); setMessage(''); setPreview(undefined); setSelected({}); setChoices({});
    try {
      const result = await previewBackup(file, password, session);
      if (alive.current) { setPreview(result); setPassword(''); }
    } catch { if (alive.current) setMessage('无法读取备份：请检查主密码、文件格式及版本；密码库已锁定时请重新解锁。'); }
    finally { processing.current = false; if (alive.current) setBusy(false); }
  }

  async function restore() {
    if (!preview || processing.current) return;
    if (session && mode === 'replace' && !window.confirm('替换当前密码库？替换前会保存加密恢复点，恢复后使用备份对应的主密码。')) return;
    processing.current = true; setBusy(true);
    try {
      const next = session ? await restoreBackup(preview, mode, session, selected, choices) : await initializeVaultFromBackup(preview);
      if (!alive.current) return;
      setPreview(undefined); setFile(undefined); setPassword('');
      const total = `登录账号 ${next.vault.credentials.length} · 身份验证器 ${next.vault.totpAccounts?.length ?? 0} · 填表资料 ${next.vault.fillProfiles?.length ?? 0}`;
      setMessage(session && mode === 'merge'
        ? `合并完成，保留当前主密码${Object.values(selected).some(Boolean) ? '，已恢复勾选的配置' : '和设置'}。${total}`
        : `恢复完成，数据和设置已恢复，请使用备份对应的主密码。${total}`);
      onRestored(next);
    } catch (error) {
      if (alive.current) { setPreview(undefined); setMessage(error instanceof Error ? error.message : '恢复失败，请重新预览备份。'); }
    } finally { processing.current = false; if (alive.current) setBusy(false); }
  }

  function download(snapshot: RecoverySnapshot) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot.vault)], { type:'application/json' }));
    const link = document.createElement('a'); link.href=url; link.download='keypilot-recovery-'+snapshot.createdAt+'.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="kp-backup-panel" aria-label="恢复完整加密备份">
    <h3>恢复完整加密备份</h3>
    <p>{session ? '先预览，再选择合并或替换。恢复前保留最近 3 份加密恢复点。' : '无需先创建密码库。选择完整加密备份，输入它对应的主密码，即可恢复数据、2FA 和设置。'}</p>
    <label>备份文件<input type="file" accept=".json,application/json" disabled={busy} onChange={event => {setFile(event.target.files?.[0]);setPreview(undefined);setMessage('');}} /></label>
    <label>备份主密码<input type="password" autoComplete="off" value={password} disabled={busy} onChange={event => {setPassword(event.target.value);setPreview(undefined);}} /></label>
    <button type="button" disabled={busy} onClick={() => void inspect()}>{busy ? '处理中…' : '预览备份'}</button>
    {preview && <div className="kp-backup-preview">
      <strong>{file?.name}</strong>
      <BackupContents vault={preview.vault} />
      {session ? <>
        <fieldset><legend>恢复方式</legend>
          <label><input type="radio" name="restore-mode" disabled={busy} checked={mode==='merge'} onChange={() => setMode('merge')} />合并：保留现有数据和主密码</label>
          <label><input type="radio" name="restore-mode" disabled={busy} checked={mode==='replace'} onChange={() => setMode('replace')} />替换：使用备份的数据、主密码和全部设置</label>
        </fieldset>
        {mode === 'merge' && <>
          <div className="kp-backup-table-wrap"><table aria-label="合并预览"><thead><tr><th>类别</th><th>预计新增</th><th>重复</th><th>冲突</th></tr></thead><tbody>
            {summary.filter(item => item.added + item.duplicates + item.conflicts > 0).map(item => <tr key={item.key}><th scope="row">{item.label}</th><td>{item.added}</td><td>{item.duplicates}</td><td>{item.conflicts}</td></tr>)}
          </tbody></table></div>
          <p>重复记录跳过。冲突默认保留两份，可在下方逐条选择；相同 2FA 密钥和生成参数保留现有记录。</p>
          {!!conflicts.length && <fieldset className="kp-backup-conflicts"><legend>逐条处理冲突</legend>{conflicts.map((item,index)=><label key={item.key}><span>{item.label} · 备份：{item.incoming}</span><small>本机：{item.current}</small><select aria-label={`冲突 ${index+1} 的处理方式`} disabled={busy} value={item.choice} onChange={event=>setChoices(previous=>({...previous,[item.key]:event.target.value as BackupConflictChoice}))}><option value="both">两份都留</option><option value="current">保留现有</option><option value="incoming">使用备份</option></select></label>)}</fieldset>}
          <fieldset><legend>同时恢复配置（可选）</legend>
            <p>勾选后，用备份中的对应配置替换本机配置；未勾选的保持不变。</p>
            {settingChanges.map(group => <label key={group.key}><input type="checkbox" disabled={busy} checked={!!selected[group.key]} onChange={event => setSelected(previous => ({...previous,[group.key]:event.target.checked}))} />{group.label}<span>（{group.changed} 项差异）</span></label>)}
          </fieldset>
        </>}
      </> : <p>恢复后使用备份对应的主密码，包含全部已保存的数据和设置。</p>}
      <div className="kp-backup-actions"><button className="kp-backup-primary" type="button" disabled={busy} onClick={() => void restore()}>{session ? `确认${mode==='merge'?'合并':'替换'}` : '恢复到本机'}</button>
      <button type="button" disabled={busy} onClick={() => setPreview(undefined)}>取消</button></div>
    </div>}
    {message && <p role="status">{message}</p>}
    {!!snapshots.length && <details><summary>下载加密恢复点</summary>{snapshots.map(snapshot => <button type="button" key={snapshot.createdAt} onClick={() => download(snapshot)}>{new Date(snapshot.createdAt).toLocaleString()}</button>)}<p>恢复点仍由当时的主密码保护；下载后可在上方预览恢复。</p></details>}
  </section>;
}
