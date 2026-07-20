import { loadSettings, saveSettings } from "./config.js";
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
    const permission = await navigator.mediaDevices.getUserMedia({ audio: true });
    permission.getTracks().forEach((track) => track.stop());
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
  } catch {
    ids("save-status").textContent = t(locale, "audioPermission");
  }
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
  ids("save-transcript").checked = settings.saveTranscript;
  ids("monitor-level").value = settings.monitorLevel;
  ids("retention-days").value = String(settings.retentionDays || 30);
  ids("max-session-minutes").value = String(settings.maxSessionMinutes || 90);
  await listOutputs(settings.outgoingDeviceId, settings.incomingDeviceId);
}

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
  if (!apiKey) { status.textContent = t(locale, "enterKey"); return; }
  button.disabled = true;
  status.textContent = t(locale, "testing");
  try {
    await saveSettings({ apiKey });
    const result = await chrome.runtime.sendMessage({ type: "TEST_API_KEY" });
    if (!result?.ok) throw new Error(result?.error || t(locale, "checkFailed"));
    status.textContent = t(locale, "accessible");
  } catch (error) {
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
    saveTranscript: ids("save-transcript").checked,
    monitorLevel: ids("monitor-level").value,
    outgoingDeviceId: ids("outgoing-device").value,
    incomingDeviceId: ids("incoming-device").value,
    retentionDays: Number(ids("retention-days").value),
    maxSessionMinutes: Number(ids("max-session-minutes").value)
  });
  applyLocale(ids("interface-language").value);
  ids("save-status").textContent = t(locale, "saved");
  setTimeout(() => { ids("save-status").textContent = ""; }, 1800);
});

init();
