import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyProtectedText } from './clipboard';
import './copy-button.css';

export function CopyButton({ value, label, sensitive = true }: { value: string; label: string; sensitive?: boolean }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(''), 2400);
    return () => window.clearTimeout(timer);
  }, [message]);
  async function copy() {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      const copied = value ? await copyProtectedText(value, sensitive) : false;
      if (alive.current && copied) setMessage('已复制');
    } catch {
      if (alive.current) setMessage('复制失败，请重试');
    } finally { if (alive.current) setBusy(false); }
  }
  return <span className="kp-copy-control">
    <button type="button" aria-label={label} title={label} disabled={busy || !value} onClick={() => void copy()}>
      {message === '已复制' ? <Check size={17} aria-hidden="true" /> : <Copy size={17} aria-hidden="true" />}
    </button>
    <span className="kp-copy-feedback" role="status">{message}</span>
  </span>;
}
