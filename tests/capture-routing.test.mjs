import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const background = await readFile(new URL("../src/background.js", import.meta.url), "utf8");
const offscreen = await readFile(new URL("../src/offscreen.js", import.meta.url), "utf8");
const popup = await readFile(new URL("../src/popup.js", import.meta.url), "utf8");

const actionStart = background.indexOf("chrome.action.onClicked.addListener");
const captureAuthorization = background.indexOf("chrome.tabCapture.getMediaStreamId", actionStart);
const preparedMessage = background.indexOf('type: "PREPARE_TAB_CAPTURE"', captureAuthorization);
const panelOpen = background.indexOf("chrome.sidePanel.open", preparedMessage);

assert.ok(actionStart >= 0, "the toolbar action must own capture authorization");
assert.ok(captureAuthorization > actionStart, "tab capture must be authorized inside the toolbar action");
assert.ok(preparedMessage > captureAuthorization, "the stream ID must be consumed immediately by the offscreen document");
assert.ok(panelOpen > preparedMessage, "the panel must open only after capture has been prepared");

const startHandler = background.slice(background.indexOf('message.type === "START_TRANSLATION"'));
assert.equal(startHandler.includes("chrome.tabCapture.getMediaStreamId"), false, "Start must not request a new stream after the action event expires");
assert.match(offscreen, /prepareTabCapture\(streamId, tabId\)/, "offscreen must consume and retain the authorized stream");
assert.match(offscreen, /takePreparedCapture\(settings\.captureTabId\)/, "translation must use the prepared stream");
assert.equal(popup.includes("chrome.tabCapture.capture"), false, "the side panel must not attempt foreground tab capture");
assert.match(popup, /preparedTabId = result\?\.preparedTabId/, "the panel must expose whether the current tab was prepared");

console.log("capture routing regression test: OK");
