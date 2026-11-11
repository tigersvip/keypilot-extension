let creating: Promise<void> | undefined;
export async function ensureOffscreenDocument() {
  if (creating) return creating;
  creating = (async () => {
    const ready = typeof chrome.offscreen.hasDocument === 'function' ? await chrome.offscreen.hasDocument()
      : Boolean(await chrome.runtime.sendMessage({ target: 'keypilot-clipboard-ping' }).catch(() => null));
    if (!ready) await chrome.offscreen.createDocument({ url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.CLIPBOARD, chrome.offscreen.Reason.AUDIO_PLAYBACK, chrome.offscreen.Reason.WORKERS],
      justification: '清理剪贴板、播放本地提醒声音，并在用户请求时通过本地 Worker 识别验证码图片。' });
  })().finally(() => { creating = undefined; });
  return creating;
}
