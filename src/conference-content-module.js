import { RealtimeTranslator } from "./realtime.js";

const OUTPUT_ELEMENT_ID = "live-voice-translated-output";
const ORIGINAL_ELEMENT_ID = "live-voice-original-output";
let translator = null;
let microphoneStream = null;
let outputElement = null;
let originalElement = null;
let currentSettings = null;
let routeStatus = { status: "unknown", detail: "" };
let outgoingMuted = false;
let outgoingTranslationMuted = false;
let interpreterOff = false;
let originalOn = false;

// Muting keeps the realtime session connected, so switching back needs no
// reconnect. Switching the interpreter off closes it instead: nothing is uploaded
// and nothing is billed, at the cost of pausing this side's transcript.
function applyOutgoingMode() {
  const translationAudible = !outgoingTranslationMuted && !interpreterOff;
  const mode = outgoingMuted ? "silence"
    : !translationAudible ? "original"
    : originalOn ? "both"
    : "translated";
  dispatch("live-voice:outgoing-mode", { mode });
}

async function applyInterpreterState() {
  if (!currentSettings) return;
  if (interpreterOff) {
    translator?.close();
    translator = null;
    return;
  }
  if (translator || !microphoneStream || !outputElement) return;
  translator = createTranslator(currentSettings, outputElement);
  await translator.connect();
}

window.addEventListener("live-voice:route-status", (event) => {
  routeStatus = event.detail || { status: "unknown", detail: "" };
});

function dispatch(type, detail = {}) {
  window.dispatchEvent(new CustomEvent(type, { detail }));
}

function ensureOutputElement() {
  outputElement?.remove();
  const audio = document.createElement("audio");
  audio.id = OUTPUT_ELEMENT_ID;
  audio.autoplay = true;
  audio.muted = true;
  audio.hidden = true;
  (document.documentElement || document.body).append(audio);
  outputElement = audio;
  return audio;
}

// The page's own microphone track is often disabled or ended once it has been
// replaced, so the untranslated voice is sent from this capture instead — the very
// stream the interpreter is listening through. Muted locally to avoid hearing
// yourself.
function publishOriginalTrack(stream) {
  originalElement?.remove();
  const audio = document.createElement("audio");
  audio.id = ORIGINAL_ELEMENT_ID;
  audio.autoplay = true;
  audio.muted = true;
  audio.hidden = true;
  audio.srcObject = stream;
  (document.documentElement || document.body).append(audio);
  originalElement = audio;
  dispatch("live-voice:original-track", { elementId: ORIGINAL_ELEMENT_ID });
}

async function exchangeSdp(sdp) {
  const result = await chrome.runtime.sendMessage({ type: "CONFERENCE_REALTIME_SDP", sdp });
  if (!result?.ok || !result.answerSdp) throw new Error(result?.error || "REALTIME_SDP_FAILED");
  return result.answerSdp;
}

async function stopOutgoing({ restore = true } = {}) {
  translator?.close();
  translator = null;
  microphoneStream?.getTracks().forEach((track) => track.stop());
  microphoneStream = null;
  outputElement?.remove();
  outputElement = null;
  originalElement?.remove();
  originalElement = null;
  currentSettings = null;
  outgoingMuted = outgoingTranslationMuted = interpreterOff = originalOn = false;
  if (restore) dispatch("live-voice:deactivate");
  return { ok: true };
}

function createTranslator(settings, audio) {
  return new RealtimeTranslator({
    inputStream: microphoneStream,
    outputElement: audio,
    from: settings.sourceLanguage,
    to: settings.targetLanguage,
    voice: settings.outgoingVoice,
    exchangeSdp,
    onOutputTrack: () => dispatch("live-voice:translated-track", { elementId: OUTPUT_ELEMENT_ID }),
    onTranscript: (text) => chrome.runtime.sendMessage({ type: "CONFERENCE_OUTGOING_TRANSCRIPT", text, language: settings.targetLanguage }).catch(() => {}),
    onDisconnect: (reason) => chrome.runtime.sendMessage({ type: "CONFERENCE_OUTGOING_DISCONNECTED", reason }).catch(() => {})
  });
}

async function startOutgoing(settings) {
  await stopOutgoing({ restore: false });
  currentSettings = settings;
  outgoingMuted = Boolean(settings.outgoingMuted);
  outgoingTranslationMuted = Boolean(settings.outgoingTranslationMuted);
  interpreterOff = Boolean(settings.outgoingInterpreterOff);
  originalOn = Boolean(settings.outgoingOriginalOn);
  dispatch("live-voice:activate");
  try {
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    publishOriginalTrack(microphoneStream);
    applyOutgoingMode();
    const audio = ensureOutputElement();
    if (interpreterOff) return { ok: true };
    translator = createTranslator(settings, audio);
    await translator.connect();
    return { ok: true };
  } catch (error) {
    await stopOutgoing();
    throw error;
  }
}

export async function handleConferenceMessage(message) {
  if (message.type === "CONFERENCE_START_OUTGOING") return startOutgoing(message.settings || {});
  if (message.type === "CONFERENCE_STOP_OUTGOING") return stopOutgoing();
  if (message.type === "CONFERENCE_SET_MUTE") {
    if (typeof message.outgoingMuted === "boolean") outgoingMuted = message.outgoingMuted;
    if (typeof message.outgoingTranslationMuted === "boolean") outgoingTranslationMuted = message.outgoingTranslationMuted;
    if (typeof message.outgoingInterpreterOff === "boolean") interpreterOff = message.outgoingInterpreterOff;
    if (typeof message.outgoingOriginalOn === "boolean") originalOn = message.outgoingOriginalOn;
    await applyInterpreterState();
    applyOutgoingMode();
    return { ok: true, outgoingMuted, outgoingTranslationMuted, interpreterOff, originalOn };
  }
  if (message.type === "CONFERENCE_GET_OUTGOING_STATUS") return { ok: true, active: Boolean(translator), routeStatus, outgoingMuted, outgoingTranslationMuted, interpreterOff, settings: currentSettings ? { sourceLanguage: currentSettings.sourceLanguage, targetLanguage: currentSettings.targetLanguage } : null };
  return { ok: false, error: "UNKNOWN_CONFERENCE_COMMAND" };
}
