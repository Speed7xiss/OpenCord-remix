export type Preferences = {
  theme: 'dark' | 'light' | 'midnight' | 'amoled' | 'ocean' | 'forest' | 'sunset' | 'lavender' | 'retro';
  sounds: boolean;
  soundVolume: number;
  inputDeviceId: string;
  outputDeviceId: string;
  cameraDeviceId: string;
  pushToTalk: boolean;
  pushToTalkKey: string;
  inputSensitivity: number;
  useVoicePriority: boolean;
};

const defaults: Preferences = {
  theme: 'dark',
  sounds: true,
  soundVolume: 0.45,
  inputDeviceId: '',
  outputDeviceId: '',
  cameraDeviceId: '',
  pushToTalk: false,
  pushToTalkKey: 'Space',
  inputSensitivity: 0.035,
  useVoicePriority: true,
};

export function loadPreferences(): Preferences {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem('opencord.preferences') ?? '{}') };
  } catch {
    return defaults;
  }
}

export function savePreferences(next: Preferences) {
  localStorage.setItem('opencord.preferences', JSON.stringify(next));
  document.documentElement.dataset.theme = next.theme;
  window.dispatchEvent(new CustomEvent('opencord:preferences', { detail: next }));
}

export function applyStoredTheme() {
  document.documentElement.dataset.theme = loadPreferences().theme;
}
