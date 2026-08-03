import { DEFAULT_SETTINGS } from "./config.js";
import { t } from "./i18n.js";
import { RealtimeTranslator } from "./realtime.js";
import { createSpeechGate } from "./speech-gate.js";

const incomingOutput = document.querySelector("#incoming-output");
const outgoingOutput = document.querySelector("#outgoing-output");
const outgoingMonitor = document.querySelector("#outgoing-monitor");
let incomingTranslator;
let outgoingTranslator;
let microphoneStream;
let tabStream;
let state = freshState();
let meeting = null;
let liveTranscript = [];
let activeSettings = { ...DEFAULT_SETTINGS };
let sessionStartedAt = 0;
let sessionTimer = null;
let reconnectTimer = null;
let reconnecting = false;
let generation = 0;
let outgoingMuted = false;
let outgoingTranslationMuted = false;
let incomingMuted = false;
let incomingTranslationMuted = false;
let outgoingInterpreterOff = false;
let incomingInterpreterOff = false;
let outgoingOriginalOn = false;
let incomingOriginalOn = false;
let outgoingMonitorOn = false;
let monitorFeedPc = null;
let sessionUsage = { inputTokens: 0, outputTokens: 0, inputAudioTokens: 0, outputAudioTokens: 0, cachedTokens: 0 };
let usageFlushTimer = null;
const pendingBuckets = new Map();
const speechGates = new Map();
const idleTimers = new Map();
const idleParked = new Set();
const passthroughs = new Map();
let speakerRecorder = null;
let speakerAudioChunks = [];
let preparedCapture = null;

const MODES = {
  translation: { audio: true, notes: false, summary: false },
  notes: { audio: false, notes: true, summary: true },
  both: { audio: true, notes: true, summary: true },
  transcript: { audio: false, notes: true, summary: false }
};
const MAX_LIVE_TRANSCRIPT_ITEMS = 40;

const SUMMARY_SECTION_TITLES = {
  Russian: ["Краткое содержание", "Основные темы", "Принятые решения", "Задачи", "Дедлайны", "Ответственные", "Открытые вопросы"],
  English: ["Overview", "Key topics", "Decisions", "Tasks", "Deadlines", "Owners", "Open questions"],
  Spanish: ["Resumen", "Temas clave", "Decisiones", "Tareas", "Fechas límite", "Responsables", "Preguntas abiertas"],
  German: ["Überblick", "Wichtige Themen", "Entscheidungen", "Aufgaben", "Fristen", "Verantwortliche", "Offene Fragen"],
  French: ["Vue d’ensemble", "Sujets clés", "Décisions", "Tâches", "Échéances", "Responsables", "Questions ouvertes"],
  "Brazilian Portuguese": ["Visão geral", "Tópicos principais", "Decisões", "Tarefas", "Prazos", "Responsáveis", "Questões em aberto"]
};
const SUMMARY_KEYS = ["overview", "topics", "decisions", "tasks", "deadlines", "owners", "questions"];

function tr(settings, key, variables) { return t(settings.interfaceLanguage || "en", key, variables); }

// tabCapture and the WebRTC bridge both divert audio away from its normal path,
// so an untranslated voice is only audible while its passthrough is connected.
function setPassthrough(key, enabled, stream, deviceId) {
  let entry = passthroughs.get(key);
  if (enabled) {
    if (!stream) return;
    if (!entry) {
      const context = new AudioContext();
      entry = { context, source: context.createMediaStreamSource(stream), connected: false };
      if ("setSinkId" in context) context.setSinkId(!deviceId || deviceId === "default" ? "" : deviceId).catch(() => {});
      passthroughs.set(key, entry);
    }
    if (entry.connected) return;
    entry.source.connect(entry.context.destination);
    entry.context.resume().catch(() => {});
    entry.connected = true;
    return;
  }
  if (!entry?.connected) return;
  try { entry.source.disconnect(); } catch {}
  entry.connected = false;
}

// Receives the conference tab's translated audio over a local loopback connection.
// Playing it here instead of in the tab is what stops tabCapture from feeding the
// return audio back into the incoming interpreter.
function stopMonitorFeed() {
  monitorFeedPc?.close();
  monitorFeedPc = null;
  outgoingMonitor.srcObject = null;
}

