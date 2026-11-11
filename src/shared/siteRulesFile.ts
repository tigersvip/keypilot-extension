import type { SiteRule } from './types';

export interface SiteRuleExportFile {
  format: 'keypilot-site-rules';
  version: 1;
  exportedAt: string;
  rules: SiteRule[];
}

function sanitizeSiteRule(rule: SiteRule): SiteRule {
  return {
    ...rule,
    formFields: rule.formFields?.map((field) => ({ ...field })),
    formProfile: rule.formProfile
      ? {
          ...rule.formProfile,
          submit: rule.formProfile.submit ? { ...rule.formProfile.submit } : undefined
        }
      : undefined
  };
}

export function exportSiteRulesFile(rules: SiteRule[]): string {
  const payload: SiteRuleExportFile = {
    format: 'keypilot-site-rules',
    version: 1,
    exportedAt: new Date().toISOString(),
    rules: rules.map(sanitizeSiteRule)
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
}

function isSiteRule(value: unknown): value is SiteRule {
  if (!value || typeof value !== 'object') return false;
  const rule = value as Partial<SiteRule>;
  return Boolean(
    typeof rule.domain === 'string' &&
      typeof rule.source === 'string' &&
      typeof rule.createdAt === 'number' &&
      typeof rule.updatedAt === 'number'
  );
}

export function parseSiteRulesFile(text: string): SiteRule[] {
  const parsed = JSON.parse(text) as SiteRuleExportFile | SiteRule[];
  const rules = Array.isArray(parsed) ? parsed : parsed.format === 'keypilot-site-rules' ? parsed.rules : [];

  return rules
    .filter(isSiteRule)
    .map((rule) => ({
      ...sanitizeSiteRule(rule),
      id: rule.id || crypto.randomUUID(),
      domain: rule.domain.trim().replace(/^www\./i, '').toLowerCase(),
      updatedAt: Date.now()
    }))
    .filter((rule) => rule.domain);
}

export function mergeSiteRules(currentRules: SiteRule[], importedRules: SiteRule[], limit = 120): SiteRule[] {
  const merged = [...currentRules];

  for (const rule of importedRules) {
    const existingIndex = merged.findIndex(
      (item) =>
        item.domain === rule.domain &&
        (item.pathPattern ?? '') === (rule.pathPattern ?? '') &&
        (item.pageMode ?? 'auto') === (rule.pageMode ?? 'auto')
    );

    if (existingIndex >= 0) {
      merged[existingIndex] = {
        ...merged[existingIndex],
        ...rule,
        id: merged[existingIndex].id,
        createdAt: merged[existingIndex].createdAt,
        updatedAt: Date.now()
      };
    } else {
      merged.unshift({
        ...rule,
        id: rule.id || crypto.randomUUID(),
        createdAt: rule.createdAt || Date.now(),
        updatedAt: Date.now()
      });
    }
  }

  return merged.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit);
}
