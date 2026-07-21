import { t } from "./i18n.js";

let offscreenCreating;

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

async function currentLocale() {
  const { interfaceLanguage = "en" } = await chrome.storage.local.get({ interfaceLanguage: "en" });
  return interfaceLanguage;
}

async function setActionState(active, error = false) {
  const locale = await currentLocale();
  await chrome.action.setBadgeBackgroundColor({ color: error ? "#d95c5c" : "#3bd879" });
  await chrome.action.setBadgeText({ text: error ? "!" : active ? "ON" : "" });
  await chrome.action.setTitle({ title: error ? `${t(locale, "appTitle")} — ${t(locale, "error")}` : active ? `${t(locale, "appTitle")} — ${t(locale, "live")}` : t(locale, "appTitle") });
}

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL("src/offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url]
  });
  if (contexts.length) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url: "src/offscreen.html",
      reasons: ["USER_MEDIA", "WEB_RTC", "AUDIO_PLAYBACK"],
      justification: "Translate microphone and conference audio in real time"
    }).finally(() => { offscreenCreating = undefined; });
  }
  await offscreenCreating;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "STORAGE_GET") {
    chrome.storage.local.get(message.defaults || {}).then((value) => sendResponse({ ok: true, value }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "STORAGE_SET") {
    chrome.storage.local.set(message.value || {}).then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.target === "offscreen") return false;

  if (message.type === "SESSION_ENDED") {
    setActionState(false, Boolean(message.result?.state?.error)).catch(() => {});
    return false;
  }

  if (message.type === "TEST_API_KEY") {
    (async () => {
      const { apiKey = "", interfaceLanguage = "en" } = await chrome.storage.local.get({ apiKey: "", interfaceLanguage: "en" });
      if (!apiKey) throw new Error(t(interfaceLanguage, "apiKeyMissing"));
      const response = await fetch("https://api.openai.com/v1/models/gpt-realtime-1.5", {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (!response.ok) throw new Error(`OpenAI ${response.status}: ${await response.text()}`);
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ ok: false, error: error.message.slice(0, 240) }));
    return true;
  }

  if (message.type === "START_TRANSLATION") {
    (async () => {
      await ensureOffscreenDocument();
      const settings = { ...(await chrome.storage.local.get()), captureKind: message.captureKind || "meeting" };
      const locale = settings.interfaceLanguage || "en";
      if (settings.captureKind !== "media" && ["translation", "both"].includes(settings.mode) && settings.audioProfile === "conference" && (!settings.outgoingDeviceId || settings.outgoingDeviceId === "default")) {
        throw new Error(t(locale, "conferenceCable"));
      }
      if (settings.captureKind !== "media" && ["translation", "both"].includes(settings.mode) && settings.audioProfile === "conference" && settings.outgoingDeviceId === settings.incomingDeviceId) {
        throw new Error(t(locale, "differentOutputs"));
      }
      const streamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: message.tabId
      });
      const result = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "START_TRANSLATION",
        streamId,
        settings
      });
      await setActionState(Boolean(result?.ok && result?.state?.active), !result?.ok);
      sendResponse(result);
    })().catch(async (error) => {
      await setActionState(false, true);
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message.type === "STOP_TRANSLATION" || message.type === "GET_STATUS") {
    (async () => {
      await ensureOffscreenDocument();
      const result = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: message.type
      });
      if (message.type === "STOP_TRANSLATION") await setActionState(false);
      if (message.type === "GET_STATUS") await setActionState(Boolean(result?.state?.active), Boolean(result?.state?.error));
      sendResponse(result);
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
