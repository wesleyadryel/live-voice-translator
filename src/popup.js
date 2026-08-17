import { clampClarity, clampGain, clampHighCut, clampListenLevel, clampLowCut, clampVoiceGain, CLARITY_OFF, HIGH_CUT_OFF, LOW_CUT_OFF, MIN_VOICE_GAIN, UNITY_GAIN } from "./audio-gain.js";
import { loadSettings, maskKey, saveSettings } from "./config.js";
import { languageName, localizePage, t } from "./i18n.js";
import { createLocalTranslator, localTranslationAvailability, localTranslationSupported, translateLocally } from "./local-translator.js";
import { clampPauseMs, PAUSE_AUTO_MS } from "./realtime.js";

const $ = (selector) => document.querySelector(selector);
const elements = {
  toggle: $("#toggle"), toggleLabel: $("#toggle-label"), status: $("#status-label"), phase: $("#phase-pill"),
  timer: $("#session-timer"), error: $("#error"), errorCopy: $("#error-copy"),
  keyStatus: $("#key-status"), usage: $("#usage-label"), source: $("#source-label"), target: $("#target-label"),
  setup: $("#setup-banner"), setupCopy: $("#setup-copy"), notice: $("#recording-notice"),
  modeHelp: $("#mode-help"), interfaceLanguage: $("#interface-language"), sourceLanguage: $("#source-language"), targetLanguage: $("#target-language"), outgoingDevice: $("#outgoing-device"), incomingDevice: $("#incoming-device"), captureContext: $("#capture-context"), swapLanguages: $("#swap-languages"),
  transcript: $("#live-transcript"), transcriptFeed: $("#transcript-feed"), transcriptEmpty: $("#transcript-empty"), transcriptCount: $("#transcript-count"), transcriptPolicy: $("#transcript-policy"),
  sourceFeed: $("#source-feed"), sourceEmpty: $("#source-empty"), sourceCount: $("#source-count"),
  sessionControls: $("#session-controls"), muteRowOutgoing: $("#mute-row-outgoing"), muteRowIncoming: $("#mute-row-incoming"), muteButtonsOutgoing: $("#mute-buttons-outgoing"),
  muteOutgoingInterpreter: $("#mute-outgoing-interpreter"), muteOutgoingTranslation: $("#mute-outgoing-translation"), addOutgoingOriginal: $("#add-outgoing-original"), addOutgoingMonitor: $("#add-outgoing-monitor"), muteOutgoing: $("#mute-outgoing"),
  muteIncomingInterpreter: $("#mute-incoming-interpreter"), muteIncomingTranslation: $("#mute-incoming-translation"), addIncomingOriginal: $("#add-incoming-original"), addIncomingReturn: $("#add-incoming-return"), muteIncoming: $("#mute-incoming")
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
// Line id → the same sentence in the other language, translated on this machine. The
// feed is rebuilt from scratch on every change, so the text has to be kept outside it.
const lineTranslations = new Map();
const lineTranslationsInFlight = new Set();
let localTranslationReady = false;
let pretranslating = false;
// Lines currently reading as their translation. Survives the feed being rebuilt, which
// happens on every new word spoken.
const shownTranslations = new Set();
let gainAdjusting = false;
const MUTE_KEYS = ["outgoingInterpreterOff", "outgoingTranslationMuted", "outgoingOriginalOn", "outgoingMonitorOn", "outgoingMuted", "incomingInterpreterOff", "incomingTranslationMuted", "incomingOriginalOn", "incomingReturnOn", "incomingMuted"];
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
  // A media tab has no microphone at all, so that side disappears entirely. In the
  // note-only modes the microphone is still captured and still transcribed — only
  // the buttons that route a translated voice have nothing to act on, so they go and
  // the level control for that microphone stays.
  elements.muteRowOutgoing.hidden = activeCaptureKind === "media";
  elements.muteButtonsOutgoing.hidden = !translatesAloud;
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
    // Nothing translated is going out, so there is no return feed to listen to.
    outgoingMonitorOn: !outgoingTranslationAudible,
    incomingInterpreterOff: mutes.incomingMuted,
    incomingTranslationMuted: mutes.incomingMuted || mutes.incomingInterpreterOff,
    incomingOriginalOn: mutes.incomingMuted || forced.incomingOriginalOn,
    // Nothing is being translated for you, so there is no translation to send back.
    incomingReturnOn: mutes.incomingInterpreterOff || mutes.incomingMuted
  };
  for (const [button, key, offKey, onKey] of [
    [elements.muteOutgoingInterpreter, "outgoingInterpreterOff", "muteOutgoingInterpreter", "unmuteOutgoingInterpreter"],
    [elements.muteOutgoingTranslation, "outgoingTranslationMuted", "muteOutgoingTranslation", "unmuteOutgoingTranslation"],
    [elements.addOutgoingOriginal, "outgoingOriginalOn", "addOutgoingOriginal", "removeOutgoingOriginal"],
    [elements.addOutgoingMonitor, "outgoingMonitorOn", "enableOutgoingMonitor", "disableOutgoingMonitor"],
    [elements.muteOutgoing, "outgoingMuted", "muteOutgoing", "unmuteOutgoing"],
    [elements.muteIncomingInterpreter, "incomingInterpreterOff", "muteIncomingInterpreter", "unmuteIncomingInterpreter"],
    [elements.muteIncomingTranslation, "incomingTranslationMuted", "muteIncomingTranslation", "unmuteIncomingTranslation"],
    [elements.addIncomingOriginal, "incomingOriginalOn", "addIncomingOriginal", "removeIncomingOriginal"],
    [elements.addIncomingReturn, "incomingReturnOn", "enableIncomingReturn", "disableIncomingReturn"],
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

// Audio that cannot be understood is rarely fixed by one knob: the level decides
// whether the interpreter hears the voice at all, the filters decide whether the
// words inside it are distinct, and the pause window decides where a phrase is
// considered to end. All of them apply to the running call, because none of them can
// be judged except while someone is talking.
const AUDIO_CONTROLS = [
  { id: "gain", field: "gain", suffix: "Gain", clamp: clampGain, reset: UNITY_GAIN, format: (value) => `${value.toFixed(1)}×` },
  // Sending level, not listening level: it decides how loud you arrive on the other
  // side and nothing else, so it exists for your own microphone only. Zero is a real
  // position — the participant hears nothing of your untranslated voice — while the
  // interpreter carries on transcribing it.
  { id: "voice", field: "voiceGain", suffix: "VoiceGain", clamp: clampVoiceGain, reset: UNITY_GAIN, directions: ["outgoing"], format: (value) => (value <= MIN_VOICE_GAIN ? t(locale, "filterOff") : `${value.toFixed(1)}×`) },
  // The same idea on the way back, and the same field, but a listening level rather
  // than a sending one: it stops at untouched, because the voices arriving here have
  // already been lifted as far as they need to be.
  { id: "listen", field: "voiceGain", suffix: "VoiceGain", clamp: clampListenLevel, reset: UNITY_GAIN, directions: ["incoming"], format: (value) => (value <= MIN_VOICE_GAIN ? t(locale, "filterOff") : `${Math.round(value * 100)}%`) },
  { id: "low-cut", field: "lowCutHz", suffix: "LowCutHz", clamp: clampLowCut, reset: LOW_CUT_OFF, format: (value) => (value <= LOW_CUT_OFF ? t(locale, "filterOff") : `${Math.round(value)} Hz`) },
  { id: "clarity", field: "clarityDb", suffix: "ClarityDb", clamp: clampClarity, reset: CLARITY_OFF, format: (value) => (value <= CLARITY_OFF ? t(locale, "filterOff") : `+${value.toFixed(1)} dB`) },
  { id: "high-cut", field: "highCutHz", suffix: "HighCutHz", clamp: clampHighCut, reset: HIGH_CUT_OFF, format: (value) => (value >= HIGH_CUT_OFF ? t(locale, "filterOff") : `${(value / 1000).toFixed(1)} kHz`) },
  { id: "pause", field: "pauseMs", suffix: "PauseMs", clamp: clampPauseMs, reset: PAUSE_AUTO_MS, format: (value) => (value <= PAUSE_AUTO_MS ? t(locale, "pauseAuto") : `${(value / 1000).toFixed(1)} s`) }
];

const AUDIO_FIELDS = ["outgoing", "incoming"].flatMap((direction) => AUDIO_CONTROLS
  .filter((control) => !control.directions || control.directions.includes(direction))
  .map((control) => ({
    ...control,
    direction,
    key: `${direction}${control.suffix}`,
    slider: $(`#${direction}-${control.id}`),
    output: $(`#${direction}-${control.id}-value`)
  })));

function renderAudio(settings) {
  // Status refreshes run on a timer; writing a slider back mid-drag would fight the
  // user's hand.
  if (gainAdjusting) return;
  for (const field of AUDIO_FIELDS) {
    const value = field.clamp(settings[field.key]);
    field.slider.value = String(value);
    field.output.textContent = field.format(value);
  }
}

async function changeAudio(field, rawValue) {
  const value = field.clamp(rawValue);
  currentSettings[field.key] = value;
  field.output.textContent = field.format(value);
  if (active) await chrome.runtime.sendMessage({ type: "SET_AUDIO", [field.direction]: { [field.field]: value } });
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

// The glyph is the one every translation control uses — a letter beside a character in
// another script — so it needs no label to be read as "show this in the other language".
const TRANSLATE_ICON = "M12.87 15.07 10.33 12.56l.03-.03A17.5 17.5 0 0 0 14.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04ZM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12Zm-2.62 7 1.62-4.33L19.12 17h-3.24Z";

function translateButton(item, showing) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "translate-toggle";
  button.dataset.translate = item.id;
  button.setAttribute("aria-pressed", String(showing));
  button.title = t(locale, showing ? "showOriginal" : "showTranslation");
  button.setAttribute("aria-label", button.title);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", TRANSLATE_ICON);
  svg.append(path);
  button.append(svg);
  return button;
}

// One column per kind of text an utterance produces: the interpreter's translation on
// the left, the words as they were spoken on the right. Reading them side by side is
// also what makes a failed dubbing obvious — the right column keeps filling while the
// left one stops.
function fillFeed(feed, empty, items) {
  const wasNearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 48;
  feed.replaceChildren();
  if (!items.length) {
    feed.append(empty);
    return;
  }
  for (const item of items) {
    const line = document.createElement("article");
    // Original speech is shown quieter than the translation: it is the same utterance
    // in the language it was said, kept so nothing is lost when no dubbing follows.
    line.className = `transcript-line ${item.speakerRole === "you" ? "is-you" : "is-participant"}${item.kind === "source" ? " is-source" : ""}${item.pending ? " is-pending" : ""}`;
    line.dataset.id = item.id;
    const meta = document.createElement("header");
    const speaker = document.createElement("strong");
    const time = document.createElement("time");
    const copy = document.createElement("p");
    speaker.textContent = item.speaker || t(locale, item.speakerRole === "you" ? "speakerYou" : "speakerParticipant");
    time.textContent = formatDuration(item.offsetSeconds || 0);
    // The line reads either as it was said or as it means, never both at once: the
    // button swaps the text in place rather than adding a second copy of it.
    const showing = shownTranslations.has(item.id);
    const translation = lineTranslations.get(item.id);
    copy.textContent = showing ? translation || t(locale, "translating") : item.text;
    if (showing) line.classList.add("is-translated");
    meta.append(speaker, time);
    // A line still being spoken has no settled text to translate yet.
    if (!item.pending) meta.append(translateButton(item, showing));
    line.append(meta, copy);
    feed.append(line);
  }
  if (wasNearBottom) feed.scrollTop = feed.scrollHeight;
}

function renderTranscript() {
  const savedWithMeeting = ["notes", "both", "transcript"].includes(currentMode);
  elements.transcriptPolicy.textContent = t(locale, savedWithMeeting ? "transcriptSaved" : "transcriptTemporary");
  elements.transcriptPolicy.dataset.saved = String(savedWithMeeting);
  // The spoken column exists to catch a dubbing that failed. The note-only modes never
  // dub anything — their single feed already is the spoken words — so there the panel
  // stays one column rather than showing an empty half.
  const dubbing = ["translation", "both"].includes(currentMode);
  elements.transcript.dataset.columns = dubbing ? "2" : "1";
  const translated = liveTranscript.filter((item) => item.kind !== "source");
  const spoken = liveTranscript.filter((item) => item.kind === "source");
  elements.transcriptCount.textContent = String(currentState.transcriptCount || translated.length || 0);
  elements.sourceCount.textContent = String(currentState.sourceTranscriptCount || spoken.length || 0);

  const signature = `${locale}:${liveTranscript.map((item) => `${item.id}:${item.text}`).join("|")}`;
  if (signature === transcriptSignature) {
    updateTranscriptEmptyState();
    return;
  }
  transcriptSignature = signature;
  fillFeed(elements.transcriptFeed, elements.transcriptEmpty, translated);
  fillFeed(elements.sourceFeed, elements.sourceEmpty, spoken);
  updateTranscriptEmptyState();
  pretranslateLines().catch(() => {});
}

// A line spoken in one language is read in the one the other person uses — the same
// pair the session was set up with, in whichever direction this line runs.
function otherLanguage(item) {
  const source = currentSettings.sourceLanguage;
  const target = currentSettings.targetLanguage;
  if (!source || !target) return "";
  return item.language === source ? target : source;
}

async function translateLine(id) {
  if (!localTranslationReady || lineTranslations.has(id) || lineTranslationsInFlight.has(id)) return "";
  // A line still being spoken would be translated half-said, and then again on the
  // next word. It waits until the utterance is closed.
  const item = liveTranscript.find((entry) => entry.id === id);
  if (!item || item.pending || !item.text) return "";
  const to = otherLanguage(item);
  if (!to || to === item.language) return "";
  lineTranslationsInFlight.add(id);
  const text = await translateLocally(item.text, item.language, to).catch(() => "");
  lineTranslationsInFlight.delete(id);
  if (text) lineTranslations.set(id, text);
  return text;
}

// Translating lines as they finish, rather than when the button is pressed, is what
// makes the swap instant. It runs on the local model, so it costs nothing but a little
// CPU, and only the visible window is ever considered.
async function pretranslateLines() {
  if (!localTranslationReady || pretranslating) return;
  const queue = liveTranscript.filter((item) => !item.pending && item.text && !lineTranslations.has(item.id)).slice(-12);
  if (!queue.length) return;
  pretranslating = true;
  for (const item of queue) await translateLine(item.id).catch(() => {});
  pretranslating = false;
}

// Toggling changes nothing about the transcript itself, so the signature that guards
// against needless repaints would swallow it.
function repaintTranscript() {
  transcriptSignature = "";
  renderTranscript();
}

// The first press is also the user gesture Chrome requires before it will fetch a
// language pack, which is why the download hangs off this and not off a page load.
async function ensureLocalTranslation() {
  if (localTranslationReady || !localTranslationSupported()) return localTranslationReady;
  const settings = currentSettings;
  const ready = await Promise.all([
    createLocalTranslator(settings.sourceLanguage, settings.targetLanguage),
    createLocalTranslator(settings.targetLanguage, settings.sourceLanguage)
  ]).catch(() => []);
  localTranslationReady = ready.some(Boolean);
  return localTranslationReady;
}

async function toggleLineTranslation(id) {
  if (shownTranslations.delete(id)) {
    repaintTranscript();
    return;
  }
  shownTranslations.add(id);
  repaintTranscript();
  if (lineTranslations.has(id)) return;
  await ensureLocalTranslation();
  const text = await translateLine(id).catch(() => "");
  // Nothing came back — no language pack, no support, no pair. The line goes back to
  // what it was rather than sitting on a placeholder that will never resolve.
  if (!text) shownTranslations.delete(id);
  repaintTranscript();
}

// Availability is only re-read when the pair changes: the answer cannot change between
// two ticks of a one-second refresh, and the translations of the old pair are stale.
let translationPair = "";

async function renderLocalTranslation(settings) {
  const pair = `${settings.sourceLanguage}>${settings.targetLanguage}`;
  if (pair === translationPair) return;
  translationPair = pair;
  lineTranslations.clear();
  shownTranslations.clear();
  if (!localTranslationSupported()) {
    localTranslationReady = false;
    console.info("[LiveVoice] local translation unsupported in this Chrome");
    return;
  }
  const states = await Promise.all([
    localTranslationAvailability(settings.sourceLanguage, settings.targetLanguage),
    localTranslationAvailability(settings.targetLanguage, settings.sourceLanguage)
  ]);
  // Ready means the pack is on disk and lines can be translated before anyone asks.
  // A pack still to be downloaded waits for the first press of a line's button, which
  // is the gesture Chrome needs to fetch it.
  localTranslationReady = states.some((state) => state === "available");
  console.info("[LiveVoice] local translation", pair, states.join("/"));
}

function updateEmptyState(empty, waitingTitle, waitingCopy) {
  if (!empty.isConnected) return;
  empty.classList.toggle("is-listening", active);
  empty.querySelector("strong").textContent = t(locale, active ? "transcriptListening" : waitingTitle);
  empty.querySelector("p").textContent = t(locale, active ? "transcriptListeningCopy" : waitingCopy);
}

function updateTranscriptEmptyState() {
  updateEmptyState(elements.transcriptEmpty, "transcriptWaitingTitle", "transcriptWaitingCopy");
  updateEmptyState(elements.sourceEmpty, "spokenWaitingTitle", "spokenWaitingCopy");
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
  renderAudio(settings);
  await renderLocalTranslation(settings).catch(() => {});
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
$("#open-usage").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("src/usage.html") }));
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
  [elements.addOutgoingMonitor, "outgoingMonitorOn"],
  [elements.muteOutgoing, "outgoingMuted"],
  [elements.muteIncomingInterpreter, "incomingInterpreterOff"],
  [elements.muteIncomingTranslation, "incomingTranslationMuted"],
  [elements.addIncomingOriginal, "incomingOriginalOn"],
  [elements.addIncomingReturn, "incomingReturnOn"],
  [elements.muteIncoming, "incomingMuted"]
]) {
  button.addEventListener("click", () => { toggleMute(key).catch(() => refresh()); });
}
for (const field of AUDIO_FIELDS) {
  field.slider.addEventListener("pointerdown", () => { gainAdjusting = true; });
  field.slider.addEventListener("input", () => {
    gainAdjusting = true;
    changeAudio(field, field.slider.value).catch(() => {});
  });
  // Stored only when the user settles on a value, so a drag does not write on every
  // intermediate step; the live audio already followed it through input.
  field.slider.addEventListener("change", async () => {
    gainAdjusting = false;
    await saveSettings({ [field.key]: field.clamp(field.slider.value) }).catch(() => {});
  });
  field.slider.addEventListener("blur", () => { gainAdjusting = false; });
  // Untouched is a single point on a continuous range and hard to hit by dragging,
  // so it stays one gesture away.
  field.slider.addEventListener("dblclick", async () => {
    gainAdjusting = false;
    field.slider.value = String(field.reset);
    await changeAudio(field, field.reset).catch(() => {});
    await saveSettings({ [field.key]: field.reset }).catch(() => {});
  });
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

// The once-a-second refresh reads settings, tabs and devices as well, which is far
// more than a new line of speech needs. Text arriving between those ticks takes this
// narrower path: the transcript alone, drawn as it is spoken.
async function syncTranscript() {
  const result = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  if (!result) return;
  liveTranscript = Array.isArray(result.liveTranscript) ? result.liveTranscript : [];
  if (result.state) currentState = { ...currentState, ...result.state };
  renderTranscript();
}

elements.transcript.addEventListener("click", (event) => {
  const button = event.target.closest?.(".translate-toggle");
  if (button) toggleLineTranslation(button.dataset.translate).catch(() => {});
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "TRANSCRIPT_UPDATED" && document.visibilityState === "visible" && !busy) {
    syncTranscript().catch(() => {});
  }
  return false;
});

refresh().then(() => listOutputs(currentSettings)).catch((error) => render({ active: false, phase: "error", error: friendlyError(error) }));
setInterval(updateTimer, 1000);
setInterval(() => { if (document.visibilityState === "visible" && !busy) refresh().catch(() => {}); }, 1000);
