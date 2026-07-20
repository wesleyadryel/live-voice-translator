import { loadSettings, saveSettings } from "./config.js";

const ids = (name) => document.querySelector(`#${name}`);

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
        option.textContent = device.label || `Аудиовыход ${select.length}`;
        option.selected = device.deviceId === selected;
        select.append(option);
      }
    }
  } catch {
    ids("save-status").textContent = "Разрешите доступ к микрофону, чтобы увидеть аудиоустройства";
  }
}

async function init() {
  const settings = await loadSettings();
  ids("api-key").value = settings.apiKey;
  ids("source-language").value = settings.sourceLanguage;
  ids("target-language").value = settings.targetLanguage;
  ids("outgoing-voice").value = settings.outgoingVoice;
  ids("incoming-voice").value = settings.incomingVoice;
  ids("summary-detail").value = settings.summaryDetail;
  ids("save-transcript").checked = settings.saveTranscript;
  ids("monitor-level").value = settings.monitorLevel;
  await listOutputs(settings.outgoingDeviceId, settings.incomingDeviceId);
}

ids("reveal-key").addEventListener("click", () => {
  const input = ids("api-key");
  input.type = input.type === "password" ? "text" : "password";
  ids("reveal-key").textContent = input.type === "password" ? "Показать" : "Скрыть";
});

ids("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const apiKey = ids("api-key").value.trim();
  if (apiKey && !apiKey.startsWith("sk-")) {
    ids("save-status").textContent = "Ключ должен начинаться с sk-";
    return;
  }
  await saveSettings({
    apiKey,
    sourceLanguage: ids("source-language").value,
    targetLanguage: ids("target-language").value,
    outgoingVoice: ids("outgoing-voice").value,
    incomingVoice: ids("incoming-voice").value,
    summaryDetail: ids("summary-detail").value,
    saveTranscript: ids("save-transcript").checked,
    monitorLevel: ids("monitor-level").value,
    outgoingDeviceId: ids("outgoing-device").value,
    incomingDeviceId: ids("incoming-device").value
  });
  ids("save-status").textContent = "Сохранено";
  setTimeout(() => { ids("save-status").textContent = ""; }, 1800);
});

init();
