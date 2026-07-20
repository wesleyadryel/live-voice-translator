export const DEFAULT_SETTINGS = {
  apiKey: "",
  interfaceLanguage: "ru",
  mode: "both",
  audioProfile: "solo",
  sourceLanguage: "Russian",
  targetLanguage: "English",
  outgoingVoice: "marin",
  incomingVoice: "cedar",
  outgoingDeviceId: "default",
  incomingDeviceId: "default",
  monitorLevel: "off",
  summaryDetail: "standard",
  saveTranscript: true,
  retentionDays: 30,
  maxSessionMinutes: 90,
  recordingNoticeAccepted: false,
  usageSeconds: 0,
  sessionCount: 0
};

export async function loadSettings() {
  return chrome.storage.local.get(DEFAULT_SETTINGS);
}

export async function saveSettings(next) {
  await chrome.storage.local.set(next);
  return loadSettings();
}

export function maskKey(value) {
  if (!value) return "Не настроен";
  return `${value.slice(0, 7)}••••••••${value.slice(-4)}`;
}