async function acceptMonitorFeed(sdp) {
  stopMonitorFeed();
  const pc = new RTCPeerConnection();
  monitorFeedPc = pc;
  pc.ontrack = (event) => {
    outgoingMonitor.srcObject = event.streams[0];
    outgoingMonitor.play().catch(() => {});
    applyMuteState();
  };
  await pc.setRemoteDescription({ type: "offer", sdp });
  await pc.setLocalDescription(await pc.createAnswer());
  if (pc.iceGatheringState !== "complete") {
    await new Promise((resolve) => {
      const done = () => {
        if (pc.iceGatheringState !== "complete") return;
        pc.removeEventListener("icegatheringstatechange", done);
        resolve();
      };
      pc.addEventListener("icegatheringstatechange", done);
      setTimeout(resolve, 1500);
    });
  }
  return pc.localDescription.sdp;
}

async function releasePassthroughs() {
  const entries = [...passthroughs.values()];
  passthroughs.clear();
  for (const entry of entries) {
    try { entry.source.disconnect(); } catch {}
    await entry.context.close().catch(() => {});
  }
}

// Mute only gates audio: the realtime sessions stay connected and the transcript
// keeps filling, so history is never silently interrupted by a muted moment.
// Silencing a translation swaps in the matching original voice; silencing a whole
// direction leaves it truly silent. The note-only modes never translate aloud, so
// there the original audio plays unless the whole direction is muted.
function applyMuteState() {
  const audioEnabled = Boolean((MODES[activeSettings.mode] || MODES.both).audio);

  // The untranslated audio plays when it is asked for, and also whenever the
  // translated voice is not playing — muted, swapped out, or interpreter off — so
  // a direction is never unintentionally silent.
  // A parked direction has no session, so its translated voice cannot be playing —
  // the untranslated audio takes over until the speaker brings the session back.
  const incomingTranslationAudible = audioEnabled && !incomingInterpreterOff && !idleParked.has("incoming") && !incomingMuted && !incomingTranslationMuted;
  incomingOutput.muted = !incomingTranslationAudible;
  setPassthrough("incoming", !incomingMuted && (incomingOriginalOn || !incomingTranslationAudible), tabStream, activeSettings.incomingDeviceId);

  // Solo routing plays the interpreter into the meeting's own output device. The
  // WebRTC path never reaches here: its conference tab swaps the sender instead.
  const outgoingTranslationAudible = audioEnabled && !outgoingInterpreterOff && !idleParked.has("outgoing") && !outgoingMuted && !outgoingTranslationMuted;
  outgoingOutput.muted = !outgoingTranslationAudible;
  setPassthrough("outgoing", audioEnabled && !outgoingMuted && (outgoingOriginalOn || !outgoingTranslationAudible), microphoneStream, activeSettings.outgoingDeviceId);
  // The panel's return-feed button is the explicit switch; monitorLevel in settings
  // stays responsible for how loud that return feed is.
  outgoingMonitor.muted = !outgoingTranslationAudible || !outgoingMonitorOn;
}

