export const DEFAULT_SETTINGS = {
  apiKey: "",
  interfaceLanguage: "en",
  mode: "both",
  audioProfile: "solo",
  sourceLanguage: "Russian",
  targetLanguage: "English",
  mediaSourceLanguage: "English",
  mediaTargetLanguage: "Russian",
  outgoingVoice: "marin",
  incomingVoice: "cedar",
  outgoingDeviceId: "default",
  incomingDeviceId: "default",
  monitorLevel: "off",
  outgoingMuted: false,
  outgoingTranslationMuted: false,
  incomingMuted: false,
  incomingTranslationMuted: false,
  outgoingInterpreterOff: false,
  incomingInterpreterOff: false,
  outgoingOriginalOn: false,
  incomingOriginalOn: false,
  outgoingMonitorOn: false,
  // Seconds of silence before a direction's realtime session is closed to stop
  // paying for streamed silence. 0 keeps every session open for the whole call.
  autoPauseSeconds: 5,
  summaryProvider: "openai",
  ollamaUrl: "http://localhost:11434",
  ollamaModel: "llama3.1",
  summaryDetail: "standard",
  summarySections: {
    overview: true,
    topics: true,
    decisions: true,
    tasks: true,
    deadlines: true,
    owners: true,
    questions: true
  },
  speakerDiarization: true,
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
  if (!value) return "";
  return `${value.slice(0, 7)}••••••••${value.slice(-4)}`;
}
