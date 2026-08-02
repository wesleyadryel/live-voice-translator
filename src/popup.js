import { loadSettings, maskKey, saveSettings } from "./config.js";
import { languageName, localizePage, t } from "./i18n.js";

const $ = (selector) => document.querySelector(selector);
const elements = {
  toggle: $("#toggle"), toggleLabel: $("#toggle-label"), status: $("#status-label"), phase: $("#phase-pill"),
  timer: $("#session-timer"), error: $("#error"), errorCopy: $("#error-copy"),
  keyStatus: $("#key-status"), usage: $("#usage-label"), source: $("#source-label"), target: $("#target-label"),
  setup: $("#setup-banner"), setupCopy: $("#setup-copy"), notice: $("#recording-notice"),
  modeHelp: $("#mode-help"), interfaceLanguage: $("#interface-language"), sourceLanguage: $("#source-language"), targetLanguage: $("#target-language"), outgoingDevice: $("#outgoing-device"), incomingDevice: $("#incoming-device"), captureContext: $("#capture-context"), swapLanguages: $("#swap-languages"),
  transcript: $("#live-transcript"), transcriptFeed: $("#transcript-feed"), transcriptEmpty: $("#transcript-empty"), transcriptCount: $("#transcript-count"), transcriptPolicy: $("#transcript-policy"),
  sessionControls: $("#session-controls"), muteRowOutgoing: $("#mute-row-outgoing"), muteRowIncoming: $("#mute-row-incoming"),
  muteOutgoingInterpreter: $("#mute-outgoing-interpreter"), muteOutgoingTranslation: $("#mute-outgoing-translation"), addOutgoingOriginal: $("#add-outgoing-original"), muteOutgoing: $("#mute-outgoing"),
  muteIncomingInterpreter: $("#mute-incoming-interpreter"), muteIncomingTranslation: $("#mute-incoming-translation"), addIncomingOriginal: $("#add-incoming-original"), muteIncoming: $("#mute-incoming")
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
let preparedTabId = null;
let activeTabUrl = "";
let outgoingRouteStatus = null;
let liveTranscript = [];
let transcriptSignature = "";
const MUTE_KEYS = ["outgoingInterpreterOff", "outgoingTranslationMuted", "outgoingOriginalOn", "outgoingMuted", "incomingInterpreterOff", "incomingTranslationMuted", "incomingOriginalOn", "incomingMuted"];
let mutes = Object.fromEntries(MUTE_KEYS.map((key) => [key, false]));

const MODE_HINTS = { translation: "translationHint", notes: "notesHint", both: "bothHint", transcript: "transcriptHint" };
const PHASES = { idle: "ready", connecting: "connecting", live: "live", reconnecting: "reconnecting", summarizing: "notes", disconnected: "error", failed: "error", error: "error", closed: "ready", limit: "limit" };
const START_LABELS = { translation: "startTranslation", notes: "startNotes", both: "startMeeting", transcript: "startTranscript" };

function friendlyError(error) {
  const message = error?.message || String(error || t(locale, "unknownError"));
  if (/Permission dismissed|Permission denied|NotAllowedError/i.test(message)) return t(locale, "permission");
  if (/OpenAI 401|invalid.*key|Incorrect API key/i.test(message)) return t(locale, "keyError");
  if (/OpenAI 429|quota|rate limit/i.test(message)) return t(locale, "quota");
  if (/Requested device not found|NotFoundError/i.test(message)) return t(locale, "deviceMissing");
  if (/Extension has not been invoked|activeTab permission|TAB_CAPTURE_NOT_PREPARED/i.test(message)) return TAB_ACCESS_HINT[locale] || TAB_ACCESS_HINT.en;
  if (/Cannot capture|tabCapture|active tab/i.test(message)) return t(locale, "conferenceTab");
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

function contextualLanguages(settings) {
  return activeCaptureKind === "media"
    ? { source: settings.mediaSourceLanguage || "English", target: settings.mediaTargetLanguage || "Russian" }
    : { source: settings.sourceLanguage, target: settings.targetLanguage };
}

function captureKindFor(url = "") {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be" ? "media" : "meeting";
  } catch {
    return "meeting";
  }
}

function isSupportedConferenceUrl(url = "") {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "meet.google.com" || host.endsWith(".zoom.us") || host === "telemost.yandex.ru" || host === "telemost.yandex.com" || host === "web.telegram.org" || host === "discord.com" || host.endsWith(".discord.com");
  } catch {
    return false;
  }
}