function statusState() {
  return { ...state, outgoingMuted, outgoingTranslationMuted, incomingMuted, incomingTranslationMuted, outgoingInterpreterOff, incomingInterpreterOff, outgoingOriginalOn, incomingOriginalOn, outgoingMonitorOn, sessionUsage: { ...sessionUsage } };
}

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
  if (!text) return;
  const startedAt = meeting?.startedAt || sessionStartedAt || Date.now();
  const item = {
    id: crypto.randomUUID(),
    speaker,
    speakerRole,
    text,
    language,
    offsetSeconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000))
  };
  liveTranscript.push(item);
  if (liveTranscript.length > MAX_LIVE_TRANSCRIPT_ITEMS) liveTranscript = liveTranscript.slice(-MAX_LIVE_TRANSCRIPT_ITEMS);
  if (meeting) meeting.transcript.push(item);
  state.transcriptCount += 1;
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
  const instructions = `Create a ${detail} meeting summary in ${summaryLanguage} as Markdown. Use only these sections: ${sections.join(", ")}. Do not add or merge sections. Do not invent facts; if a selected section has no evidence, state that it was not recorded.`;

  // Summarising is plain text and runs once, after the call, so latency does not
  // matter here — the one place a local model can replace the API outright.
  if (settings.summaryProvider === "ollama") {
    const base = (settings.ollamaUrl || DEFAULT_SETTINGS.ollamaUrl).replace(/\/+$/, "");
    const response = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: settings.ollamaModel || DEFAULT_SETTINGS.ollamaModel,
        stream: false,
        messages: [{ role: "system", content: instructions }, { role: "user", content: lines }]
      })
    });
    if (!response.ok) throw new Error(tr(settings, "summaryFailed", { status: `Ollama ${response.status}` }));
    return (await response.json())?.message?.content?.trim() || tr(settings, "summaryEmpty");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", instructions, input: lines })
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
    // Recorded so the history can state which engine actually wrote the notes,
    // rather than leaving the user to guess whether the local model was used.
    record.summaryEngine = settings.summaryProvider === "ollama"
      ? { provider: "ollama", model: settings.ollamaModel || DEFAULT_SETTINGS.ollamaModel }
      : { provider: "openai", model: "gpt-5.6-sol" };
    try { record.summary = await createSummary(settings, currentMeeting); }
    catch (error) {
      record.summary = `> ${tr(settings, "summaryNotCreated", { error: error.message })}`;
      record.summaryEngine = { ...record.summaryEngine, failed: true };
    }
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
  // Tab capture can only be authorised from a toolbar click, so a still-live stream
  // is kept for the next start instead of being thrown away. This applies to every
  // capture kind: a meeting that was stopped is the most likely one to be restarted.
  const reusableTabStream = reason !== "tab_closed" && tabStream?.active ? tabStream : null;
  generation += 1;
  reconnecting = false;
  stopMonitorFeed();
  releaseSpeechGates();
  await releasePassthroughs();
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
  await persistUsage();
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

const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, inputAudioTokens: 0, outputAudioTokens: 0, cachedTokens: 0 };

// Reported by the API per response, so this is measured cost rather than an
// estimate from elapsed time.
const USAGE_FIELDS = ["inputTokens", "outputTokens", "inputAudioTokens", "outputAudioTokens", "cachedTokens"];
const USAGE_RETENTION_MINUTES = 90 * 24 * 60;

// Stored per minute rather than per day: anything coarser makes a by-minute or
// by-hour view impossible to reconstruct later. Only minutes with actual traffic
// are written, so an hour of talking costs 60 small rows.
function recordUsage(usage) {
  for (const key of USAGE_FIELDS) sessionUsage[key] += Number(usage[key]) || 0;
  const minute = String(Math.floor(Date.now() / 60000));
  const bucket = pendingBuckets.get(minute) || USAGE_FIELDS.map(() => 0);
  USAGE_FIELDS.forEach((key, index) => { bucket[index] += Number(usage[key]) || 0; });
  pendingBuckets.set(minute, bucket);
  // Written shortly after it arrives rather than only at stop: the offscreen
  // document can be torn down at any time, and unsaved usage would vanish with it.
  clearTimeout(usageFlushTimer);
  usageFlushTimer = setTimeout(() => { persistUsage().catch(() => {}); }, 3000);
}

async function persistUsage() {
  clearTimeout(usageFlushTimer);
  usageFlushTimer = null;
  if (!pendingBuckets.size) return;
  const { usageBuckets = {} } = await storageGet({ usageBuckets: {} });
  for (const [minute, values] of pendingBuckets) {
    const previous = usageBuckets[minute] || USAGE_FIELDS.map(() => 0);
    usageBuckets[minute] = values.map((value, index) => (Number(previous[index]) || 0) + value);
  }
  pendingBuckets.clear();
  const oldest = Math.floor(Date.now() / 60000) - USAGE_RETENTION_MINUTES;
  const kept = Object.entries(usageBuckets).filter(([minute]) => Number(minute) >= oldest);
  await storageSet({ usageBuckets: Object.fromEntries(kept) });
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
    onUsage: (usage) => recordUsage(usage),
    onDisconnect: () => scheduleReconnect(settings, mode)
  };
}

