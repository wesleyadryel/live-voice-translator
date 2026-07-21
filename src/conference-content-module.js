import { RealtimeTranslator } from "./realtime.js";

const OUTPUT_ELEMENT_ID = "live-voice-translated-output";
let translator = null;
let microphoneStream = null;
let outputElement = null;
let currentSettings = null;
let routeStatus = { status: "unknown", detail: "" };

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
  currentSettings = null;
  if (restore) dispatch("live-voice:deactivate");
  return { ok: true };
}

async function startOutgoing(settings) {
  await stopOutgoing({ restore: false });
  currentSettings = settings;
  dispatch("live-voice:activate");
  try {
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    const audio = ensureOutputElement();
    translator = new RealtimeTranslator({
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
  if (message.type === "CONFERENCE_GET_OUTGOING_STATUS") return { ok: true, active: Boolean(translator), routeStatus, settings: currentSettings ? { sourceLanguage: currentSettings.sourceLanguage, targetLanguage: currentSettings.targetLanguage } : null };
  return { ok: false, error: "UNKNOWN_CONFERENCE_COMMAND" };
}
