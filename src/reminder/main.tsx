import { t, getLanguage } from '../shared/i18n';
import { initLanguage } from '../shared/i18n';
import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Bell, CheckCircle2 } from 'lucide-react';
import '../styles/typography.css';
import '../styles/reminders.css';
import './reminder.css';

interface Pending { id: string; revision: string; title: string; times: number[] }
function AlertWindow() {
  const [state, setState] = useState<{ enabled: boolean; locked: boolean; items: Pending[]; audio?: { error?: string } } | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'KEYPILOT_REMINDER_STATUS' });
      if (!result?.ok) throw new Error();
      setState(result);
    } catch { setError(t("暂时无法读取提醒，请重新打开插件重试。")); }
  }, []);
  useEffect(() => {
    void refresh(); const timer = setInterval(() => void refresh(), 2000);
    const changed = () => { void refresh(); }; chrome.storage.onChanged.addListener(changed);
    return () => { clearInterval(timer); chrome.storage.onChanged.removeListener(changed); };
  }, [refresh]);
  async function acknowledge(items: Pending[]) {
    setBusy(true); setError('');
    try {
      const result = await chrome.runtime.sendMessage({ type: 'KEYPILOT_REMINDER_ACK', targets: items.map(({ id, revision, times }) => ({ id, revision, times })) });
      if (!result?.ok) throw new Error();
      await refresh();
    } catch { setError(t("确认未成功，提醒仍保留，请重试。")); } finally { setBusy(false); }
  }
  const pending = state?.items ?? [];
  return <main className="kp-reminders reminder-alert">
    <header><h1>{pending.length ? <Bell size={25} /> : <CheckCircle2 size={25} />}{!state ? t("正在读取提醒…") : pending.length ? t("{0} 条提醒待确认", [pending.length]) : t("暂无待确认提醒")}</h1><p className="reminder-muted">{pending.length ? t("提示音每 15 秒播放一次，确认收到后停止。") : state?.enabled ? t("已确认的提醒不会重复响铃。") : t("浏览器提醒已关闭。")}</p></header>
    {error && <p className="reminder-error" role="alert">{error}</p>}
    {state?.audio?.error && pending.length > 0 && <p className="reminder-error" role="alert">{state.audio.error}</p>}
    {pending.length > 0 && <>{state?.locked && <p className="reminder-muted">{t("密码库已锁定，标题已隐藏。可直接确认收到，或打开提醒中心解锁查看。")}</p>}<div className="reminder-alert-list">{pending.map(item => <article key={item.id} className="reminder-alert-item"><h2>{item.title}</h2><p className="reminder-muted">{item.times.map(time => new Date(time).toLocaleString(getLanguage(), { hour12: false })).join('、')}</p><button type="button" disabled={busy} onClick={() => void acknowledge([item])}>{t("确认收到")}</button></article>)}</div><p className="reminder-muted">{t("直接关闭窗口不会确认；声音会继续，窗口稍后会再次出现。")}</p></>}
    <div className="reminder-alert-footer">{pending.length > 0 ? <button type="button" disabled={busy} className="reminder-primary" onClick={() => void acknowledge(pending)}>{t("全部确认收到")}</button> : <button type="button" onClick={() => window.close()}>{t("关闭窗口")}</button>}<button type="button" onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('vault.html#reminders') })}>{t("打开提醒中心")}</button></div>
    {pending.length > 0 && <p className="reminder-muted">{t("如果没有听到声音，请检查电脑音量，并在提醒中心试听提示音。")}</p>}
  </main>;
}
void initLanguage().then(() => { createRoot(document.getElementById('root')!).render(<AlertWindow />); });
