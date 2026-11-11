import { initLanguage } from '../shared/i18n';
void initLanguage().then(() => import('./render'));
