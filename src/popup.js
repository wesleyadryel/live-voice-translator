import { loadSettings, maskKey } from "./config.js";

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

function render(state = {}) {
  active = Boolean(state.active);
  document.body.classList.toggle("is-live", active);
  elements.toggleLabel.textContent = active ? "Остановить перевод" : "Начать перевод";
  elements.status.textContent = active ? "Перевод идёт в реальном времени" : "Готов к запуску";
  elements.hint.textContent = active
    ? "Не закрывайте вкладку конференции. Используйте наушники."
    : "Откройте вкладку с конференцией и запустите перевод.";
  elements.error.hidden = !state.error;
  elements.error.textContent = state.error || "";
}

async function refresh() {
  const settings = await loadSettings();
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
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const result = await chrome.runtime.sendMessage({ type: "START_TRANSLATION", tabId: tab.id });
      if (!result?.ok) throw new Error(result?.error || "Не удалось запустить перевод");
      render(result.state);
    }
  } catch (error) {
    render({ active: false, error: error.message });
  } finally {
    elements.toggle.disabled = false;
  }
});

document.querySelector("#open-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
refresh().catch((error) => render({ error: error.message }));
