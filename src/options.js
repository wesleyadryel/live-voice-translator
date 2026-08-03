import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./config.js";
import { localizePage, t } from "./i18n.js";

const ids = (name) => document.querySelector(`#${name}`);
const SUMMARY_SECTION_IDS = ["overview", "topics", "decisions", "tasks", "deadlines", "owners", "questions"];
let locale = "en";

function applyLocale(nextLocale) {
  locale = nextLocale || "en";
  localizePage(locale);
  document.title = `${t(locale, "settingsTitle")} — ${t(locale, "appTitle")}`;
  ids("reveal-key").textContent = t(locale, ids("api-key").type === "password" ? "show" : "hide");
}

async function listOutputs(selectedOutgoing, selectedIncoming) {
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audiooutput");
    for (const [selectId, selected] of [["outgoing-device", selectedOutgoing], ["incoming-device", selectedIncoming]]) {
      const select = ids(selectId);
      for (const device of devices) {
        const option = document.createElement("option");
        option.value = device.deviceId;
        option.textContent = device.label || t(locale, "audioOutput", { number: select.length });
        option.selected = device.deviceId === selected;
        select.append(option);
      }
    }
  } catch {}
}

async function init() {
  const settings = await loadSettings();
  applyLocale(settings.interfaceLanguage || "en");
  ids("api-key").value = settings.apiKey;
  ids("interface-language").value = settings.interfaceLanguage || "en";
  ids("source-language").value = settings.sourceLanguage;
  ids("target-language").value = settings.targetLanguage;
  ids("outgoing-voice").value = settings.outgoingVoice;
  ids("incoming-voice").value = settings.incomingVoice;
  ids("summary-detail").value = settings.summaryDetail;
  const summarySections = { overview: true, topics: true, decisions: true, tasks: true, deadlines: true, owners: true, questions: true, ...(settings.summarySections || {}) };
  SUMMARY_SECTION_IDS.forEach((section) => { ids(`summary-${section}`).checked = Boolean(summarySections[section]); });
  ids("speaker-diarization").checked = settings.speakerDiarization !== false;
  ids("monitor-level").value = settings.monitorLevel;
  ids("max-session-minutes").value = String(settings.maxSessionMinutes || 90);
  ids("auto-pause-seconds").value = String(settings.autoPauseSeconds ?? DEFAULT_SETTINGS.autoPauseSeconds);
  ids("summary-provider").value = settings.summaryProvider || "openai";
  ids("ollama-url").value = settings.ollamaUrl || "";
  ids("ollama-model").value = settings.ollamaModel || "";
  applySummaryProvider();
  await listOutputs(settings.outgoingDeviceId, settings.incomingDeviceId);
}

function applySummaryProvider() {
  const local = ids("summary-provider").value === "ollama";
  ids("ollama-fields").hidden = !local;
  ids("ollama-help").hidden = !local;
  ids("ollama-test-row").hidden = !local;
}

ids("summary-provider").addEventListener("change", applySummaryProvider);

ids("test-ollama").addEventListener("click", async () => {
  const button = ids("test-ollama");
  const status = ids("ollama-test-status");
  const url = ids("ollama-url").value.trim() || DEFAULT_SETTINGS.ollamaUrl;
  const model = ids("ollama-model").value.trim() || DEFAULT_SETTINGS.ollamaModel;
  button.disabled = true;
  status.dataset.state = "loading";
  status.textContent = t(locale, "testing");
  try {
    const result = await chrome.runtime.sendMessage({ type: "TEST_OLLAMA", url, model });
    if (!result?.ok) throw new Error(result?.error === "OLLAMA_UNREACHABLE" ? t(locale, "ollamaUnreachable") : result?.error || t(locale, "checkFailed"));
    // Offer what is actually installed, so a wrong name is corrected by picking
    // from the field instead of being retyped from the error message.
    ids("ollama-models").replaceChildren(...result.models.map((name) => new Option(name, name)));
    // Reaching Ollama is not enough: a missing model only fails when a meeting ends.
    status.dataset.state = result.installed ? "success" : "error";
    status.textContent = result.installed
      ? t(locale, "ollamaReady", { model })
      : t(locale, "ollamaModelMissing", { model, models: result.models.join(", ") || "—" });
  } catch (error) {
    status.dataset.state = "error";
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

ids("reveal-key").addEventListener("click", () => {
  const input = ids("api-key");
  input.type = input.type === "password" ? "text" : "password";
  ids("reveal-key").textContent = t(locale, input.type === "password" ? "show" : "hide");
});

ids("interface-language").addEventListener("change", () => {
  applyLocale(ids("interface-language").value);
});

ids("test-key").addEventListener("click", async () => {
  const button = ids("test-key");
  const status = ids("api-test-status");
  const apiKey = ids("api-key").value.trim();
  if (!apiKey) { status.dataset.state = "error"; status.textContent = t(locale, "enterKey"); return; }
  button.disabled = true;
  status.dataset.state = "loading";
  status.textContent = t(locale, "testing");
  try {
    await saveSettings({ apiKey });
    const result = await chrome.runtime.sendMessage({ type: "TEST_API_KEY" });
    if (!result?.ok) throw new Error(result?.error || t(locale, "checkFailed"));
    status.dataset.state = "success";
    status.textContent = t(locale, "accessible");
  } catch (error) {
    status.dataset.state = "error";
    status.textContent = `${t(locale, "error")}: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});

ids("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const apiKey = ids("api-key").value.trim();
  if (apiKey && !apiKey.startsWith("sk-")) {
    ids("save-status").textContent = t(locale, "keyFormat");
    return;
  }
  await saveSettings({
    apiKey,
    interfaceLanguage: ids("interface-language").value,
    sourceLanguage: ids("source-language").value,
    targetLanguage: ids("target-language").value,
    outgoingVoice: ids("outgoing-voice").value,
    incomingVoice: ids("incoming-voice").value,
    summaryDetail: ids("summary-detail").value,
    summarySections: Object.fromEntries(SUMMARY_SECTION_IDS.map((section) => [section, ids(`summary-${section}`).checked])),
    speakerDiarization: ids("speaker-diarization").checked,
    saveTranscript: true,
    monitorLevel: ids("monitor-level").value,
    outgoingDeviceId: ids("outgoing-device").value,
    incomingDeviceId: ids("incoming-device").value,
    retentionDays: 30,
    maxSessionMinutes: Number(ids("max-session-minutes").value),
    autoPauseSeconds: Number(ids("auto-pause-seconds").value),
    summaryProvider: ids("summary-provider").value,
    ollamaUrl: ids("ollama-url").value.trim() || DEFAULT_SETTINGS.ollamaUrl,
    ollamaModel: ids("ollama-model").value.trim() || DEFAULT_SETTINGS.ollamaModel
  });
  applyLocale(ids("interface-language").value);
  ids("save-status").textContent = t(locale, "saved");
  ids("save-status").dataset.state = "success";
  setTimeout(() => { ids("save-status").textContent = ""; }, 1800);
});

ids("settings-form").addEventListener("input", () => {
  ids("save-status").dataset.state = "dirty";
  ids("save-status").textContent = t(locale, "unsavedChanges");
});

init();
