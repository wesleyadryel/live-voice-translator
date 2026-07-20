import { loadSettings, maskKey, saveSettings } from "./config.js";

const $ = (selector) => document.querySelector(selector);
const elements = {
  toggle: $("#toggle"), toggleLabel: $("#toggle-label"), status: $("#status-label"), phase: $("#phase-pill"),
  timer: $("#session-timer"), hint: $("#hint"), error: $("#error"), errorCopy: $("#error-copy"),
  keyStatus: $("#key-status"), usage: $("#usage-label"), source: $("#source-label"), target: $("#target-label"),
  setup: $("#setup-banner"), setupCopy: $("#setup-copy"), notice: $("#recording-notice"), profile: $("#profile-switch")
};

let active = false;
let busy = false;
let currentMode = "both";
let currentProfile = "solo";
let currentSettings = {};
let currentState = { active: false, phase: "idle", error: "" };
let lastStartedAt = 0;

const MODE_HINTS = {
  translation: "Переводите разговор голосом без сохранения текста.",
  notes: "Запишите разговор и получите структурированный конспект.",
  both: "Переводите голос и одновременно готовьте конспект.",
  transcript: "Сохраните полный текст разговора без озвучивания."
};
const PHASES = {
  idle: "Готов", connecting: "Подключение", live: "В эфире", reconnecting: "Восстановление",
  summarizing: "Готовим конспект", disconnected: "Нет соединения", failed: "Ошибка", error: "Ошибка", closed: "Остановлено", limit: "Лимит времени"
};
const START_LABELS = { translation: "Начать перевод", notes: "Начать конспект", both: "Начать встречу", transcript: "Начать запись" };

