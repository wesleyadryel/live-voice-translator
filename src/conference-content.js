const conferenceModule = import(chrome.runtime.getURL("src/conference-content-module.js"));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!String(message?.type || "").startsWith("CONFERENCE_")) return false;
  conferenceModule.then((module) => module.handleConferenceMessage(message)).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
