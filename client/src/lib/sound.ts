import { loadPreferences } from './preferences';

type SoundKind = 'join' | 'leave' | 'message' | 'mention' | 'mute' | 'unmute' | 'disconnect' | 'camera';
let audioContext: AudioContext | null = null;
const patterns: Record<SoundKind, Array<[number, number, number]>> = {
  join: [[520, 0, 0.06], [720, 0.07, 0.08]],
  leave: [[620, 0, 0.06], [390, 0.07, 0.09]],
  message: [[660, 0, 0.045]],
  mention: [[760, 0, 0.05], [920, 0.06, 0.07]],
  mute: [[420, 0, 0.05]],
  unmute: [[560, 0, 0.05]],
  disconnect: [[460, 0, 0.06], [290, 0.07, 0.12]],
  camera: [[700, 0, 0.04]],
};

export function playSound(kind: SoundKind) {
  const prefs = loadPreferences();
  if (!prefs.sounds || prefs.soundVolume <= 0) return;
  try {
    audioContext ??= new AudioContext();
    const now = audioContext.currentTime;
    for (const [frequency, offset, duration] of patterns[kind]) {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.frequency.value = frequency;
      oscillator.type = 'sine';
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.001, prefs.soundVolume * 0.12), now + offset + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + duration);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(now + offset);
      oscillator.stop(now + offset + duration + 0.01);
    }
  } catch {
  }
}

export function playCustomSound(url: string | null | undefined) {
  const prefs = loadPreferences();
  if (!url || !prefs.sounds || prefs.soundVolume <= 0) return false;
  try {
    const audio = new Audio(url);
    audio.volume = Math.max(0, Math.min(1, prefs.soundVolume));
    void audio.play().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}
