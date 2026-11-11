import { useState } from 'react';
import { Volume2 } from 'lucide-react';
import { previewReminderSound } from './reminderAudio';
import { reminderSounds, type ReminderSound } from './reminders';
import { persistVaultSession } from './vault';
import type { UnlockedVaultSession, VaultSettings } from './types';
import '../styles/reminders.css';

export function ReminderSettings({ session, onChange }: { session: UnlockedVaultSession; onChange: (session: UnlockedVaultSession) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const settings = session.vault.settings;
  async function update(patch: Partial<VaultSettings>) {
    setBusy(true); setError('');
    try { onChange(await persistVaultSession(session, { ...session.vault, settings: { ...settings, ...patch } })); }
    catch { setError('设置保存失败，请确认密码库已解锁后重试。'); }
    finally { setBusy(false); }
  }
  return <div className="kp-reminders reminder-settings">
    <label className="reminder-enable"><input type="checkbox" checked={settings.remindersEnabled === true} disabled={busy} onChange={event => void update({ remindersEnabled: event.target.checked })} /><span>开启浏览器提醒</span></label>
    <p className="reminder-muted">到点弹出提醒，每 15 秒响一次，点击“确认收到”后停止。关闭提醒窗口不会确认事项。</p>
    <div className="reminder-sound-controls">
      <label>提示音<select aria-label="提示音" value={settings.reminderSound ?? 'chime'} disabled={busy} onChange={event => void update({ reminderSound: event.target.value as ReminderSound })}>{reminderSounds.map(sound => <option key={sound.id} value={sound.id}>{sound.label}</option>)}</select></label>
      <label>提醒音量<select aria-label="提醒音量" value={settings.reminderVolume ?? 60} disabled={busy} onChange={event => void update({ reminderVolume: Number(event.target.value) })}>{[10, 30, 60, 80, 100].map(value => <option value={value} key={value}>{value}%</option>)}</select></label>
      <button type="button" onClick={() => { setError(''); void previewReminderSound(settings.reminderSound ?? 'chime', settings.reminderVolume ?? 60).catch(() => setError('声音未能播放，请检查浏览器和系统音量。')); }}><Volume2 size={17} />试听</button>
    </div>
    <p className="reminder-muted">四种声音均在本地合成，不附带音频文件。请先试听并确认电脑有声音。</p>
    <p className="reminder-muted">浏览器需保持运行；完全退出、电脑休眠或静音时无法保证响铃。重新启动后会补提醒。关闭功能会停止响铃，并保留已有事项。</p>
    <p className="reminder-muted">提醒标题保存在加密密码库中；本机仅另存提醒时间、确认状态及声音设置，以便锁定时继续提醒。</p>
    {error && <p role="alert" className="reminder-error">{error}</p>}
  </div>;
}
