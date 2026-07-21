import { loadSettings, maskKey, saveSettings } from "./config.js";
import { languageName, localizePage, t } from "./i18n.js";

const $ = (selector) => document.querySelector(selector);
const elements = {
  toggle: $("#toggle"), toggleLabel: $("#toggle-label"), status: $("#status-label"), phase: $("#phase-pill"),
  timer: $("#session-timer"), error: $("#error"), errorCopy: $("#error-copy"),
  keyStatus: $("#key-status"), usage: $("#usage-label"), source: $("#source-label"), target: $("#target-label"),
  setup: $("#setup-banner"), setupCopy: $("#setup-copy"), notice: $("#recording-notice"),
  modeHelp: $("#mode-help"), interfaceLanguage: $("#interface-language"), sourceLanguage: $("#source-language"), targetLanguage: $("#target-language"), outgoingDevice: $("#outgoing-device"), incomingDevice: $("#incoming-device")
};

const routeLabels = {
  source: document.querySelector(".language-route > div:first-child > span"),
  target: document.querySelector(".language-route > .align-right > span"),
  sourceSetting: document.querySelector('label[for="source-language"]'),
  targetSetting: document.querySelector('label[for="target-language"]')
};

let active = false;
let busy = false;
let currentMode = "both";
let currentSettings = {};
let locale = "en";
let currentState = { active: false, phase: "idle", error: "" };
let lastStartedAt = 0;
let actionError = "";
let activeCaptureKind = "meeting";

const MODE_HINTS = { translation: "translationHint", notes: "notesHint", both: "bothHint", transcript: "transcriptHint" };
const PHASES = { idle: "ready", connecting: "connecting", live: "live", reconnecting: "reconnecting", summarizing: "notes", disconnected: "error", failed: "error", error: "error", closed: "ready", limit: "limit" };
const START_LABELS = { translation: "startTranslation", notes: "startNotes", both: "startMeeting", transcript: "startTranscript" };

function friendlyError(error) {
  const message = error?.message || String(error || t(locale, "unknownError"));
  if (/Permission dismissed|Permission denied|NotAllowedError/i.test(message)) return t(locale, "permission");
  if (/OpenAI 401|invalid.*key|Incorrect API key/i.test(message)) return t(locale, "keyError");
  if (/OpenAI 429|quota|rate limit/i.test(message)) return t(locale, "quota");
  if (/Requested device not found|NotFoundError/i.test(message)) return t(locale, "deviceMissing");
  if (/Extension has not been invoked|activeTab permission/i.test(message)) return TAB_ACCESS_HINT[locale] || TAB_ACCESS_HINT.en;
  if (/Cannot capture|tabCapture|active tab/i.test(message)) return t(locale, "conferenceTab");
  if (/virtual|аудиокабель|different devices|Conference mode/i.test(message)) return message.includes("different") || message.includes("разными") ? t(locale, "differentOutputs") : t(locale, "conferenceCable");
  if (/network|fetch|connection/i.test(message)) return t(locale, "network");
  return message;
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function languageLabel(value) { return languageName(locale, value); }

function captureKindFor(url = "") {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be" ? "media" : "meeting";
  } catch {
    return "meeting";
  }
}

const MEDIA_LABELS = {
  en: { source: "Video", target: "You", sourceSetting: "Video language", targetSetting: "Translate to" },
  ru: { source: "Видео", target: "Вы", sourceSetting: "Язык видео", targetSetting: "Переводить на" },
  es: { source: "Vídeo", target: "Usted", sourceSetting: "Idioma del vídeo", targetSetting: "Traducir a" },
  de: { source: "Video", target: "Sie", sourceSetting: "Videosprache", targetSetting: "Übersetzen in" },
  fr: { source: "Vidéo", target: "Vous", sourceSetting: "Langue de la vidéo", targetSetting: "Traduire vers" }
};

const TAB_ACCESS_HINT = {
  en: "Click the Live Voice Translator icon once on this tab, then start translation.",
  ru: "Нажмите иконку Live Voice Translator на этой вкладке, затем запустите перевод.",
  es: "Haga clic en el icono de Live Voice Translator en esta pestaña y luego inicie la traducción.",
  de: "Klicken Sie auf dieser Registerkarte auf das Symbol von Live Voice Translator und starten Sie dann die Übersetzung.",
  fr: "Cliquez sur l’icône Live Voice Translator dans cet onglet, puis démarrez la traduction."
};

