let offscreenCreating;

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
  if (message.target === "offscreen") return false;

  if (message.type === "START_TRANSLATION") {
    (async () => {
      await ensureOffscreenDocument();
      const streamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: message.tabId
      });
      const result = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "START_TRANSLATION",
        streamId
      });
      sendResponse(result);
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "STOP_TRANSLATION" || message.type === "GET_STATUS") {
    (async () => {
      await ensureOffscreenDocument();
      sendResponse(await chrome.runtime.sendMessage({
        target: "offscreen",
        type: message.type
      }));
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
