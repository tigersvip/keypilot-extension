import './reminderAudio';
import './captchaOcr';
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
async function readClipboard(): Promise<string> {
  try { return await navigator.clipboard.readText(); }
  catch {
    const input = document.createElement('textarea');
    document.body.append(input); input.focus();
    try {
      if (!document.execCommand('paste')) throw new Error('CLIPBOARD_READ_FAILED');
      return input.value;
    } finally { input.remove(); }
  }
}
async function writeClipboard(value: string): Promise<void> {
  try { await navigator.clipboard.writeText(value); }
  catch {
    const input = document.createElement('textarea');
    input.value = value || ' '; document.body.append(input); input.select();
    const copy = (event: ClipboardEvent) => { event.clipboardData?.setData('text/plain', value); event.preventDefault(); };
    document.addEventListener('copy', copy);
    try { if (!document.execCommand('copy')) throw new Error('CLIPBOARD_WRITE_FAILED'); }
    finally { document.removeEventListener('copy', copy); input.value = ''; input.remove(); }
  }
}
async function digest(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))).join(',');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target === 'keypilot-clipboard-ping' && sender.id === chrome.runtime.id && !sender.tab) { respond({ok:true}); return; }
  if (message?.target !== 'keypilot-clipboard' || sender.id !== chrome.runtime.id || sender.tab) return;
  const ownGeneration = ++generation;
  clearTimeout(timer);
  void (async () => {
    await writeClipboard(String(message.value ?? ''));
    const fingerprint = await digest(String(message.value ?? ''));
    const seconds = Math.max(0, Math.min(300, Number(message.seconds) || 0));
    if (seconds) timer = setTimeout(() => {
      void (async () => {
        const current = await readClipboard();
        if (ownGeneration === generation && await digest(current) === fingerprint) { await writeClipboard(''); }
      })().catch(() => undefined);
    }, seconds * 1000);
    respond({ ok: true });
  })().catch(() => respond({ ok: false, error: 'CLIPBOARD_UNAVAILABLE' }));
  return true;
});
