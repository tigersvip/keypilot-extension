import type { VaultPlain } from './types';

// Rules use an exact hostname/path; site preferences use a full origin.
export function clearProfileBinding(vault: VaultPlain, profileId: string, bindingId: string): VaultPlain {
  const profile = vault.fillProfiles?.find(item => item.id === profileId);
  if (!profile?.siteBindings?.some(item => item.id === bindingId)) throw new Error('绑定已变化，请刷新后重试。');
  return { ...vault, fillProfiles: vault.fillProfiles!.map(item => item.id !== profileId ? item : {
    ...item, updatedAt: Date.now(), siteBindings: item.siteBindings!.filter(binding => binding.id !== bindingId)
  }) };
}

export function clearSiteFillPreferences(vault: VaultPlain, origin: string): VaultPlain {
  const siteLoginSettings = { ...vault.settings.siteLoginSettings };
  const captchaSiteRules = { ...vault.settings.captchaSiteRules };
  delete siteLoginSettings[origin];
  delete captchaSiteRules[origin];
  return { ...vault, settings: { ...vault.settings, siteLoginSettings, captchaSiteRules,
    autoTotpOrigins: (vault.settings.autoTotpOrigins ?? []).filter(item => item !== origin)
  } };
}
