import { t } from "./i18n.js";

let offscreenCreating;
let lastCaptureError = "";
let activeConferenceTabId = null;

import { DEFAULT_REALTIME_MODEL, realtimeUrl } from "./realtime.js";

async function currentRealtimeModel() {
  const { realtimeModel = DEFAULT_REALTIME_MODEL } = await chrome.storage.local.get({ realtimeModel: DEFAULT_REALTIME_MODEL });
  return realtimeModel || DEFAULT_REALTIME_MODEL;
}

function isSupportedConferenceUrl(url = "") {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "meet.google.com" || host.endsWith(".zoom.us") || host === "telemost.yandex.ru" || host === "telemost.yandex.com" || host === "web.telegram.org" || host === "discord.com" || host.endsWith(".discord.com");
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

// A session that ended for any reason leaves no prepared capture behind, and the
// toolbar click that originally authorised it is long gone. activeTab stays granted
// until the tab navigates, so a fresh stream can usually be obtained right here —
// which is what keeps a restart from requiring the panel to be reopened.
async function ensurePreparedCapture(tabId) {
  if (!tabId) return;
  const status = await chrome.runtime.sendMessage({ target: "offscreen", type: "GET_STATUS" });
  if (status?.preparedTabId === tabId || status?.state?.active) return;
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const prepared = await chrome.runtime.sendMessage({ target: "offscreen", type: "PREPARE_TAB_CAPTURE", streamId, tabId });
  if (!prepared?.ok) throw new Error(prepared?.error || "TAB_CAPTURE_NOT_PREPARED");
}

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
      const response = await fetch(realtimeUrl(await currentRealtimeModel()), {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/sdp" },
        body: message.sdp
      });
      if (!response.ok) throw new Error(`OpenAI ${response.status}: ${(await response.text()).slice(0, 180)}`);
      sendResponse({ ok: true, answerSdp: await response.text() });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  // Local loopback that carries the return feed out of the captured tab.
  if (message.type === "CONFERENCE_MONITOR_OFFER") {
    (async () => {
      if (sender.tab?.id !== activeConferenceTabId) throw new Error("CONFERENCE_SESSION_NOT_ACTIVE");
      await ensureOffscreenDocument();
      sendResponse(await chrome.runtime.sendMessage({ target: "offscreen", type: "MONITOR_OFFER", sdp: message.sdp }));
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "CONFERENCE_MONITOR_STOP") {
    chrome.runtime.sendMessage({ target: "offscreen", type: "MONITOR_STOP" }).catch(() => {});
    return false;
  }

  // Offscreen holds the participant's translated voice; the sender that can deliver
  // it back to them lives in the conference tab.
  if (message.type === "RETURN_FEED_OFFER") {
    (async () => {
      if (!activeConferenceTabId) throw new Error("CONFERENCE_SESSION_NOT_ACTIVE");
      sendResponse(await chrome.tabs.sendMessage(activeConferenceTabId, { type: "CONFERENCE_RETURN_OFFER", sdp: message.sdp }));
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  // A replayed line has to reach the meeting the same way the interpreter's voice
  // does, which in a browser conference means the tab that holds the outgoing track.
  if (message.type === "REPLAY_FEED_OFFER") {
    (async () => {
      if (!activeConferenceTabId) throw new Error("CONFERENCE_SESSION_NOT_ACTIVE");
      sendResponse(await chrome.tabs.sendMessage(activeConferenceTabId, { type: "CONFERENCE_REPLAY_OFFER", sdp: message.sdp }));
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "REPLAY_FEED_STOP") {
    if (activeConferenceTabId) chrome.tabs.sendMessage(activeConferenceTabId, { type: "CONFERENCE_REPLAY_STOP" }).catch(() => {});
    return false;
  }

  if (message.type === "REPLAY_LINE" || message.type === "REPLAY_STOP") {
    (async () => {
      await ensureOffscreenDocument();
      sendResponse(await chrome.runtime.sendMessage({ target: "offscreen", type: message.type, text: message.text }));
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "RETURN_FEED_STOP") {
    if (activeConferenceTabId) chrome.tabs.sendMessage(activeConferenceTabId, { type: "CONFERENCE_RETURN_STOP" }).catch(() => {});
    return false;
  }

  if (message.type === "CONFERENCE_USAGE") {
    if (sender.tab?.id !== activeConferenceTabId) return false;
    chrome.runtime.sendMessage({ target: "offscreen", type: "ADD_USAGE", usage: message.usage }).catch(() => {});
    return false;
  }

  if (message.type === "CONFERENCE_OUTGOING_TRANSCRIPT") {
    if (sender.tab?.id !== activeConferenceTabId) return false;
    chrome.runtime.sendMessage({ target: "offscreen", type: "ADD_OUTGOING_TRANSCRIPT", text: message.text, language: message.language, kind: message.kind }).catch(() => {});
    return false;
  }

  if (message.type === "CONFERENCE_ACTIVITY") {
    if (sender.tab?.id !== activeConferenceTabId) return false;
    chrome.runtime.sendMessage({ target: "offscreen", type: "SET_ACTIVITY", direction: "outgoing", stage: message.stage }).catch(() => {});
    return false;
  }

  if (message.type === "CONFERENCE_OUTGOING_DISCONNECTED") {
    if (sender.tab?.id !== activeConferenceTabId) return false;
    chrome.runtime.sendMessage({ target: "offscreen", type: "OUTGOING_DISCONNECTED", reason: message.reason || "disconnected" }).catch(() => {});
    return false;
  }

  // The list comes from the account itself, so it reflects the models actually
  // available rather than a hardcoded guess that ages badly.
  if (message.type === "LIST_REALTIME_MODELS") {
    (async () => {
      const { apiKey = "" } = await chrome.storage.local.get({ apiKey: "" });
      if (!apiKey) throw new Error("API_KEY_MISSING");
      const response = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!response.ok) throw new Error(`OpenAI ${response.status}`);
      const models = ((await response.json())?.data || [])
        .map((item) => item.id)
        .filter((id) => /realtime/i.test(id))
        .sort();
      sendResponse({ ok: true, models });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "TEST_OLLAMA") {
    (async () => {
      const base = String(message.url || "").replace(/\/+$/, "");
      const response = await fetch(`${base}/api/tags`).catch(() => null);
      if (!response) throw new Error("OLLAMA_UNREACHABLE");
      if (!response.ok) throw new Error(`Ollama ${response.status}`);
      const models = ((await response.json())?.models || []).map((item) => item.name);
      // Ollama accepts "llama3.1" for a tag stored as "llama3.1:latest".
      const wanted = String(message.model || "");
      const installed = models.some((name) => name === wanted || name.split(":")[0] === wanted.split(":")[0]);
      sendResponse({ ok: true, models, installed });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "TEST_API_KEY") {
    (async () => {
      const { apiKey = "", interfaceLanguage = "en" } = await chrome.storage.local.get({ apiKey: "", interfaceLanguage: "en" });
      if (!apiKey) throw new Error(t(interfaceLanguage, "apiKeyMissing"));
      const response = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(await currentRealtimeModel())}`, {
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
      await ensurePreparedCapture(message.tabId);
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
            outgoingVoice: settings.outgoingVoice,
            outgoingMuted: Boolean(settings.outgoingMuted),
            outgoingTranslationMuted: Boolean(settings.outgoingTranslationMuted),
            outgoingInterpreterOff: Boolean(settings.outgoingInterpreterOff),
            outgoingOriginalOn: Boolean(settings.outgoingOriginalOn),
            outgoingMonitorOn: Boolean(settings.outgoingMonitorOn),
            outgoingGain: settings.outgoingGain,
            outgoingVoiceGain: settings.outgoingVoiceGain,
            outgoingLowCutHz: settings.outgoingLowCutHz,
            outgoingClarityDb: settings.outgoingClarityDb,
            outgoingHighCutHz: settings.outgoingHighCutHz,
            outgoingPauseMs: settings.outgoingPauseMs,
            autoPauseSeconds: settings.autoPauseSeconds,
            realtimeModel: settings.realtimeModel
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

  // Your own microphone is processed wherever it is captured: in the conference tab
  // while WebRTC routing owns it, in the offscreen document otherwise. The
  // participant's audio always comes from tab capture, so that half stays offscreen.
  if (message.type === "SET_AUDIO") {
    (async () => {
      await ensureOffscreenDocument();
      if (activeConferenceTabId && message.outgoing) {
        await chrome.tabs.sendMessage(activeConferenceTabId, { type: "CONFERENCE_SET_AUDIO", outgoing: message.outgoing }).catch(() => {});
      }
      sendResponse(await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "SET_AUDIO",
        outgoing: message.outgoing,
        incoming: message.incoming
      }));
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "SET_MUTE") {
    (async () => {
      await ensureOffscreenDocument();
      // The outgoing audio lives in the conference tab whenever WebRTC routing is
      // active, so that half of the request has to reach the content script too.
      if (activeConferenceTabId) {
        await chrome.tabs.sendMessage(activeConferenceTabId, {
          type: "CONFERENCE_SET_MUTE",
          outgoingMuted: message.outgoingMuted,
          outgoingTranslationMuted: message.outgoingTranslationMuted,
          outgoingInterpreterOff: message.outgoingInterpreterOff,
          outgoingOriginalOn: message.outgoingOriginalOn,
          outgoingMonitorOn: message.outgoingMonitorOn,
          incomingReturnOn: message.incomingReturnOn
        }).catch(() => {});
      }
      sendResponse(await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "SET_MUTE",
        outgoingMuted: message.outgoingMuted,
        outgoingTranslationMuted: message.outgoingTranslationMuted,
        outgoingInterpreterOff: message.outgoingInterpreterOff,
        outgoingOriginalOn: message.outgoingOriginalOn,
        outgoingMonitorOn: message.outgoingMonitorOn,
        incomingMuted: message.incomingMuted,
        incomingTranslationMuted: message.incomingTranslationMuted,
        incomingInterpreterOff: message.incomingInterpreterOff,
        incomingOriginalOn: message.incomingOriginalOn,
        incomingReturnOn: message.incomingReturnOn
      }));
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
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
