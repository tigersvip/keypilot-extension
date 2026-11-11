import { t } from './i18n';
import { Eye, EyeOff } from 'lucide-react';
import { useSecretVisibility } from './sensitiveActions';
import type { FillField } from './types';
import './shared-ui.css';

export function SensitiveValue({ field }: { field: Pick<FillField, 'label' | 'value' | 'sensitivity'> }) {
  const [visible, setVisible] = useSecretVisibility();
  const sensitive = field.sensitivity !== 'normal';
  return <span className="kp-sensitive-value">
    <span>{sensitive && !visible ? '••••••••' : field.value || t("空")}</span>
    {sensitive && <button type="button" aria-label={`${visible ? t("隐藏") : t("查看")} ${field.label}`} aria-pressed={visible} onClick={() => setVisible(!visible)}>
      {visible ? <EyeOff size={16} /> : <Eye size={16} />}
    </button>}
  </span>;
}