const MEDIA_LABELS = {
  en: { source: "Video", target: "You", sourceSetting: "Video language", targetSetting: "Translate to" },
  ru: { source: "Видео", target: "Вы", sourceSetting: "Язык видео", targetSetting: "Переводить на" },
  es: { source: "Vídeo", target: "Usted", sourceSetting: "Idioma del vídeo", targetSetting: "Traducir a" },
  de: { source: "Video", target: "Sie", sourceSetting: "Videosprache", targetSetting: "Übersetzen in" },
  fr: { source: "Vidéo", target: "Vous", sourceSetting: "Langue de la vidéo", targetSetting: "Traduire vers" },
  "pt-BR": { source: "Vídeo", target: "Você", sourceSetting: "Idioma do vídeo", targetSetting: "Traduzir para" }
};

const CAPTURE_LABELS = {
  en: { meeting: "Browser meeting", media: "Media tab" },
  ru: { meeting: "Встреча в браузере", media: "Медиа-вкладка" },
  es: { meeting: "Reunión web", media: "Pestaña multimedia" },
  de: { meeting: "Browser-Meeting", media: "Medien-Tab" },
  fr: { meeting: "Réunion web", media: "Onglet multimédia" },
  "pt-BR": { meeting: "Reunião no navegador", media: "Aba de mídia" }
};

const TAB_ACCESS_HINT = {
  en: "Close this panel and open it by clicking the Live Voice Translator toolbar icon on the video tab.",
  ru: "Закройте панель и откройте её кнопкой Live Voice Translator на панели Chrome во вкладке с видео.",
  es: "Cierre este panel y ábralo con el icono de Live Voice Translator en la barra de Chrome desde la pestaña del vídeo.",
  de: "Schließen Sie dieses Panel und öffnen Sie es über das Live-Voice-Translator-Symbol in der Chrome-Leiste des Video-Tabs.",
  fr: "Fermez ce panneau et ouvrez-le avec l’icône Live Voice Translator dans la barre Chrome de l’onglet vidéo.",
  "pt-BR": "Feche este painel e abra-o pelo ícone do Live Voice Translator na barra do Chrome, na aba do vídeo."
};

const MEDIA_TRANSLATION_MODE_HINT = {
  en: "Choose Translation mode for video playback.",
  ru: "Для видео выберите режим «Перевод».",
  es: "Para el vídeo, elija el modo Traducir.",
  de: "Wählen Sie für Videos den Modus Übersetzen.",
  fr: "Pour la vidéo, choisissez le mode Traduire.",
  "pt-BR": "Para vídeo, escolha o modo Traduzir."
};

const MEDIA_PROGRESS = {
  en: { waiting: "Listening for the first phrase…", translated: (count) => `Translated phrases: ${count}` },
  ru: { waiting: "Слушаю первую фразу…", translated: (count) => `Переведено фраз: ${count}` },
  es: { waiting: "Escuchando la primera frase…", translated: (count) => `Frases traducidas: ${count}` },
  de: { waiting: "Warte auf den ersten Satz…", translated: (count) => `Übersetzte Sätze: ${count}` },
  fr: { waiting: "Écoute de la première phrase…", translated: (count) => `Phrases traduites : ${count}` },
  "pt-BR": { waiting: "Ouvindo a primeira frase…", translated: (count) => `Frases traduzidas: ${count}` }
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
  const mediaCapture = activeCaptureKind === "media";
  const permission = mediaCapture ? "not-required" : await microphonePermission();
  setCheck("microphone", permission === "not-required" || permission === "granted" ? "ok" : permission === "denied" ? "error" : "warn", permission === "not-required" ? t(locale, "notRequired") : permission === "granted" ? t(locale, "allowed") : permission === "denied" ? t(locale, "error") : t(locale, "connecting"));
  if (mediaCapture) {
    setCheck("route", preparedTabId ? "ok" : "error", preparedTabId ? t(locale, "ready") : t(locale, "required"));
    return;
  }
  const voiceMode = ["translation", "both"].includes(settings.mode);
  const conferenceReady = isSupportedConferenceUrl(activeTabUrl);
  const routeActive = outgoingRouteStatus?.status === "routed";
  const routeWaiting = ["activating", "waiting-for-sender", "ready"].includes(outgoingRouteStatus?.status);
  setCheck("route", !voiceMode || routeActive || (conferenceReady && !active) ? "ok" : routeWaiting ? "warn" : "error", !voiceMode ? t(locale, "notRequired") : routeActive ? t(locale, "ready") : conferenceReady && !active ? "WebRTC" : routeWaiting ? t(locale, "connecting") : t(locale, "required"));
}

