import { scheduleReminderSound } from '../shared/reminderAudio';
import type { ReminderSound } from '../shared/reminders';

let context: AudioContext | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let generation = 0;
let lastPlayedAt = 0;
let audioError = '';
async function stop() {
  generation++;
  clearInterval(timer); timer = undefined;
  const previous = context; context = undefined;
  if (previous && previous.state !== 'closed') await previous.close();
}
async function beat() {
  const current = generation;
  try {
    const state = await chrome.runtime.sendMessage({ type: 'KEYPILOT_REMINDER_AUDIO_STATE' });
    if (generation !== current) return;
    if (!state?.active) { await stop(); return; }
    context ??= new AudioContext();
    if (context.state !== 'running') await Promise.race([context.resume(), new Promise<void>(resolve => setTimeout(resolve, 1000))]);
    if (generation === current && context?.state === 'running') {
      scheduleReminderSound(context, state.sound as ReminderSound, state.volume); lastPlayedAt = Date.now(); audioError = '';
    } else if (generation === current) audioError = '声音未能启动，请检查浏览器声音权限。';
  } catch { audioError = '声音暂时无法播放，请检查浏览器并重新打开插件。'; }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target === 'keypilot-reminder-audio-status' && sender.id === chrome.runtime.id && !sender.tab) {
    respond({ running: context?.state === 'running', lastPlayedAt, error: audioError }); return;
  }
  if (message?.target !== 'keypilot-reminder-audio' || sender.id !== chrome.runtime.id || sender.tab) return;
  if (message.active) {
    if (!timer) { timer = setInterval(() => void beat(), 15000); void beat(); }
    respond({ ok: true });
  } else { void stop().then(() => respond({ ok: true })); return true; }
});
