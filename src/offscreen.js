import { loadSettings } from "./config.js";
import { RealtimeTranslator } from "./realtime.js";

const incomingOutput = document.querySelector("#incoming-output");
const outgoingOutput = document.querySelector("#outgoing-output");
let incomingTranslator;
let outgoingTranslator;
let microphoneStream;
let tabStream;
let state = { active: false, phase: "idle", error: "" };

async function applySink(element, deviceId) {
  if (deviceId && deviceId !== "default" && "setSinkId" in element) {
    await element.setSinkId(deviceId);
  }
}

async function stop() {
  incomingTranslator?.close();
  outgoingTranslator?.close();
  microphoneStream?.getTracks().forEach((track) => track.stop());
  tabStream?.getTracks().forEach((track) => track.stop());
  incomingTranslator = outgoingTranslator = microphoneStream = tabStream = null;
  incomingOutput.srcObject = null;
  outgoingOutput.srcObject = null;
  state = { active: false, phase: "idle", error: "" };
  return { ok: true, state };
}

async function start(streamId) {
  await stop();
  const settings = await loadSettings();
  if (!settings.apiKey) throw new Error("Сначала добавьте OpenAI API-ключ в настройках");
  state = { active: true, phase: "connecting", error: "" };

  microphoneStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });
  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  await applySink(outgoingOutput, settings.outgoingDeviceId);
  await applySink(incomingOutput, settings.incomingDeviceId);

  outgoingTranslator = new RealtimeTranslator({
    apiKey: settings.apiKey,
    inputStream: microphoneStream,
    outputElement: outgoingOutput,
    from: settings.sourceLanguage,
    to: settings.targetLanguage,
    voice: settings.outgoingVoice,
    onState: (phase) => { state.phase = phase; }
  });
  incomingTranslator = new RealtimeTranslator({
    apiKey: settings.apiKey,
    inputStream: tabStream,
    outputElement: incomingOutput,
    from: settings.targetLanguage,
    to: settings.sourceLanguage,
    voice: settings.incomingVoice,
    onState: (phase) => { state.phase = phase; }
  });

  try {
    await Promise.all([outgoingTranslator.connect(), incomingTranslator.connect()]);
    state.phase = "live";
    return { ok: true, state };
  } catch (error) {
    await stop();
    state = { active: false, phase: "error", error: error.message };
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "offscreen") return false;
  if (message.type === "GET_STATUS") {
    sendResponse({ ok: true, state });
    return false;
  }
  const action = message.type === "START_TRANSLATION"
    ? start(message.streamId)
    : message.type === "STOP_TRANSLATION"
      ? stop()
      : Promise.resolve({ ok: false, error: "Unknown command" });
  action.then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
