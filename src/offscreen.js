import { DEFAULT_SETTINGS } from "./config.js";
import { RealtimeTranslator } from "./realtime.js";

const incomingOutput = document.querySelector("#incoming-output");
const outgoingOutput = document.querySelector("#outgoing-output");
let incomingTranslator;
let outgoingTranslator;
let microphoneStream;
let tabStream;
let state = { active: false, phase: "idle", error: "" };
let meeting = null;
let activeSettings = { ...DEFAULT_SETTINGS };

async function storageGet(defaults = {}) {
  const result = await chrome.runtime.sendMessage({ type: "STORAGE_GET", defaults });
  if (!result?.ok) throw new Error(result?.error || "Не удалось прочитать локальные данные");
  return result.value;
}

async function storageSet(value) {
  const result = await chrome.runtime.sendMessage({ type: "STORAGE_SET", value });
  if (!result?.ok) throw new Error(result?.error || "Не удалось сохранить локальные данные");
}

const MODES = {
  translation: { audio: true, notes: false, summary: false },
  notes: { audio: false, notes: true, summary: true },
  both: { audio: true, notes: true, summary: true },
  transcript: { audio: false, notes: true, summary: false }
};

function addTranscript(speaker, text, language) {
  if (!meeting || !text) return;
  meeting.transcript.push({
    speaker,
    text,
    language,
    offsetSeconds: Math.max(0, Math.round((Date.now() - meeting.startedAt) / 1000))
  });
}

function responseText(payload) {
  if (typeof payload.output_text === "string") return payload.output_text;
  return (payload.output || []).flatMap((item) => item.content || [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text || "")
    .join("\n").trim();
}

async function createSummary(settings, currentMeeting) {
  const lines = currentMeeting.transcript.map((item) =>
    `[${Math.floor(item.offsetSeconds / 60)}:${String(item.offsetSeconds % 60).padStart(2, "0")}] ${item.speaker}: ${item.text}`
  ).join("\n");
  if (!lines) return "Недостаточно распознанной речи для конспекта.";
  const detail = settings.summaryDetail === "brief" ? "краткий" : settings.summaryDetail === "detailed" ? "подробный" : "сбалансированный";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      instructions: `Создай ${detail} конспект встречи на русском языке в Markdown. Обязательно используй разделы: Краткое содержание, Основные темы, Принятые решения, Задачи и ответственные, Сроки, Открытые вопросы. Не придумывай отсутствующие факты; если раздел пуст, напиши «Не зафиксировано».`,
      input: lines
    })
  });
  if (!response.ok) throw new Error(`Не удалось создать конспект: OpenAI ${response.status}`);
  return responseText(await response.json()) || "Конспект не был сформирован.";
}

async function saveMeeting(settings, currentMeeting) {
  const finishedAt = Date.now();
  const record = {
    ...currentMeeting,
    finishedAt,
    durationSeconds: Math.round((finishedAt - currentMeeting.startedAt) / 1000),
    summary: ""
  };
  if (!settings.saveTranscript) record.transcript = [];
  const mode = MODES[currentMeeting.mode];
  if (mode.summary) {
    try { record.summary = await createSummary(settings, currentMeeting); }
    catch (error) { record.summary = `> Конспект не создан: ${error.message}`; }
  }
  const { meetings = [] } = await storageGet({ meetings: [] });
  await storageSet({ meetings: [record, ...meetings].slice(0, 50), lastMeetingId: record.id });
  return record;
}

async function applySink(element, deviceId) {
  if (deviceId && deviceId !== "default" && "setSinkId" in element) {
    await element.setSinkId(deviceId);
  }
}

async function stop() {
  const settings = activeSettings;
  const capturedMeeting = meeting;
  incomingTranslator?.close();
  outgoingTranslator?.close();
  microphoneStream?.getTracks().forEach((track) => track.stop());
  tabStream?.getTracks().forEach((track) => track.stop());
  incomingTranslator = outgoingTranslator = microphoneStream = tabStream = null;
  incomingOutput.srcObject = null;
  outgoingOutput.srcObject = null;
  meeting = null;
  state = { active: false, phase: capturedMeeting ? "summarizing" : "idle", error: "" };
  const completedMeeting = capturedMeeting && MODES[capturedMeeting.mode]?.notes
    ? await saveMeeting(settings, capturedMeeting)
    : null;
  state = { active: false, phase: "idle", error: "" };
  return { ok: true, state, meetingId: completedMeeting?.id || null };
}

async function start(streamId, suppliedSettings = {}) {
  await stop();
  const settings = { ...DEFAULT_SETTINGS, ...suppliedSettings };
  activeSettings = settings;
  if (!settings.apiKey) throw new Error("Сначала добавьте OpenAI API-ключ в настройках");
  const mode = MODES[settings.mode] || MODES.both;
  meeting = mode.notes ? {
    id: crypto.randomUUID(),
    title: `Встреча ${new Date().toLocaleString("ru-RU")}`,
    startedAt: Date.now(),
    mode: settings.mode,
    languages: [settings.sourceLanguage, settings.targetLanguage],
    transcript: []
  } : null;
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
  outgoingOutput.muted = !mode.audio;
  incomingOutput.muted = !mode.audio;

  outgoingTranslator = new RealtimeTranslator({
    apiKey: settings.apiKey,
    inputStream: microphoneStream,
    outputElement: outgoingOutput,
    from: settings.sourceLanguage,
    to: settings.targetLanguage,
    voice: settings.outgoingVoice,
    verbatim: !mode.audio,
    onTranscript: (text) => addTranscript("Вы", text, mode.audio ? settings.targetLanguage : settings.sourceLanguage),
    onState: (phase) => { state.phase = phase; }
  });
  incomingTranslator = new RealtimeTranslator({
    apiKey: settings.apiKey,
    inputStream: tabStream,
    outputElement: incomingOutput,
    from: settings.targetLanguage,
    to: settings.sourceLanguage,
    voice: settings.incomingVoice,
    verbatim: !mode.audio,
    onTranscript: (text) => addTranscript("Собеседник", text, mode.audio ? settings.sourceLanguage : settings.targetLanguage),
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
    ? start(message.streamId, message.settings)
    : message.type === "STOP_TRANSLATION"
      ? stop()
      : Promise.resolve({ ok: false, error: "Unknown command" });
  action.then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
