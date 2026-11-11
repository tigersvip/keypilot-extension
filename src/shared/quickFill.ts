// Probes and choices carry labels and IDs only; values are sent after selection.
export interface QuickFillTarget {
  id: string;
  kind: 'login' | 'profile';
  label: string;
  focused: boolean;
  uncertain: boolean;
}
export interface QuickFillProbe {
  token: string;
  url: string;
  frameFocused: boolean;
  targets: QuickFillTarget[];
}
export interface FillChoice { id: string; label: string; detail?: string }