function renderCaptureContext(kind) {
  if (kind === "media") {
    Object.entries(MEDIA_LABELS[locale] || MEDIA_LABELS.en).forEach(([key, value]) => { routeLabels[key].textContent = value; });
    return;
  }
  routeLabels.source.textContent = t(locale, "you");
  routeLabels.target.textContent = t(locale, "participant");
  routeLabels.sourceSetting.textContent = t(locale, "youSpeak");
  routeLabels.targetSetting.textContent = t(locale, "participantLanguage");
}

async function microphonePermission() {
  try { return (await navigator.permissions.query({ name: "microphone" })).state; }
  catch { return "prompt"; }
}

function setCheck(name, state, copy) {
  const item = document.querySelector(`[data-check="${name}"]`);
  item.dataset.state = state;
  item.querySelector("small").textContent = copy;
}

async function renderPreflight(settings) {
  setCheck("api", settings.apiKey ? "ok" : "error", settings.apiKey ? t(locale, "configured") : t(locale, "required"));
  const permission = await microphonePermission();
  setCheck("microphone", permission === "granted" ? "ok" : permission === "denied" ? "error" : "warn", permission === "granted" ? t(locale, "allowed") : permission === "denied" ? t(locale, "error") : t(locale, "connecting"));
  const voiceMode = ["translation", "both"].includes(settings.mode);
  const mediaCapture = activeCaptureKind === "media";
  const conferenceReady = mediaCapture || settings.audioProfile !== "conference" || (settings.outgoingDeviceId && settings.outgoingDeviceId !== "default" && settings.outgoingDeviceId !== settings.incomingDeviceId);
  setCheck("route", !voiceMode || conferenceReady ? "ok" : "error", !voiceMode || mediaCapture ? t(locale, "notRequired") : settings.audioProfile === "solo" ? "Mac" : conferenceReady ? t(locale, "ready") : t(locale, "required"));
}

function render(state = currentState) {
  currentState = state;
  active = Boolean(state.active);
  lastStartedAt = state.startedAt || lastStartedAt;
  document.body.classList.toggle("is-live", active);
  document.body.classList.toggle("is-busy", busy);
  elements.toggle.classList.toggle("is-loading", busy || ["connecting", "reconnecting", "summarizing"].includes(state.phase));
  elements.toggle.disabled = busy;
  elements.toggleLabel.textContent = active ? t(locale, "stop") : activeCaptureKind === "media" ? t(locale, "startTranslation") : t(locale, START_LABELS[currentMode]);
  const iconPath = elements.toggle.querySelector(".button-symbol path");
  if (iconPath) iconPath.setAttribute("d", active ? "M8 8h8v8H8z" : "m9 7 8 5-8 5V7Z");
  elements.status.textContent = t(locale, PHASES[state.phase] || (active ? "live" : "ready"));
  const error = state.error ? friendlyError(state.error) : actionError;
  elements.error.hidden = !error;
  elements.errorCopy.textContent = error;
  elements.modeHelp.textContent = t(locale, MODE_HINTS[currentMode]);
  elements.notice.hidden = active || !["notes", "both", "transcript"].includes(currentMode) || Boolean(currentSettings.recordingNoticeAccepted);
  updateTimer();
}

function updateTimer() {
  const startedAt = currentState.startedAt || lastStartedAt;
  const seconds = active && startedAt ? (Date.now() - startedAt) / 1000 : currentState.durationSeconds || 0;
  elements.timer.textContent = formatDuration(seconds);
  elements.timer.dateTime = `PT${Math.floor(seconds)}S`;
}

async function refresh() {
  const settings = await loadSettings();
  currentSettings = settings;
  locale = settings.interfaceLanguage || "en";
  localizePage(locale);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeCaptureKind = captureKindFor(tab?.url);
  renderCaptureContext(activeCaptureKind);
  document.title = t(locale, "appTitle");
  currentMode = settings.mode;
  document.querySelectorAll("[data-mode]").forEach((button) => button.classList.toggle("active", button.dataset.mode === currentMode));
  elements.interfaceLanguage.value = locale;
  elements.sourceLanguage.value = settings.sourceLanguage;
  elements.targetLanguage.value = settings.targetLanguage;
  elements.keyStatus.textContent = settings.apiKey ? maskKey(settings.apiKey) : t(locale, "apiNotConfigured");
  elements.usage.textContent = t(locale, "used", { minutes: Math.ceil((settings.usageSeconds || 0) / 60), sessions: settings.sessionCount || 0 });
  elements.source.textContent = languageLabel(settings.sourceLanguage);
  elements.target.textContent = languageLabel(settings.targetLanguage);
  elements.setup.hidden = Boolean(settings.apiKey);
  elements.setupCopy.textContent = settings.apiKey ? "" : t(locale, "setupCopy");
  await renderPreflight(settings);
  const result = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  render(result?.state || { active: false, phase: "idle", error: result?.error || "" });
}

