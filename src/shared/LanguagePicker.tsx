import { useState } from 'react';
import { Globe } from 'lucide-react';
import { languages, type LanguagePreference } from './language';
import { getLanguagePreference, saveLanguagePreference, t } from './i18n';
import { persistVaultSession, upsertVaultSettings } from './vault';
import type { UnlockedVaultSession } from './types';

export function LanguagePicker({ session }: { session?: UnlockedVaultSession | null }) {
  const [value, setValue] = useState<LanguagePreference>(getLanguagePreference());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function apply() {
    setBusy(true); setError('');
    try {
      if (session) await persistVaultSession(session, upsertVaultSettings(session.vault, { language: value }));
      await saveLanguagePreference(value);
      window.location.reload();
    } catch {
      setError(t('语言设置保存失败，请重新解锁后重试。')); setBusy(false);
    }
  }
  return <div className="kp-language-picker">
    <label htmlFor="kp-language"><Globe size={18} aria-hidden="true" />{t('界面语言 / Language')}</label>
    <div className="kp-language-controls"><select id="kp-language" value={value} disabled={busy} onChange={event => setValue(event.target.value as LanguagePreference)}>
      <option value="auto">{t('跟随浏览器')}</option>
      {languages.map(item => <option key={item.code} value={item.code} lang={item.code}>{item.label}</option>)}
    </select><button type="button" disabled={busy || value === getLanguagePreference()} onClick={() => void apply()}>{busy ? t('正在保存…') : t('应用语言')}</button></div>
    <p>{t('应用后刷新当前页面，其他已打开页面重新打开后生效。账号和填写资料保持原样。')}</p>
    <p className="kp-language-coverage">{t('日语和西班牙语优先覆盖常用操作，部分高级说明使用英文。')}</p>
    {error && <p role="alert">{error}</p>}
  </div>;
}
