import { DEFAULT_SETTINGS } from "./config.js";
import { t } from "./i18n.js";
import { RealtimeTranslator } from "./realtime.js";

const incomingOutput = document.querySelector("#incoming-output");
const outgoingOutput = document.querySelector("#outgoing-output");
const outgoingMonitor = document.querySelector("#outgoing-monitor");
let incomingTranslator;
let outgoingTranslator;
let microphoneStream;
let tabStream;
let state = freshState();
let meeting = null;
let activeSettings = { ...DEFAULT_SETTINGS };
let sessionStartedAt = 0;
let sessionTimer = null;
let reconnectTimer = null;
let reconnecting = false;
let generation = 0;
let speakerRecorder = null;
let speakerAudioChunks = [];
let preparedCapture = null;

const MODES = {
  translation: { audio: true, notes: false, summary: false },
  notes: { audio: false, notes: true, summary: true },
  both: { audio: true, notes: true, summary: true },
  transcript: { audio: false, notes: true, summary: false }
};

const SUMMARY_SECTION_TITLES = {
  Russian: ["Краткое содержание", "Основные темы", "Принятые решения", "Задачи", "Дедлайны", "Ответственные", "Открытые вопросы"],
  English: ["Overview", "Key topics", "Decisions", "Tasks", "Deadlines", "Owners", "Open questions"],
  Spanish: ["Resumen", "Temas clave", "Decisiones", "Tareas", "Fechas límite", "Responsables", "Preguntas abiertas"],
  German: ["Überblick", "Wichtige Themen", "Entscheidungen", "Aufgaben", "Fristen", "Verantwortliche", "Offene Fragen"],
  French: ["Vue d’ensemble", "Sujets clés", "Décisions", "Tâches", "Échéances", "Responsables", "Questions ouvertes"]
};
const SUMMARY_KEYS = ["overview", "topics", "decisions", "tasks", "deadlines", "owners", "questions"];

function tr(settings, key, variables) { return t(settings.interfaceLanguage || "en", key, variables); }

function freshState(overrides = {}) {
  return { active: false, phase: "idle", error: "", startedAt: 0, durationSeconds: 0, transcriptCount: 0, translatedUtteranceCount: 0, reconnectAttempt: 0, ...overrides };
}

async function storageGet(defaults = {}) {
  const result = await chrome.runtime.sendMessage({ type: "STORAGE_GET", defaults });
  if (!result?.ok) throw new Error(result?.error || t(activeSettings.interfaceLanguage, "readStorageError"));
  return result.value;
}

async function storageSet(value) {
  const result = await chrome.runtime.sendMessage({ type: "STORAGE_SET", value });
  if (!result?.ok) throw new Error(result?.error || t(activeSettings.interfaceLanguage, "writeStorageError"));
}

function startSpeakerRecording(stream) {
  if (typeof MediaRecorder === "undefined" || !stream) return;
  try {
    const chunks = [];
    speakerAudioChunks = chunks;
    speakerRecorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 24000 });
    speakerRecorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    speakerRecorder.start(1000);
  } catch {
    speakerRecorder = null;
    speakerAudioChunks = [];
  }
}

async function stopSpeakerRecording() {
  const recorder = speakerRecorder;
  const chunks = speakerAudioChunks;
  speakerRecorder = null;
  speakerAudioChunks = [];
  if (!recorder || !chunks) return null;
  if (recorder.state === "inactive") return new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
  return new Promise((resolve) => {
    recorder.addEventListener("stop", () => resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" })), { once: true });
    recorder.stop();
  });
}

function addTranscript(speaker, text, language, speakerRole = "") {
  if (!meeting || !text) return;
  meeting.transcript.push({ speaker, speakerRole, text, language, offsetSeconds: Math.max(0, Math.round((Date.now() - meeting.startedAt) / 1000)) });
  state.transcriptCount = meeting.transcript.length;
}

function responseText(payload) {
  if (typeof payload.output_text === "string") return payload.output_text;
  return (payload.output || []).flatMap((item) => item.content || []).filter((item) => item.type === "output_text").map((item) => item.text || "").join("\n").trim();
}

async function createSummary(settings, currentMeeting) {
  const lines = currentMeeting.transcript.map((item) => `[${Math.floor(item.offsetSeconds / 60)}:${String(item.offsetSeconds % 60).padStart(2, "0")}] ${item.speaker}: ${item.text}`).join("\n");
  if (!lines) return tr(settings, "summaryNoSpeech");
  const configuredSections = { ...DEFAULT_SETTINGS.summarySections, ...(settings.summarySections || {}) };
  const sectionTitles = SUMMARY_SECTION_TITLES[settings.sourceLanguage] || SUMMARY_SECTION_TITLES.English;
  const sections = SUMMARY_KEYS.filter((key) => configuredSections[key]).map((key) => sectionTitles[SUMMARY_KEYS.indexOf(key)]);
  if (!sections.length) return "";
  const detail = settings.summaryDetail === "brief" ? "brief" : settings.summaryDetail === "detailed" ? "detailed" : "balanced";
  const summaryLanguage = settings.sourceLanguage || "Russian";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      instructions: `Create a ${detail} meeting summary in ${summaryLanguage} as Markdown. Use only these sections: ${sections.join(", ")}. Do not add or merge sections. Do not invent facts; if a selected section has no evidence, state that it was not recorded.`,
      input: lines
    })
  });
  if (!response.ok) throw new Error(tr(settings, "summaryFailed", { status: response.status }));
  return responseText(await response.json()) || tr(settings, "summaryEmpty");
}