// A direction whose interpreter is switched off holds no realtime session at all,
// so no audio is uploaded and no tokens are spent. Its transcript pauses too:
// nothing reaches the model to be transcribed.
function outgoingInterpreterWanted(settings) {
  return settings.captureKind !== "media" && !settings.webRtcOutgoing && !outgoingInterpreterOff && !idleParked.has("outgoing");
}

function incomingInterpreterWanted() {
  return !incomingInterpreterOff && !idleParked.has("incoming");
}

async function applyInterpreterState() {
  if (!state.active || reconnecting) return;
  const settings = activeSettings;
  const mode = MODES[settings.mode] || MODES.both;
  const tasks = [];
  if (!outgoingInterpreterWanted(settings)) {
    outgoingTranslator?.close();
    outgoingTranslator = null;
  } else if (!outgoingTranslator) {
    outgoingTranslator = new RealtimeTranslator(translatorOptions(settings, mode, true));
    tasks.push(outgoingTranslator.connect());
  }
  if (!incomingInterpreterWanted()) {
    incomingTranslator?.close();
    incomingTranslator = null;
  } else if (!incomingTranslator) {
    incomingTranslator = new RealtimeTranslator(translatorOptions(settings, mode, false));
    tasks.push(incomingTranslator.connect());
  }
  applyMuteState();
  await Promise.all(tasks);
}

// A direction whose speaker has gone quiet holds its realtime session open for
// nothing. Parking it closes the session — no audio streamed, nothing billed — and
// the speech gate reopens it the moment that side starts talking again.
function releaseSpeechGates() {
  for (const gate of speechGates.values()) gate.close();
  speechGates.clear();
  for (const timer of idleTimers.values()) clearTimeout(timer);
  idleTimers.clear();
  idleParked.clear();
}

function autoPauseSeconds() {
  return Math.max(0, Number(activeSettings.autoPauseSeconds) || 0);
}

function setupSpeechGate(key, stream) {
  const idleSeconds = autoPauseSeconds();
  if (!idleSeconds || !stream) return;
  const gate = createSpeechGate(stream, {
    onSpeechStart: () => {
      clearTimeout(idleTimers.get(key));
      idleTimers.delete(key);
      if (!idleParked.delete(key)) return;
      applyInterpreterState().catch(() => {});
    },
    onSpeechEnd: () => {
      clearTimeout(idleTimers.get(key));
      idleTimers.set(key, setTimeout(() => {
        if (!state.active || reconnecting) return;
        idleParked.add(key);
        applyInterpreterState().catch(() => {});
      }, idleSeconds * 1000));
    }
  });
  speechGates.set(key, gate);
}