// The controls stay usable outside a session so the choice can be made up front.
// A media tab sends nothing back, and the note-only modes never speak a
// translation, so those rows and buttons drop out instead of lying about effect.
function renderMuteControls() {
  const translatesAloud = ["translation", "both"].includes(currentMode) || activeCaptureKind === "media";
  elements.muteRowOutgoing.hidden = !translatesAloud || activeCaptureKind === "media";
  elements.muteIncomingTranslation.hidden = !translatesAloud;
  elements.muteIncomingInterpreter.hidden = !translatesAloud;
  // A control is inert when a broader one already decides its outcome. The original
  // voice is also forced on whenever no translation is playing — turning it off
  // there would only produce silence, which the mute button already covers.
  const outgoingTranslationAudible = !mutes.outgoingMuted && !mutes.outgoingTranslationMuted && !mutes.outgoingInterpreterOff;
  const incomingTranslationAudible = !mutes.incomingMuted && !mutes.incomingTranslationMuted && !mutes.incomingInterpreterOff;
  const forced = {
    outgoingOriginalOn: !mutes.outgoingMuted && !outgoingTranslationAudible,
    incomingOriginalOn: !mutes.incomingMuted && !incomingTranslationAudible
  };
  const overrides = {
    outgoingInterpreterOff: mutes.outgoingMuted,
    outgoingTranslationMuted: mutes.outgoingMuted || mutes.outgoingInterpreterOff,
    outgoingOriginalOn: mutes.outgoingMuted || forced.outgoingOriginalOn,
    incomingInterpreterOff: mutes.incomingMuted,
    incomingTranslationMuted: mutes.incomingMuted || mutes.incomingInterpreterOff,
    incomingOriginalOn: mutes.incomingMuted || forced.incomingOriginalOn
  };
  for (const [button, key, offKey, onKey] of [
    [elements.muteOutgoingInterpreter, "outgoingInterpreterOff", "muteOutgoingInterpreter", "unmuteOutgoingInterpreter"],
    [elements.muteOutgoingTranslation, "outgoingTranslationMuted", "muteOutgoingTranslation", "unmuteOutgoingTranslation"],
    [elements.addOutgoingOriginal, "outgoingOriginalOn", "addOutgoingOriginal", "removeOutgoingOriginal"],
    [elements.muteOutgoing, "outgoingMuted", "muteOutgoing", "unmuteOutgoing"],
    [elements.muteIncomingInterpreter, "incomingInterpreterOff", "muteIncomingInterpreter", "unmuteIncomingInterpreter"],
    [elements.muteIncomingTranslation, "incomingTranslationMuted", "muteIncomingTranslation", "unmuteIncomingTranslation"],
    [elements.addIncomingOriginal, "incomingOriginalOn", "addIncomingOriginal", "removeIncomingOriginal"],
    [elements.muteIncoming, "incomingMuted", "muteIncoming", "unmuteIncoming"]
  ]) {
    const pressed = mutes[key] || Boolean(forced[key]);
    const label = t(locale, pressed ? onKey : offKey);
    button.setAttribute("aria-pressed", String(pressed));
    button.setAttribute("aria-label", label);
    button.title = label;
    button.disabled = busy || Boolean(overrides[key]);
  }
}

