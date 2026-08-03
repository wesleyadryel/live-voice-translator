import { RealtimeTranslator } from "./realtime.js";
import { createSpeechGate } from "./speech-gate.js";

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
let monitorOn = false;
let monitorPc = null;
let speechGate = null;
let idleTimer = null;
let idleParked = false;

// The return feed must never be played by this tab: tabCapture would pick it up and
// hand the translated voice to the incoming interpreter, which would translate it
// straight back. Instead the track is sent over a local loopback connection to the
// offscreen document, which tab capture cannot reach.
function waitForIceGathering(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState !== "complete") return;
      pc.removeEventListener("icegatheringstatechange", done);
      resolve();
    };
    pc.addEventListener("icegatheringstatechange", done);
    setTimeout(resolve, 1500);
  });
}

function stopMonitorFeed() {
  monitorPc?.close();
  monitorPc = null;
  chrome.runtime.sendMessage({ type: "CONFERENCE_MONITOR_STOP" }).catch(() => {});
}

async function startMonitorFeed() {
  const stream = outputElement?.srcObject;
  if (monitorPc || !stream?.getAudioTracks?.().length) return;
  const pc = new RTCPeerConnection();
  monitorPc = pc;
  try {
    for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
    await pc.setLocalDescription(await pc.createOffer());
    await waitForIceGathering(pc);
    const result = await chrome.runtime.sendMessage({ type: "CONFERENCE_MONITOR_OFFER", sdp: pc.localDescription.sdp });
    if (!result?.ok || !result.answerSdp) throw new Error(result?.error || "MONITOR_FEED_FAILED");
    if (monitorPc !== pc) return;
    await pc.setRemoteDescription({ type: "answer", sdp: result.answerSdp });
  } catch (error) {
    if (monitorPc === pc) stopMonitorFeed();
    throw error;
  }
}

async function applyMonitorState() {
  // Staying muted here is what keeps the loop from forming in the first place.
  if (outputElement) outputElement.muted = true;
  if (monitorOn) await startMonitorFeed();
  else stopMonitorFeed();
}

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

// Holding the session open while you are not talking streams audio that is billed
// for nothing, so a quiet stretch parks it and the first word brings it back.
function releaseSpeechGate() {
  speechGate?.close();
  speechGate = null;
  clearTimeout(idleTimer);
  idleTimer = null;
  idleParked = false;
}

function setupSpeechGate() {
  releaseSpeechGate();
  const idleSeconds = Math.max(0, Number(currentSettings?.autoPauseSeconds) || 0);
  if (!idleSeconds || !microphoneStream) return;
  speechGate = createSpeechGate(microphoneStream, {
    onSpeechStart: () => {
      clearTimeout(idleTimer);
      idleTimer = null;
      if (!idleParked) return;
      idleParked = false;
      applyInterpreterState().catch(() => {});
    },
    onSpeechEnd: () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!currentSettings || idleParked) return;
        idleParked = true;
        applyInterpreterState().catch(() => {});
      }, idleSeconds * 1000);
    }
  });
}

async function applyInterpreterState() {
  if (!currentSettings) return;
  if (interpreterOff || idleParked) {
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
  releaseSpeechGate();
  stopMonitorFeed();
  translator?.close();
  translator = null;
  microphoneStream?.getTracks().forEach((track) => track.stop());
  microphoneStream = null;
  outputElement?.remove();
  outputElement = null;
  originalElement?.remove();
  originalElement = null;
  currentSettings = null;
  outgoingMuted = outgoingTranslationMuted = interpreterOff = originalOn = monitorOn = false;
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
    onOutputTrack: () => {
      dispatch("live-voice:translated-track", { elementId: OUTPUT_ELEMENT_ID });
      // The translated track only exists now, so this is when the return feed can
      // start. A reconnect delivers a new track, which leaves the previous loopback
      // carrying a dead one — rebuild it rather than reusing it.
      stopMonitorFeed();
      applyMonitorState().catch(() => {});
    },
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
  monitorOn = Boolean(settings.outgoingMonitorOn);
  dispatch("live-voice:activate");
  try {
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      // Gain control levels every utterance to the same loudness and noise
      // suppression gates the quiet parts away — together they hide how a sentence
      // was actually spoken, and gate out real speech once the signal is no longer
      // boosted. Echo cancellation stays on: without it the translated voice coming
      // out of the speakers is picked back up and fed to the interpreter.
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false }
    });
    publishOriginalTrack(microphoneStream);
    applyOutgoingMode();
    const audio = ensureOutputElement();
    audio.muted = true;
    if (interpreterOff) return { ok: true };
    translator = createTranslator(settings, audio);
    await translator.connect();
    setupSpeechGate();
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
    if (typeof message.outgoingMonitorOn === "boolean") monitorOn = message.outgoingMonitorOn;
    await applyInterpreterState();
    applyOutgoingMode();
    await applyMonitorState();
    return { ok: true, outgoingMuted, outgoingTranslationMuted, interpreterOff, originalOn, monitorOn };
  }
  if (message.type === "CONFERENCE_GET_OUTGOING_STATUS") return { ok: true, active: Boolean(translator), routeStatus, outgoingMuted, outgoingTranslationMuted, interpreterOff, settings: currentSettings ? { sourceLanguage: currentSettings.sourceLanguage, targetLanguage: currentSettings.targetLanguage } : null };
  return { ok: false, error: "UNKNOWN_CONFERENCE_COMMAND" };
}