async function connectPair(settings, mode) {
  // A media tab (currently YouTube) needs only the tab-to-listener direction.
  // Avoiding a microphone stream keeps video translation usable without mic permission
  // and prevents an unused second realtime session.
  outgoingTranslator = outgoingInterpreterWanted(settings) ? new RealtimeTranslator(translatorOptions(settings, mode, true)) : null;
  incomingTranslator = incomingInterpreterWanted() ? new RealtimeTranslator(translatorOptions(settings, mode, false)) : null;
  await Promise.all([outgoingTranslator?.connect(), incomingTranslator?.connect()]);
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
  liveTranscript = [];
  meeting = mode.notes ? { id: crypto.randomUUID(), title: tr(settings, "meetingTitle", { date: new Date().toLocaleString(settings.interfaceLanguage || "en") }), startedAt: sessionStartedAt, mode: settings.mode, languages: [settings.sourceLanguage, settings.targetLanguage], transcript: [] } : null;
  state = freshState({ active: true, phase: "connecting", startedAt: sessionStartedAt });
  try {
    if (settings.captureKind !== "media" && !settings.webRtcOutgoing) {
      // Gain control hides the delivery the interpreter is asked to mirror, and
      // noise suppression gates quiet speech away once that boost is gone. Echo
      // cancellation stays on to keep the translated output out of the microphone.
      microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false } });
    }
    tabStream = await takePreparedCapture(settings.captureTabId);
    if (mode.notes && settings.speakerDiarization) startSpeakerRecording(tabStream);
    tabStream.getTracks().forEach((track) => { track.onended = () => { if (state.active) stop({ reason: "tab_closed", notify: true }); }; });
    await applySink(outgoingOutput, settings.outgoingDeviceId);
    await applySink(incomingOutput, settings.incomingDeviceId);
    await applySink(outgoingMonitor, settings.incomingDeviceId);
    outgoingMuted = Boolean(settings.outgoingMuted);
    outgoingTranslationMuted = Boolean(settings.outgoingTranslationMuted);
    incomingMuted = Boolean(settings.incomingMuted);
    incomingTranslationMuted = Boolean(settings.incomingTranslationMuted);
    outgoingInterpreterOff = Boolean(settings.outgoingInterpreterOff);
    incomingInterpreterOff = Boolean(settings.incomingInterpreterOff);
    outgoingOriginalOn = Boolean(settings.outgoingOriginalOn);
    incomingOriginalOn = Boolean(settings.incomingOriginalOn);
    outgoingMonitorOn = Boolean(settings.outgoingMonitorOn);
    applyMuteState();
    outgoingMonitor.volume = settings.monitorLevel === "quiet" ? 0.2 : 1;
    generation += 1;
    await connectPair(settings, mode);
    // Only the sides that actually hold a session need watching: the WebRTC path
    // owns its outgoing interpreter inside the conference tab.
    if (outgoingInterpreterWanted(settings)) setupSpeechGate("outgoing", microphoneStream);
    setupSpeechGate("incoming", tabStream);
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
    sendResponse({ ok: true, state: statusState(), liveTranscript: liveTranscript.slice(-16), preparedTabId: preparedCapture?.tabId || null });
    return false;
  }
  if (message.type === "ADD_USAGE") {
    recordUsage(message.usage || {});
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === "MONITOR_STOP") {
    stopMonitorFeed();
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === "MONITOR_OFFER") {
    acceptMonitorFeed(message.sdp)
      .then((answerSdp) => sendResponse({ ok: true, answerSdp }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "SET_MUTE") {
    if (typeof message.outgoingMuted === "boolean") outgoingMuted = message.outgoingMuted;
    if (typeof message.outgoingTranslationMuted === "boolean") outgoingTranslationMuted = message.outgoingTranslationMuted;
    if (typeof message.incomingMuted === "boolean") incomingMuted = message.incomingMuted;
    if (typeof message.incomingTranslationMuted === "boolean") incomingTranslationMuted = message.incomingTranslationMuted;
    if (typeof message.outgoingInterpreterOff === "boolean") outgoingInterpreterOff = message.outgoingInterpreterOff;
    if (typeof message.incomingInterpreterOff === "boolean") incomingInterpreterOff = message.incomingInterpreterOff;
    if (typeof message.outgoingOriginalOn === "boolean") outgoingOriginalOn = message.outgoingOriginalOn;
    if (typeof message.incomingOriginalOn === "boolean") incomingOriginalOn = message.incomingOriginalOn;
    if (typeof message.outgoingMonitorOn === "boolean") outgoingMonitorOn = message.outgoingMonitorOn;
    applyMuteState();
    applyInterpreterState()
      .then(() => sendResponse({ ok: true, state: statusState() }))
      .catch((error) => sendResponse({ ok: false, error: error.message, state: statusState() }));
    return true;
  }
  if (message.type === "ADD_OUTGOING_TRANSCRIPT") {
    if (state.active && message.text) {
      state.translatedUtteranceCount += 1;
      addTranscript(tr(activeSettings, "speakerYou"), message.text, message.language || activeSettings.targetLanguage, "you");
    }
    sendResponse({ ok: true });
    return false;
  }
  const action = message.type === "PREPARE_TAB_CAPTURE" ? prepareTabCapture(message.streamId, message.tabId) : message.type === "START_TRANSLATION" ? start(message.settings) : message.type === "STOP_TRANSLATION" ? stop() : message.type === "OUTGOING_DISCONNECTED" ? stop({ reason: "connection", error: tr(activeSettings, "connectionRestoreFailed", { error: message.reason || "disconnected" }), notify: true }) : Promise.resolve({ ok: false, error: t(activeSettings.interfaceLanguage, "unknownCommand") });
  action.then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