function friendlyError(error) {
  const message = error?.message || String(error || "Неизвестная ошибка");
  if (/Permission dismissed|Permission denied|NotAllowedError/i.test(message)) return "Нет доступа к микрофону. Разрешите его в настройках Chrome.";
  if (/OpenAI 401|invalid.*key|Incorrect API key/i.test(message)) return "OpenAI отклонил API-ключ. Проверьте ключ в настройках.";
  if (/OpenAI 429|quota|rate limit/i.test(message)) return "Достигнут лимит OpenAI API. Проверьте баланс и лимиты проекта.";
  if (/Requested device not found|NotFoundError/i.test(message)) return "Выбранное аудиоустройство отключено. Выберите доступный выход.";
  if (/Cannot capture|tabCapture|active tab/i.test(message)) return "Откройте вкладку конференции и запустите перевод из неё.";
  if (/virtual|аудиокабель|разными устройствами/i.test(message)) return message;
  if (/network|fetch|connection/i.test(message)) return "Соединение прервано. Проверьте интернет и повторите запуск.";
  return message;
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function languageLabel(value) {
  return ({ Russian: "Русский", English: "English", Spanish: "Español", German: "Deutsch", French: "Français" })[value] || value;
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
  setCheck("api", settings.apiKey ? "ok" : "error", settings.apiKey ? "Настроен" : "Нет ключа");
  const permission = await microphonePermission();
  setCheck("microphone", permission === "granted" ? "ok" : permission === "denied" ? "error" : "warn", permission === "granted" ? "Разрешён" : permission === "denied" ? "Запрещён" : "При запуске");
  const voiceMode = ["translation", "both"].includes(settings.mode);
  const conferenceReady = settings.audioProfile !== "conference" || (settings.outgoingDeviceId && settings.outgoingDeviceId !== "default" && settings.outgoingDeviceId !== settings.incomingDeviceId);
  setCheck("route", !voiceMode || conferenceReady ? "ok" : "error", !voiceMode ? "Не требуется" : settings.audioProfile === "solo" ? "На этом Mac" : conferenceReady ? "Раздельный" : "Настройте");
}

function render(state = currentState) {
  currentState = state;
  active = Boolean(state.active);
  lastStartedAt = state.startedAt || lastStartedAt;
  document.body.classList.toggle("is-live", active);
  document.body.classList.toggle("is-busy", busy);
  elements.toggle.classList.toggle("is-loading", busy || ["connecting", "reconnecting", "summarizing"].includes(state.phase));
  elements.toggle.disabled = busy;
  elements.toggleLabel.textContent = active ? "Остановить" : START_LABELS[currentMode];
  const iconPath = elements.toggle.querySelector(".button-symbol path");
  if (iconPath) iconPath.setAttribute("d", active ? "M8 8h8v8H8z" : "m9 7 8 5-8 5V7Z");
  elements.status.textContent = PHASES[state.phase] || (active ? "В эфире" : "Готов");
  elements.hint.textContent = active
    ? state.phase === "reconnecting" ? "Связь восстанавливается автоматически. Не закрывайте вкладку." : `Сеанс работает в фоне · реплик: ${state.transcriptCount || 0}`
    : MODE_HINTS[currentMode];
  const error = state.error ? friendlyError(state.error) : "";
  elements.error.hidden = !error;
  elements.errorCopy.textContent = error;
  elements.profile.hidden = !["translation", "both"].includes(currentMode);
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
  currentMode = settings.mode;
  currentProfile = settings.audioProfile;
  document.querySelectorAll("[data-mode]").forEach((button) => button.classList.toggle("active", button.dataset.mode === currentMode));
  document.querySelectorAll("[data-profile]").forEach((button) => button.classList.toggle("active", button.dataset.profile === currentProfile));
  elements.keyStatus.textContent = settings.apiKey ? maskKey(settings.apiKey) : "API не настроен";
  elements.usage.textContent = `Использовано ${Math.ceil((settings.usageSeconds || 0) / 60)} мин · ${settings.sessionCount || 0} сеансов`;
  elements.source.textContent = languageLabel(settings.sourceLanguage);
  elements.target.textContent = languageLabel(settings.targetLanguage);
  elements.setup.hidden = Boolean(settings.apiKey);
  elements.setupCopy.textContent = settings.apiKey ? "" : "Добавьте OpenAI API-ключ, чтобы начать.";
  await renderPreflight(settings);
  const result = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  render(result?.state || { active: false, phase: "idle", error: result?.error || "" });
}

elements.toggle.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  elements.error.hidden = true;
  render();
  try {
    if (active) {
      const result = await chrome.runtime.sendMessage({ type: "STOP_TRANSLATION" });
      if (!result?.ok) throw new Error(result?.error || "Не удалось остановить сеанс");
      currentState = result.state;
      if (result.meetingId) await chrome.tabs.create({ url: `${chrome.runtime.getURL("src/history.html")}#${result.meetingId}` });
    } else {
      if (!currentSettings.apiKey) { chrome.runtime.openOptionsPage(); return; }
      if (["notes", "both", "transcript"].includes(currentMode) && !currentSettings.recordingNoticeAccepted) {
        elements.notice.hidden = false;
        return;
      }
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const result = await chrome.runtime.sendMessage({ type: "START_TRANSLATION", tabId: tab.id });
      if (!result?.ok) throw new Error(result?.error || "Не удалось запустить сеанс");
      currentState = result.state;
    }
  } catch (error) {
    currentState = { active: false, phase: "error", error: friendlyError(error) };
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
});
document.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", async () => {
  if (active || busy) return;
  currentMode = button.dataset.mode;
  await saveSettings({ mode: currentMode });
  await refresh();
}));
document.querySelectorAll("[data-profile]").forEach((button) => button.addEventListener("click", async () => {
  if (active || busy) return;
  currentProfile = button.dataset.profile;
  await saveSettings({ audioProfile: currentProfile });
  await refresh();
}));

refresh().catch((error) => render({ active: false, phase: "error", error: friendlyError(error) }));
setInterval(updateTimer, 1000);
setInterval(() => { if (document.visibilityState === "visible" && !busy) refresh().catch(() => {}); }, 2500);