async function listOutputs(settings) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    const outputs = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audiooutput");
    for (const [element, selected] of [[elements.outgoingDevice, settings.outgoingDeviceId], [elements.incomingDevice, settings.incomingDeviceId]]) {
      element.replaceChildren(new Option(t(locale, "systemOutput"), "default"));
      outputs.forEach((device, index) => element.add(new Option(device.label || t(locale, "audioOutput", { number: index + 1 }), device.deviceId)));
      element.value = [...element.options].some((option) => option.value === selected) ? selected : "default";
    }
  } catch {
    elements.outgoingDevice.value = settings.outgoingDeviceId || "default";
    elements.incomingDevice.value = settings.incomingDeviceId || "default";
  }
}

elements.toggle.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  actionError = "";
  elements.error.hidden = true;
  render();
  try {
    if (active) {
      const result = await chrome.runtime.sendMessage({ type: "STOP_TRANSLATION" });
      if (!result?.ok) throw new Error(result?.error || t(locale, "error"));
      currentState = result.state;
      if (result.meetingId) await chrome.tabs.create({ url: `${chrome.runtime.getURL("src/history.html")}#${result.meetingId}` });
    } else {
      if (!currentSettings.apiKey) { chrome.runtime.openOptionsPage(); return; }
      if (["notes", "both", "transcript"].includes(currentMode) && !currentSettings.recordingNoticeAccepted) {
        elements.notice.hidden = false;
        return;
      }
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !/^https?:/i.test(tab.url || "")) throw new Error(t(locale, "conferenceTab"));
      const result = await chrome.runtime.sendMessage({
        type: "START_TRANSLATION",
        tabId: tab.id,
        captureKind: captureKindFor(tab.url)
      });
      if (!result?.ok) throw new Error(result?.error || t(locale, "error"));
      currentState = result.state;
    }
  } catch (error) {
    actionError = friendlyError(error);
    currentState = { active: false, phase: "error", error: actionError };
  } finally {
    busy = false;
    render(currentState);
    await refresh().catch(() => {});
  }
});

$("#open-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("#setup-action").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("#error-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("#open-history").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("src/history.html") }));
$("#accept-notice").addEventListener("click", async () => {
  await saveSettings({ recordingNoticeAccepted: true });
  currentSettings.recordingNoticeAccepted = true;
  elements.notice.hidden = true;
  // The user already requested a start; acknowledging the recording notice should
  // continue that action instead of requiring an unexplained second click.
  elements.toggle.click();
});
document.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", async () => {
  if (active || busy) return;
  currentMode = button.dataset.mode;
  await saveSettings({ mode: currentMode });
  await refresh();
}));
elements.interfaceLanguage.addEventListener("change", async () => { await saveSettings({ interfaceLanguage: elements.interfaceLanguage.value }); await refresh(); });
elements.sourceLanguage.addEventListener("change", async () => { await saveSettings({ sourceLanguage: elements.sourceLanguage.value }); await refresh(); });
elements.targetLanguage.addEventListener("change", async () => { await saveSettings({ targetLanguage: elements.targetLanguage.value }); await refresh(); });
for (const select of [elements.outgoingDevice, elements.incomingDevice]) select.addEventListener("change", async () => {
  const outgoingDeviceId = elements.outgoingDevice.value;
  await saveSettings({ outgoingDeviceId, incomingDeviceId: elements.incomingDevice.value, audioProfile: outgoingDeviceId === "default" ? "solo" : "conference" });
  await refresh();
});

refresh().then(() => listOutputs(currentSettings)).catch((error) => render({ active: false, phase: "error", error: friendlyError(error) }));
setInterval(updateTimer, 1000);
setInterval(() => { if (document.visibilityState === "visible" && !busy) refresh().catch(() => {}); }, 2500);
