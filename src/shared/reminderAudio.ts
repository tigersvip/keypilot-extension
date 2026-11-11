import type { ReminderSound } from './reminders';

type Tone = readonly [frequency: number, start: number, duration: number];
export const soundPatterns: Record<ReminderSound, readonly Tone[]> = {
  chime: [[880, 0, .22], [1174.66, .28, .38]],
  bell: [[523.25, 0, .9], [783.99, .06, .8], [1046.5, .14, .7]],
  triple: [[740, 0, .16], [740, .25, .16], [988, .5, .28]],
  digital: [[660, 0, .12], [880, .17, .12], [660, .4, .12], [880, .57, .2]]
};
export function scheduleReminderSound(context: BaseAudioContext, sound: ReminderSound, volume: number) {
  const tones = soundPatterns[sound] ?? soundPatterns.chime;
  for (const [frequency, start, duration] of tones) {
    const oscillator = context.createOscillator(), gain = context.createGain();
    oscillator.type = 'sine'; oscillator.frequency.value = frequency;
    const time = context.currentTime + start;
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(Math.min(1, Math.max(0, volume / 100)) * .22, time + .015);
    gain.gain.exponentialRampToValueAtTime(.0001, time + duration);
    gain.gain.setValueAtTime(0, time + duration + .01);
    oscillator.connect(gain); gain.connect(context.destination);
    oscillator.start(time); oscillator.stop(time + duration + .02);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  }
}
export async function previewReminderSound(sound: ReminderSound, volume: number) {
  const context = new AudioContext();
  try {
    await context.resume();
    if (context.state !== 'running') throw new Error('声音未能播放，请检查浏览器和系统音量。');
    scheduleReminderSound(context, sound, volume);
    setTimeout(() => void context.close(), 1400);
  } catch (error) { await context.close(); throw error; }
}
