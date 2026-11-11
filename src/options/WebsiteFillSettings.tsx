import { useEffect, useRef, useState } from 'react';
import { clearProfileBinding, clearSiteFillPreferences } from '../shared/siteFillSettings';
import { persistVaultSession, restoreCachedVaultSession } from '../shared/vault';
import { sameVaultValue } from '../shared/vaultMerge';
import type { UnlockedVaultSession, VaultPlain, VaultSettings } from '../shared/types';

type SitePreference = NonNullable<VaultSettings['siteLoginSettings']>[string];
function preferenceSnapshot(vault: VaultPlain, origin: string) {
  return { login: vault.settings.siteLoginSettings?.[origin], captcha: vault.settings.captchaSiteRules?.[origin],
    totp: vault.settings.autoTotpOrigins?.includes(origin) ?? false };
}

export function WebsiteFillSettings({session, onChange}: {session: UnlockedVaultSession; onChange: (session: UnlockedVaultSession) => void}) {
  const [query, setQuery] = useState(''), [kind, setKind] = useState('all'), [expanded, setExpanded] = useState('');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const saving = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const {vault} = session, {settings} = vault, profiles = vault.fillProfiles ?? [];
  const search = query.trim().toLocaleLowerCase();
  const matches = (text: string) => text.toLocaleLowerCase().includes(search);
  const origins = [...new Set([...Object.keys(settings.siteLoginSettings ?? {}), ...Object.keys(settings.captchaSiteRules ?? {}), ...(settings.autoTotpOrigins ?? [])])].sort();
  const sites = kind === 'bindings' ? [] : origins.filter(origin => matches(origin+' '+(profiles.find(item => item.id === settings.siteLoginSettings?.[origin]?.defaultFillProfileId)?.title ?? '')));
  const bindings = kind === 'preferences' ? [] : profiles.flatMap(profile => (profile.siteBindings ?? []).map(binding => ({profile, binding})))
    .filter(({profile, binding}) => matches(binding.domain+' '+(binding.pathPattern ?? '')+' '+profile.title));

  async function save(snapshot: (vault: VaultPlain) => unknown, change: (vault: VaultPlain) => VaultPlain, notice: string) {
    if (saving.current) return;
    saving.current = true; setBusy(true); setMessage('');
    const expected = snapshot(vault);
    try {
      const fresh = await restoreCachedVaultSession();
      if (!fresh || fresh.sessionId !== session.sessionId) throw new Error('VAULT_LOCKED');
      if (!sameVaultValue(snapshot(fresh.vault), expected)) {
        if (alive.current) onChange(fresh);
        throw new Error('设置已在其他页面修改，已刷新。请检查后重试。');
      }
      const next = await persistVaultSession(fresh, change(fresh.vault));
      if (alive.current) { onChange(next); setMessage(notice); }
    } catch (error) {
      if (alive.current) setMessage(error instanceof Error && !error.message.startsWith('VAULT_') ? error.message : '保存失败，请确认密码库已解锁，并刷新设置后重试。');
    } finally { saving.current = false; if (alive.current) setBusy(false); }
  }
  function patch(origin: string, change: Partial<SitePreference>) {
    void save(current => preferenceSnapshot(current, origin), current => {
      const next = {...current.settings.siteLoginSettings?.[origin], ...change};
      if ('defaultFillProfileId' in change && change.defaultFillProfileId && !current.fillProfiles?.some(item => item.id === change.defaultFillProfileId)) throw new Error('资料已删除，请刷新后重试。');
      if (change.defaultCredentialId && !current.credentials.some(item => { try { return item.id === change.defaultCredentialId && new URL(item.url).origin === origin; } catch { return false; } })) throw new Error('账号已变化，请刷新后重试。');
      if (!next.defaultFillProfileId) delete next.defaultFillProfileId;
      if (!next.defaultCredentialId) delete next.defaultCredentialId;
      return {...current, settings: {...current.settings, siteLoginSettings: {...current.settings.siteLoginSettings, [origin]: next}}};
    }, '网站填写设置已保存。');
  }

  return <section className="website-fill-settings" aria-label="网站填写设置">
    <h2>网站填写设置</h2>
    <p>查找网站的默认资料、填写例外和字段绑定。更改会随完整加密备份保存。</p>
    <div className="website-fill-search">
      <input type="search" aria-label="搜索网站填写设置" placeholder="搜索网站、路径或资料名称" value={query} onChange={event => setQuery(event.target.value)}/>
      <select aria-label="设置类型" value={kind} onChange={event => setKind(event.target.value)}><option value="all">全部设置</option><option value="preferences">网站偏好</option><option value="bindings">字段绑定</option></select>
    </div>
    <p className="website-fill-meta">{sites.length} 个网站偏好 · {bindings.length} 组字段绑定</p>
    {message && <p role="status" className="website-fill-message">{message}</p>}
    {!sites.length && !bindings.length && <p className="website-fill-empty">{search || kind !== 'all' ? '没有符合条件的设置。' : '还没有网站填写设置。在填写预览中记住资料，或校准网页字段后，可在这里管理。'}</p>}
    {sites.map(origin => {
      const rule = settings.siteLoginSettings?.[origin] ?? {}, key = 'origin:'+origin;
      const profile = profiles.find(item => item.id === rule.defaultFillProfileId);
      const credentials = expanded === key ? vault.credentials.filter(item => { try { return new URL(item.url).origin === origin; } catch { return false; } }) : [];
      const disabled = rule.fillEnabled === false;
      return <article className="website-fill-item" key={key}>
        <button className="website-fill-summary" type="button" aria-expanded={expanded === key} onClick={() => setExpanded(expanded === key ? '' : key)}>
          <span><strong>{origin}</strong><small>网站偏好 · {profile ? '默认资料：'+profile.title : rule.defaultFillProfileId ? '默认资料已不可用' : '每次选择资料'}{disabled ? ' · 账号填写已关闭' : ''}</small></span><span aria-hidden="true">{expanded === key ? '−' : '+'}</span>
        </button>
        {expanded === key && <div className="website-fill-detail">
          <p>仅适用于上方协议、域名和端口。其他子域名分别设置。</p>
          <label className="website-fill-field">默认填写资料<select aria-label="默认填写资料" disabled={busy} value={rule.defaultFillProfileId ?? ''} onChange={event => patch(origin, {defaultFillProfileId: event.target.value})}>
            <option value="">每次选择资料</option>{rule.defaultFillProfileId && !profile && <option value={rule.defaultFillProfileId}>已不可用，请重新选择</option>}{profiles.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select></label>
          <label className="website-fill-field">网站首选账号<select aria-label="网站首选账号" disabled={busy} value={rule.defaultCredentialId ?? ''} onChange={event => patch(origin, {defaultCredentialId: event.target.value})}>
            <option value="">按原有顺序排列</option>{rule.defaultCredentialId && !credentials.some(item => item.id === rule.defaultCredentialId) && <option value={rule.defaultCredentialId}>已不可用，请重新选择</option>}{credentials.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select></label>
          <label className="website-fill-toggle"><span>允许网页填写账号密码<small>{disabled ? '此网站已关闭' : '已允许'}</small></span><input type="checkbox" role="switch" checked={!disabled} disabled={busy} onChange={event => patch(origin, {fillEnabled: event.target.checked})}/></label>
          <label className="website-fill-toggle"><span>一键登录时自动点击登录<small>{rule.autoSubmit === false ? '此网站已关闭' : disabled ? '需先允许网页填写' : !settings.autoSubmit ? '总开关已关闭' : '已开启'}</small></span><input type="checkbox" role="switch" checked={rule.autoSubmit !== false} disabled={busy} onChange={event => patch(origin, {autoSubmit: event.target.checked})}/></label>
          <label className="website-fill-toggle"><span>图片验证码识别<small>{settings.captchaSiteRules?.[origin]?.disabled ? '此网站已关闭' : !settings.captchaAssistEnabled ? '总开关已关闭' : '已开启'}</small></span><input type="checkbox" role="switch" disabled={busy} checked={!settings.captchaSiteRules?.[origin]?.disabled} onChange={event => {
            const disabled = !event.target.checked;
            void save(current => preferenceSnapshot(current, origin), current => ({...current, settings: {...current.settings, captchaSiteRules: {...current.settings.captchaSiteRules, [origin]: {mode:'auto', ...current.settings.captchaSiteRules?.[origin], disabled}}}}), '网站验证码偏好已保存。');
          }}/></label>
          {settings.autoTotpOrigins?.includes(origin) && <p>此网站已允许一键登录后填写动态验证码，具体账号和关联请在账号详情中调整。</p>}
          <p>全局自动登录和验证码开关关闭时，网站偏好不会覆盖它们。<a href="#autofill">调整总开关</a></p>
          <button type="button" className="secondary-action small danger" disabled={busy} onClick={() => {
            if (!window.confirm('恢复 '+origin+' 的默认设置？将清除默认资料、首选账号、网站填写例外和验证码偏好，并关闭自动填写动态验证码。账号、验证码及字段绑定保留。')) return;
            void save(current => preferenceSnapshot(current, origin), current => clearSiteFillPreferences(current, origin), '已恢复此网站默认设置，资料和字段绑定已保留。');
          }}>恢复此网站默认设置</button>
        </div>}
      </article>;
    })}
    {bindings.map(({profile, binding}) => {
      const key = 'binding:'+profile.id+':'+binding.id, scope = binding.domain+(binding.pathPattern ?? '（整个域名）');
      return <article className="website-fill-item" key={key}>
        <button className="website-fill-summary" type="button" aria-expanded={expanded === key} onClick={() => setExpanded(expanded === key ? '' : key)}>
          <span><strong>{scope}</strong><small>字段绑定 · {profile.title} · {binding.fields.length} 个字段</small></span><span aria-hidden="true">{expanded === key ? '−' : '+'}</span>
        </button>
        {expanded === key && <div className="website-fill-detail">
          <p>{binding.pathPattern ? '适用于此域名的上方路径及其子路径。' : '适用于此域名的所有路径。'}绑定按域名匹配，不区分协议和端口，不含其他子域名。</p>
          <ul className="website-fill-mappings">{binding.fields.map((field, index) => <li key={index}><span>{profile.fields.find(item => item.key === field.key)?.label ?? field.label ?? field.key}</span><span>→ {field.controlLabel || field.name || field.id || '网页字段'}</span></li>)}</ul>
          <p>需要重新对应字段时，在网页填写预览中选择“校准未匹配字段”。</p>
          <button type="button" className="secondary-action small danger" disabled={busy} onClick={() => {
            if (!window.confirm('清除“'+profile.title+'”在 '+scope+' 的这组绑定？资料内容和其他绑定保留。')) return;
            void save(current => current.fillProfiles?.find(item => item.id === profile.id)?.siteBindings?.find(item => item.id === binding.id), current => clearProfileBinding(current, profile.id, binding.id), '已清除这组字段绑定，恢复自动识别。');
          }}>清除这组绑定</button>
        </div>}
      </article>;
    })}
  </section>;
}
