import { t } from "./i18n.js";

let offscreenCreating;
let lastCaptureError = "";
let activeConferenceTabId = null;

const REALTIME_MODEL = "gpt-realtime-1.5";
const REALTIME_URL = `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(REALTIME_MODEL)}`;

function isSupportedConferenceUrl(url = "") {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "meet.google.com" || host.endsWith(".zoom.us") || host === "telemost.yandex.ru" || host === "telemost.yandex.com";
  } catch {
    return false;
  }
}

async function stopConferenceOutgoing(tabId = activeConferenceTabId) {
  if (!tabId) return;
  await chrome.tabs.sendMessage(tabId, { type: "CONFERENCE_STOP_OUTGOING" }).catch(() => {});
  if (activeConferenceTabId === tabId) activeConferenceTabId = null;
}

// This preference persists in the Chrome profile across extension reloads.
// It must be reset explicitly or Chrome opens the side panel itself and skips
// chrome.action.onClicked, so tabCapture never receives its required gesture.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  const panelPromise = chrome.sidePanel.open({ tabId: tab.id });
  const streamIdPromise = /^https?:/i.test(tab.url || "") ? chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }) : null;
  (async () => {
    lastCaptureError = "";
    if (!streamIdPromise) {
      await panelPromise;
      return;
    }
    const streamId = await streamIdPromise;
    await ensureOffscreenDocument();
    const status = await chrome.runtime.sendMessage({ target: "offscreen", type: "GET_STATUS" });
    if (!status?.state?.active) {
      // tabCapture authorization exists only inside this action event. Consume
      // the stream ID immediately and let the offscreen document hold the stream
      // until the user presses Start.
      const prepared = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "PREPARE_TAB_CAPTURE",
        streamId,
        tabId: tab.id
      });
      if (!prepared?.ok) throw new Error(prepared?.error || "Could not prepare tab audio");
    }
    await setActionState(Boolean(status?.state?.active));
    await panelPromise;
  })().catch(async (error) => {
    lastCaptureError = error?.message || String(error);
    await setActionState(false, true).catch(() => {});
    await panelPromise.catch(() => {});
  });
});

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
    stopConferenceOutgoing().catch(() => {});
    setActionState(false, Boolean(message.result?.state?.error)).catch(() => {});
    return false;
  }

  if (message.type === "CONFERENCE_REALTIME_SDP") {
    (async () => {
      if (!sender.tab?.id || !isSupportedConferenceUrl(sender.tab.url)) throw new Error("UNSUPPORTED_CONFERENCE_TAB");
      if (sender.tab.id !== activeConferenceTabId) throw new Error("CONFERENCE_SESSION_NOT_ACTIVE");
      if (typeof message.sdp !== "string" || !message.sdp.startsWith("v=0")) throw new Error("INVALID_REALTIME_SDP");
      const { apiKey = "" } = await chrome.storage.local.get({ apiKey: "" });
      if (!apiKey) throw new Error("API_KEY_MISSING");
      const response = await fetch(REALTIME_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/sdp" },
        body: message.sdp
      });
      if (!response.ok) throw new Error(`OpenAI ${response.status}: ${(await response.text()).slice(0, 180)}`);
      sendResponse({ ok: true, answerSdp: await response.text() });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "CONFERENCE_OUTGOING_TRANSCRIPT") {
    if (sender.tab?.id !== activeConferenceTabId) return false;
    chrome.runtime.sendMessage({ target: "offscreen", type: "ADD_OUTGOING_TRANSCRIPT", text: message.text, language: message.language }).catch(() => {});
    return false;
  }

  if (message.type === "CONFERENCE_OUTGOING_DISCONNECTED") {
    if (sender.tab?.id !== activeConferenceTabId) return false;
    chrome.runtime.sendMessage({ target: "offscreen", type: "OUTGOING_DISCONNECTED", reason: message.reason || "disconnected" }).catch(() => {});
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
      const settings = { ...(await chrome.storage.local.get()), captureKind: message.captureKind || "meeting", captureTabId: message.tabId };
      if (settings.captureKind === "media") {
        settings.sourceLanguage = message.sourceLanguage || settings.mediaSourceLanguage || "English";
        settings.targetLanguage = message.targetLanguage || settings.mediaTargetLanguage || "Russian";
      }
      const locale = settings.interfaceLanguage || "en";
      const browserOutgoing = settings.captureKind !== "media" && ["translation", "both"].includes(settings.mode);
      if (browserOutgoing) {
        const tab = await chrome.tabs.get(message.tabId);
        if (!isSupportedConferenceUrl(tab.url)) throw new Error(t(locale, "conferenceTab"));
        activeConferenceTabId = tab.id;
        const outgoing = await chrome.tabs.sendMessage(tab.id, {
          type: "CONFERENCE_START_OUTGOING",
          settings: {
            sourceLanguage: settings.sourceLanguage,
            targetLanguage: settings.targetLanguage,
            outgoingVoice: settings.outgoingVoice
          }
        });
        if (!outgoing?.ok) throw new Error(outgoing?.error || "CONFERENCE_WEBRTC_ROUTE_FAILED");
        settings.webRtcOutgoing = true;
      }
      const result = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "START_TRANSLATION",
        settings
      });
      if (!result?.ok && settings.webRtcOutgoing) await stopConferenceOutgoing(message.tabId);
      await setActionState(Boolean(result?.ok && result?.state?.active), !result?.ok);
      sendResponse(result);
    })().catch(async (error) => {
      await stopConferenceOutgoing(message.tabId);
      await setActionState(false, true);
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message.type === "STOP_TRANSLATION" || message.type === "GET_STATUS") {
    (async () => {
      await ensureOffscreenDocument();
      if (message.type === "STOP_TRANSLATION") await stopConferenceOutgoing();
      const result = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: message.type
      });
      if (message.type === "GET_STATUS") result.captureError = lastCaptureError;
      if (message.type === "GET_STATUS" && activeConferenceTabId) {
        const outgoing = await chrome.tabs.sendMessage(activeConferenceTabId, { type: "CONFERENCE_GET_OUTGOING_STATUS" }).catch(() => null);
        result.outgoingRouteStatus = outgoing?.routeStatus || null;
      }
      if (message.type === "STOP_TRANSLATION") await setActionState(false);
      if (message.type === "GET_STATUS") await setActionState(Boolean(result?.state?.active), Boolean(result?.state?.error));
      sendResponse(result);
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