function speakerLabel(rawSpeaker, locale) {
  return t(locale, "speaker", { name: rawSpeaker });
}

async function diarizeRemoteSpeakers(settings, currentMeeting, audioBlob) {
  if (!settings.speakerDiarization || !audioBlob?.size || !currentMeeting.transcript?.length) return;
  if (audioBlob.size > 24_000_000) {
    currentMeeting.diarizationError = tr(settings, "diarizationTooLarge");
    return;
  }
  try {
    const formData = new FormData();
    formData.append("file", audioBlob, "meeting.webm");
    formData.append("model", "gpt-4o-transcribe-diarize");
    formData.append("response_format", "diarized_json");
    formData.append("chunking_strategy", "auto");
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${settings.apiKey}` },
      body: formData
    });
    if (!response.ok) throw new Error(`OpenAI ${response.status}`);
    const payload = await response.json();
    const segments = Array.isArray(payload.segments) ? payload.segments.filter((segment) => segment.text?.trim()) : [];
    if (!segments.length) return;
    const remoteTranscript = segments.map((segment) => ({
      speaker: speakerLabel(segment.speaker || "A", settings.interfaceLanguage || "en"), speakerRole: "participant",
      text: segment.text.trim(),
      language: settings.targetLanguage,
      offsetSeconds: Math.max(0, Math.round(Number(segment.start) || 0))
    }));
    currentMeeting.transcript = currentMeeting.transcript.filter((item) => item.speakerRole !== "participant").concat(remoteTranscript).sort((left, right) => left.offsetSeconds - right.offsetSeconds);
    currentMeeting.speakersDetected = [...new Set(remoteTranscript.map((item) => item.speaker))];
  } catch (error) {
    currentMeeting.diarizationError = error.message;
  }
}

async function saveMeeting(settings, currentMeeting, speakerAudio) {
  const finishedAt = Date.now();
  await diarizeRemoteSpeakers(settings, currentMeeting, speakerAudio);
  const record = { ...currentMeeting, finishedAt, durationSeconds: Math.round((finishedAt - currentMeeting.startedAt) / 1000), summary: "" };
  if (!settings.saveTranscript) record.transcript = [];
  if (MODES[currentMeeting.mode].summary) {
    try { record.summary = await createSummary(settings, currentMeeting); }
    catch (error) { record.summary = `> ${tr(settings, "summaryNotCreated", { error: error.message })}`; }
  }
  const { meetings = [] } = await storageGet({ meetings: [] });
  const cutoff = finishedAt - Math.max(1, Number(settings.retentionDays) || 30) * 86400000;
  const retained = meetings.filter((item) => Number(item.startedAt) >= cutoff);
  await storageSet({ meetings: [record, ...retained].slice(0, 100), lastMeetingId: record.id });
  return record;
}

async function applySink(element, deviceId) {
  if (deviceId && deviceId !== "default" && "setSinkId" in element) await element.setSinkId(deviceId);
}

function clearLifecycleTimers() {
  clearTimeout(sessionTimer);
  clearTimeout(reconnectTimer);
  sessionTimer = reconnectTimer = null;
}

async function releasePreparedCapture({ stopTracks = true } = {}) {
  const capture = preparedCapture;
  preparedCapture = null;
  if (!capture) return;
  try { capture.source.disconnect(); } catch {}
  if (stopTracks) capture.stream.getTracks().forEach((track) => track.stop());
  await capture.context.close().catch(() => {});
}

async function holdPreparedCapture(stream, tabId) {
  await releasePreparedCapture();
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  source.connect(context.destination);
  await context.resume();
  const capture = { tabId, stream, context, source };
  preparedCapture = capture;
  stream.getTracks().forEach((track) => {
    track.onended = () => {
      if (preparedCapture === capture) releasePreparedCapture({ stopTracks: false }).catch(() => {});
    };
  });
  return capture;
}

async function prepareTabCapture(streamId, tabId) {
  if (state.active) return { ok: true, active: true, preparedTabId: null };
  await releasePreparedCapture();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    video: false
  });
  const capture = await holdPreparedCapture(stream, tabId);
  return { ok: true, preparedTabId: tabId };
}

async function takePreparedCapture(tabId) {
  const capture = preparedCapture;
  if (!capture || capture.tabId !== tabId) throw new Error("TAB_CAPTURE_NOT_PREPARED");
  preparedCapture = null;
  try { capture.source.disconnect(); } catch {}
  await capture.context.close().catch(() => {});
  return capture.stream;
}

async function stop({ reason = "user", notify = false, error = "", persist = true } = {}) {
  const settings = activeSettings;
  const capturedMeeting = meeting;
  const capturedStartedAt = sessionStartedAt;
  const speakerAudio = await stopSpeakerRecording();
  const durationSeconds = capturedStartedAt ? Math.max(0, Math.round((Date.now() - capturedStartedAt) / 1000)) : 0;
  const hadActiveSession = state.active;
  const reusableTabStream = reason === "user" && activeSettings.captureKind === "media" && tabStream?.active ? tabStream : null;
  generation += 1;
  reconnecting = false;
  clearLifecycleTimers();
  state = { ...state, active: false };
  incomingTranslator?.close();
  outgoingTranslator?.close();
  microphoneStream?.getTracks().forEach((track) => track.stop());
  if (!reusableTabStream) tabStream?.getTracks().forEach((track) => track.stop());
  incomingTranslator = outgoingTranslator = microphoneStream = tabStream = null;
  incomingOutput.srcObject = outgoingOutput.srcObject = outgoingMonitor.srcObject = null;
  meeting = null;
  sessionStartedAt = 0;
  if (reusableTabStream) await holdPreparedCapture(reusableTabStream, activeSettings.captureTabId);
  state = freshState({ phase: capturedMeeting ? "summarizing" : "idle", durationSeconds, transcriptCount: state.transcriptCount });
  const completedMeeting = persist && capturedMeeting && MODES[capturedMeeting.mode]?.notes ? await saveMeeting(settings, capturedMeeting, speakerAudio) : null;
  if (hadActiveSession && durationSeconds > 0) {
    const usage = await storageGet({ usageSeconds: 0, sessionCount: 0 });
    await storageSet({ usageSeconds: Number(usage.usageSeconds || 0) + durationSeconds, sessionCount: Number(usage.sessionCount || 0) + 1 });
  }
  state = freshState({
    phase: reason === "limit" ? "limit" : error ? "error" : "idle",
    error: error || (reason === "limit" ? tr(settings, "sessionLimitReached", { minutes: settings.maxSessionMinutes }) : ""),
    durationSeconds,
    transcriptCount: state.transcriptCount
  });
  const result = { ok: true, state, meetingId: completedMeeting?.id || null, reason };
  if (notify) chrome.runtime.sendMessage({ type: "SESSION_ENDED", result }).catch(() => {});
  return result;
}

function translatorOptions(settings, mode, outgoing) {
  const mediaCapture = settings.captureKind === "media";
  const forwards = outgoing || mediaCapture;
  return {
    apiKey: settings.apiKey,
    inputStream: outgoing ? microphoneStream : tabStream,
    outputElement: outgoing ? outgoingOutput : incomingOutput,
    monitorElement: outgoing ? outgoingMonitor : null,
    from: forwards ? settings.sourceLanguage : settings.targetLanguage,
    to: forwards ? settings.targetLanguage : settings.sourceLanguage,
    voice: outgoing ? settings.outgoingVoice : settings.incomingVoice,
    verbatim: !mode.audio,
    manualChunkMs: mediaCapture ? 6000 : 0,
    onTranscript: (text) => {
      if (mode.audio && text) state.translatedUtteranceCount += 1;
      addTranscript(outgoing ? tr(settings, "speakerYou") : tr(settings, "speakerParticipant"), text, mode.audio ? (forwards ? settings.targetLanguage : settings.sourceLanguage) : (forwards ? settings.sourceLanguage : settings.targetLanguage), outgoing ? "you" : "participant");
    },
    onState: (phase) => { if (state.active && !reconnecting) state.phase = phase; },
    onDisconnect: () => scheduleReconnect(settings, mode)
  };
}

async function connectPair(settings, mode) {
  // A media tab (currently YouTube) needs only the tab-to-listener direction.
  // Avoiding a microphone stream keeps video translation usable without mic permission
  // and prevents an unused second realtime session.
  if (settings.captureKind !== "media") outgoingTranslator = new RealtimeTranslator(translatorOptions(settings, mode, true));
  incomingTranslator = new RealtimeTranslator(translatorOptions(settings, mode, false));
  await Promise.all([outgoingTranslator?.connect(), incomingTranslator.connect()]);
}

function scheduleReconnect(settings, mode) {
  if (!state.active || reconnecting) return;
  reconnecting = true;
  const expectedGeneration = generation;
  const attempt = Math.min(5, Number(state.reconnectAttempt || 0) + 1);
  state = { ...state, phase: "reconnecting", reconnectAttempt: attempt, error: "" };
  outgoingTranslator?.close();
  incomingTranslator?.close();
  reconnectTimer = setTimeout(async () => {
    if (!state.active || expectedGeneration !== generation) return;
    try {
      await connectPair(settings, mode);
      if (expectedGeneration !== generation) return;
      reconnecting = false;
      state = { ...state, phase: "live", reconnectAttempt: 0, error: "" };
    } catch (error) {
      reconnecting = false;
      if (attempt < 5) scheduleReconnect(settings, mode);
      else {
        await stop({ reason: "connection", error: tr(settings, "connectionRestoreFailed", { error: error.message }), notify: true });
      }
    }
  }, Math.min(16000, 1000 * 2 ** (attempt - 1)));
}

async function start(suppliedSettings = {}) {
  await stop();
  const settings = { ...DEFAULT_SETTINGS, ...suppliedSettings };
  activeSettings = settings;
  if (!settings.apiKey) throw new Error(tr(settings, "addApiKey"));
  const mode = MODES[settings.mode] || MODES.both;
  sessionStartedAt = Date.now();
  meeting = mode.notes ? { id: crypto.randomUUID(), title: tr(settings, "meetingTitle", { date: new Date().toLocaleString(settings.interfaceLanguage || "en") }), startedAt: sessionStartedAt, mode: settings.mode, languages: [settings.sourceLanguage, settings.targetLanguage], transcript: [] } : null;
  state = freshState({ active: true, phase: "connecting", startedAt: sessionStartedAt });
  try {
    if (settings.captureKind !== "media") {
      microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    }
    tabStream = await takePreparedCapture(settings.captureTabId);
    if (mode.notes && settings.speakerDiarization) startSpeakerRecording(tabStream);
    tabStream.getTracks().forEach((track) => { track.onended = () => { if (state.active) stop({ reason: "tab_closed", notify: true }); }; });
    await applySink(outgoingOutput, settings.outgoingDeviceId);
    await applySink(incomingOutput, settings.incomingDeviceId);
    await applySink(outgoingMonitor, settings.incomingDeviceId);
    outgoingOutput.muted = incomingOutput.muted = !mode.audio;
    outgoingMonitor.muted = !mode.audio || settings.audioProfile !== "conference" || settings.monitorLevel === "off";
    outgoingMonitor.volume = settings.monitorLevel === "quiet" ? 0.2 : 1;
    generation += 1;
    await connectPair(settings, mode);
    state.phase = "live";
    sessionTimer = setTimeout(() => stop({ reason: "limit", notify: true }), Math.max(1, Number(settings.maxSessionMinutes) || 90) * 60000);
    return { ok: true, state };
  } catch (error) {
    await stop({ reason: "error", persist: false });
    state = freshState({ phase: "error", error: error.message });
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "offscreen") return false;
  if (message.type === "GET_STATUS") {
    sendResponse({ ok: true, state, preparedTabId: preparedCapture?.tabId || null });
    return false;
  }
  const action = message.type === "PREPARE_TAB_CAPTURE" ? prepareTabCapture(message.streamId, message.tabId) : message.type === "START_TRANSLATION" ? start(message.settings) : message.type === "STOP_TRANSLATION" ? stop() : Promise.resolve({ ok: false, error: t(activeSettings.interfaceLanguage, "unknownCommand") });
  action.then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