function render(state = currentState) {
  currentState = state;
  active = Boolean(state.active);
  lastStartedAt = state.startedAt || lastStartedAt;
  document.body.classList.toggle("is-live", active);
  document.body.classList.toggle("is-busy", busy);
  elements.toggle.classList.toggle("is-loading", busy || ["connecting", "reconnecting", "summarizing"].includes(state.phase));
  elements.toggle.disabled = busy;
  document.querySelectorAll("[data-mode], .quick-settings select, #swap-languages").forEach((control) => { control.disabled = active || busy; });
  elements.toggleLabel.textContent = active ? t(locale, "stop") : activeCaptureKind === "media" ? t(locale, "startTranslation") : t(locale, START_LABELS[currentMode]);
  const iconPath = elements.toggle.querySelector(".button-symbol path");
  if (iconPath) iconPath.setAttribute("d", active ? "M8 8h8v8H8z" : "m9 7 8 5-8 5V7Z");
  elements.status.textContent = t(locale, PHASES[state.phase] || (active ? "live" : "ready"));
  const error = state.error ? friendlyError(state.error) : actionError;
  elements.error.hidden = !error;
  elements.errorCopy.textContent = error;
  if (active && activeCaptureKind === "media") {
    const progress = MEDIA_PROGRESS[locale] || MEDIA_PROGRESS.en;
    elements.modeHelp.textContent = state.translatedUtteranceCount ? progress.translated(state.translatedUtteranceCount) : progress.waiting;
  } else {
    elements.modeHelp.textContent = t(locale, MODE_HINTS[currentMode]);
  }
  elements.notice.hidden = active || Boolean(currentSettings.recordingNoticeAccepted);
  renderMuteControls();
  renderTranscript();
  updateTimer();
}

function renderTranscript() {
  const savedWithMeeting = ["notes", "both", "transcript"].includes(currentMode);
  elements.transcriptPolicy.textContent = t(locale, savedWithMeeting ? "transcriptSaved" : "transcriptTemporary");
  elements.transcriptPolicy.dataset.saved = String(savedWithMeeting);
  elements.transcriptCount.textContent = String(currentState.transcriptCount || liveTranscript.length || 0);

  const signature = `${locale}:${liveTranscript.map((item) => `${item.id}:${item.text}`).join("|")}`;
  if (signature === transcriptSignature) {
    updateTranscriptEmptyState();
    return;
  }
  const wasNearBottom = elements.transcriptFeed.scrollHeight - elements.transcriptFeed.scrollTop - elements.transcriptFeed.clientHeight < 48;
  transcriptSignature = signature;
  elements.transcriptFeed.replaceChildren();
  if (!liveTranscript.length) {
    elements.transcriptFeed.append(elements.transcriptEmpty);
    updateTranscriptEmptyState();
    return;
  }
  for (const item of liveTranscript) {
    const line = document.createElement("article");
    line.className = `transcript-line ${item.speakerRole === "you" ? "is-you" : "is-participant"}`;
    const meta = document.createElement("header");
    const speaker = document.createElement("strong");
    const time = document.createElement("time");
    const copy = document.createElement("p");
    speaker.textContent = item.speaker || t(locale, item.speakerRole === "you" ? "speakerYou" : "speakerParticipant");
    time.textContent = formatDuration(item.offsetSeconds || 0);
    copy.textContent = item.text;
    meta.append(speaker, time);
    line.append(meta, copy);
    elements.transcriptFeed.append(line);
  }
  if (wasNearBottom) elements.transcriptFeed.scrollTop = elements.transcriptFeed.scrollHeight;
}

