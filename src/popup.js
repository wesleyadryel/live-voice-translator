import { loadSettings, maskKey, saveSettings } from "./config.js";

const elements = {
  toggle: document.querySelector("#toggle"),
  toggleLabel: document.querySelector("#toggle-label"),
  status: document.querySelector("#status-label"),
  hint: document.querySelector("#hint"),
  error: document.querySelector("#error"),
  keyStatus: document.querySelector("#key-status"),
  source: document.querySelector("#source-label"),
  target: document.querySelector("#target-label")
};
let active = false;
let currentMode = "both";
let currentProfile = "solo";

const MODE_HINTS = {
  translation: "Двусторонний голосовой перевод без сохранения встречи.",
  notes: "Запишем разговор и подготовим русский конспект.",
  both: "Голосовой перевод и конспект после завершения.",
  transcript: "Сохраним полный текст без перевода голоса."
};

function friendlyError(error) {
  const message = error?.message || String(error || "Неизвестная ошибка");
  if (/Permission dismissed|Permission denied|NotAllowedError/i.test(message)) return "Разрешите микрофон в настройках расширения и повторите запуск";
  if (/OpenAI 401|invalid.*key|Incorrect API key/i.test(message)) return "OpenAI отклонил API-ключ. Проверьте ключ в настройках";
  if (/OpenAI 429|quota|rate limit/i.test(message)) return "Достигнут лимит OpenAI API. Проверьте баланс и лимиты проекта";
  if (/Requested device not found|NotFoundError/i.test(message)) return "Выбранное аудиоустройство больше недоступно. Откройте настройки";
  if (/Cannot capture|tabCapture|active tab/i.test(message)) return "Откройте вкладку конференции и запускайте расширение именно из неё";
  return message;
}

function render(state = {}) {
  active = Boolean(state.active);
  document.body.classList.toggle("is-live", active);
  const startLabels = { translation: "Начать перевод", notes: "Начать конспект", both: "Начать встречу", transcript: "Начать запись" };
  elements.toggleLabel.textContent = active ? "Остановить" : startLabels[currentMode];
  elements.status.textContent = active ? "Перевод идёт в реальном времени" : "Готов к запуску";
  elements.hint.textContent = active
    ? "Не закрывайте вкладку конференции. Используйте наушники."
    : MODE_HINTS[currentMode];
  elements.error.hidden = !state.error;
  elements.error.textContent = state.error || "";
  document.querySelector("#profile-switch").hidden = !["translation", "both"].includes(currentMode);
}

async function refresh() {
  const settings = await loadSettings();
  currentMode = settings.mode;
  currentProfile = settings.audioProfile;
  document.querySelectorAll("[data-mode]").forEach((button) => button.classList.toggle("active", button.dataset.mode === currentMode));
  document.querySelectorAll("[data-profile]").forEach((button) => button.classList.toggle("active", button.dataset.profile === currentProfile));
  elements.keyStatus.textContent = settings.apiKey ? `Ключ: ${maskKey(settings.apiKey)}` : "API-ключ не настроен";
  elements.source.textContent = settings.sourceLanguage === "Russian" ? "Русский" : settings.sourceLanguage;
  elements.target.textContent = settings.targetLanguage;
  const result = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  render(result?.state || {});
}

elements.toggle.addEventListener("click", async () => {
  elements.toggle.disabled = true;
  elements.error.hidden = true;
  try {
    if (active) {
      const result = await chrome.runtime.sendMessage({ type: "STOP_TRANSLATION" });
      render(result.state);
      if (result.meetingId) {
        await chrome.tabs.create({ url: `${chrome.runtime.getURL("src/history.html")}#${result.meetingId}` });
      }
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const result = await chrome.runtime.sendMessage({ type: "START_TRANSLATION", tabId: tab.id });
      if (!result?.ok) throw new Error(result?.error || "Не удалось запустить перевод");
      render(result.state);
    }
  } catch (error) {
    render({ active: false, error: friendlyError(error) });
  } finally {
    elements.toggle.disabled = false;
  }
});

document.querySelector("#open-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
document.querySelector("#open-history").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("src/history.html") }));
document.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", async () => {
  if (active) return;
  currentMode = button.dataset.mode;
  await saveSettings({ mode: currentMode });
  document.querySelectorAll("[data-mode]").forEach((item) => item.classList.toggle("active", item === button));
  render({ active: false });
}));
document.querySelectorAll("[data-profile]").forEach((button) => button.addEventListener("click", async () => {
  if (active) return;
  currentProfile = button.dataset.profile;
  await saveSettings({ audioProfile: currentProfile });
  document.querySelectorAll("[data-profile]").forEach((item) => item.classList.toggle("active", item === button));
  render({ active: false });
}));
refresh().catch((error) => render({ error: error.message }));