function updateTranscriptEmptyState() {
  if (!elements.transcriptEmpty.isConnected) return;
  elements.transcriptEmpty.classList.toggle("is-listening", active);
  elements.transcriptEmpty.querySelector("strong").textContent = t(locale, active ? "transcriptListening" : "transcriptWaitingTitle");
  elements.transcriptEmpty.querySelector("p").textContent = t(locale, active ? "transcriptListeningCopy" : "transcriptWaitingCopy");
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
  mutes = Object.fromEntries(MUTE_KEYS.map((key) => [key, Boolean(settings[key])]));
  locale = settings.interfaceLanguage || "en";
  localizePage(locale);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabUrl = tab?.url || "";
  activeCaptureKind = captureKindFor(tab?.url);
  elements.captureContext.textContent = (CAPTURE_LABELS[locale] || CAPTURE_LABELS.en)[activeCaptureKind];
  renderCaptureContext(activeCaptureKind);
  document.title = t(locale, "appTitle");
  currentMode = settings.mode;
  const languages = contextualLanguages(settings);
  document.querySelectorAll("[data-mode]").forEach((button) => button.classList.toggle("active", button.dataset.mode === currentMode));
  elements.interfaceLanguage.value = locale;
  elements.sourceLanguage.value = languages.source;
  elements.targetLanguage.value = languages.target;
  elements.outgoingDevice.closest(".quick-setting").hidden = true;
  elements.keyStatus.textContent = settings.apiKey ? maskKey(settings.apiKey) : t(locale, "apiNotConfigured");
  elements.usage.textContent = t(locale, "used", { minutes: Math.ceil((settings.usageSeconds || 0) / 60), sessions: settings.sessionCount || 0 });
  elements.source.textContent = languageLabel(languages.source);
  elements.target.textContent = languageLabel(languages.target);
  elements.setup.hidden = Boolean(settings.apiKey);
  elements.setupCopy.textContent = settings.apiKey ? "" : t(locale, "setupCopy");
  const result = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  liveTranscript = Array.isArray(result?.liveTranscript) ? result.liveTranscript : [];
  preparedTabId = result?.preparedTabId || null;
  outgoingRouteStatus = result?.outgoingRouteStatus || null;
  await renderPreflight(settings);
  const nextState = result?.state || { active: false, phase: "idle", error: result?.error || "" };
  if (!preparedTabId && activeCaptureKind === "media" && result?.captureError) nextState.error = result.captureError;
  render(nextState);
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
      if (activeCaptureKind === "media") {
        if (currentMode !== "translation") throw new Error(MEDIA_TRANSLATION_MODE_HINT[locale] || MEDIA_TRANSLATION_MODE_HINT.en);
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const languages = contextualLanguages(currentSettings);
        const result = await chrome.runtime.sendMessage({
          type: "START_TRANSLATION",
          tabId: tab?.id,
          captureKind: "media",
          sourceLanguage: languages.source,
          targetLanguage: languages.target
        });
        if (!result?.ok) throw new Error(result?.error || t(locale, "error"));
        currentState = result.state;
        return;
      }
      if (!currentSettings.recordingNoticeAccepted) {
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
async function toggleMute(key) {
  mutes = { ...mutes, [key]: !mutes[key] };
  renderMuteControls();
  await saveSettings({ [key]: mutes[key] });
  currentSettings[key] = mutes[key];
  // A running session needs the change applied to the live audio; an idle one only
  // needs the preference stored, which start() reads back.
  if (active) await chrome.runtime.sendMessage({ type: "SET_MUTE", ...mutes });
}

for (const [button, key] of [
  [elements.muteOutgoingInterpreter, "outgoingInterpreterOff"],
  [elements.muteOutgoingTranslation, "outgoingTranslationMuted"],
  [elements.addOutgoingOriginal, "outgoingOriginalOn"],
  [elements.muteOutgoing, "outgoingMuted"],
  [elements.muteIncomingInterpreter, "incomingInterpreterOff"],
  [elements.muteIncomingTranslation, "incomingTranslationMuted"],
  [elements.addIncomingOriginal, "incomingOriginalOn"],
  [elements.muteIncoming, "incomingMuted"]
]) {
  button.addEventListener("click", () => { toggleMute(key).catch(() => refresh()); });
}
elements.interfaceLanguage.addEventListener("change", async () => { await saveSettings({ interfaceLanguage: elements.interfaceLanguage.value }); await refresh(); });
elements.sourceLanguage.addEventListener("change", async () => {
  const key = activeCaptureKind === "media" ? "mediaSourceLanguage" : "sourceLanguage";
  await saveSettings({ [key]: elements.sourceLanguage.value });
  await refresh();
});
elements.targetLanguage.addEventListener("change", async () => {
  const key = activeCaptureKind === "media" ? "mediaTargetLanguage" : "targetLanguage";
  await saveSettings({ [key]: elements.targetLanguage.value });
  await refresh();
});
elements.swapLanguages.addEventListener("click", async () => {
  if (active || busy) return;
  const source = elements.sourceLanguage.value;
  const target = elements.targetLanguage.value;
  const sourceKey = activeCaptureKind === "media" ? "mediaSourceLanguage" : "sourceLanguage";
  const targetKey = activeCaptureKind === "media" ? "mediaTargetLanguage" : "targetLanguage";
  await saveSettings({ [sourceKey]: target, [targetKey]: source });
  await refresh();
});
for (const select of [elements.outgoingDevice, elements.incomingDevice]) select.addEventListener("change", async () => {
  const outgoingDeviceId = elements.outgoingDevice.value;
  await saveSettings({ outgoingDeviceId, incomingDeviceId: elements.incomingDevice.value, audioProfile: outgoingDeviceId === "default" ? "solo" : "conference" });
  await refresh();
});

refresh().then(() => listOutputs(currentSettings)).catch((error) => render({ active: false, phase: "error", error: friendlyError(error) }));
setInterval(updateTimer, 1000);
setInterval(() => { if (document.visibilityState === "visible" && !busy) refresh().catch(() => {}); }, 1000);
