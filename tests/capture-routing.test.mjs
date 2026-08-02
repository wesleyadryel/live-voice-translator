import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const background = await readFile(new URL("../src/background.js", import.meta.url), "utf8");
const offscreen = await readFile(new URL("../src/offscreen.js", import.meta.url), "utf8");
const popup = await readFile(new URL("../src/popup.js", import.meta.url), "utf8");
const config = await readFile(new URL("../src/config.js", import.meta.url), "utf8");
const realtime = await readFile(new URL("../src/realtime.js", import.meta.url), "utf8");

const actionStart = background.indexOf("chrome.action.onClicked.addListener");
const captureAuthorization = background.indexOf("chrome.tabCapture.getMediaStreamId", actionStart);
const preparedMessage = background.indexOf('type: "PREPARE_TAB_CAPTURE"', captureAuthorization);
const panelOpen = background.indexOf("chrome.sidePanel.open", actionStart);
const firstAwait = background.indexOf("await ", actionStart);

assert.match(background, /setPanelBehavior\(\{ openPanelOnActionClick: false \}\)/, "Chrome's persisted automatic panel behavior must be disabled");
assert.ok(actionStart >= 0, "the toolbar action must own capture authorization");
assert.ok(captureAuthorization > actionStart, "tab capture must be authorized inside the toolbar action");
assert.ok(panelOpen > actionStart && panelOpen < firstAwait, "the panel must open before the action gesture expires");
assert.ok(captureAuthorization < firstAwait, "tab capture must be requested before the first async boundary");
assert.ok(preparedMessage > captureAuthorization, "the stream ID must be consumed immediately by the offscreen document");

// Start may re-authorize, but only as a fallback: activeTab survives until the tab
// navigates, so a restart after a stop should not force the user back to the toolbar.
// It must still check for an existing prepared stream first, and must never replace
// the authorization done inside the toolbar action above.
assert.match(background, /async function ensurePreparedCapture/, "a restart must be able to re-prepare the capture on its own");
assert.match(background, /if \(status\?\.preparedTabId === tabId \|\| status\?\.state\?\.active\) return;/, "re-authorization must be skipped when a usable capture already exists");
const ensureBody = background.slice(background.indexOf("async function ensurePreparedCapture"));
assert.ok(ensureBody.indexOf("preparedTabId === tabId") < ensureBody.indexOf("getMediaStreamId"), "the existing capture must be checked before requesting a new stream");
const startHandler = background.slice(background.indexOf('message.type === "START_TRANSLATION"'));
assert.match(startHandler, /await ensurePreparedCapture\(message\.tabId\)/, "starting must guarantee a prepared capture instead of failing with a hint");
assert.match(offscreen, /prepareTabCapture\(streamId, tabId\)/, "offscreen must consume and retain the authorized stream");
assert.match(offscreen, /takePreparedCapture\(settings\.captureTabId\)/, "translation must use the prepared stream");
assert.equal(popup.includes("chrome.tabCapture.capture"), false, "the side panel must not attempt foreground tab capture");
assert.match(popup, /preparedTabId = result\?\.preparedTabId/, "the panel must expose whether the current tab was prepared");
assert.match(config, /mediaSourceLanguage:\s*"English"/, "video translation must default to English input");
assert.match(config, /mediaTargetLanguage:\s*"Russian"/, "video translation must default to Russian output");
assert.match(popup, /activeCaptureKind === "media"[\s\S]*mediaSourceLanguage/, "video language settings must be independent from meeting languages");
assert.match(background, /settings\.sourceLanguage = message\.sourceLanguage \|\| settings\.mediaSourceLanguage/, "a media session must use its own source language");
assert.match(offscreen, /translatedUtteranceCount \+= 1/, "completed spoken translations must be observable in session state");
assert.match(popup, /Переведено фраз:/, "the panel must show that translated speech was generated");
assert.match(offscreen, /manualChunkMs: mediaCapture \? 6000 : 0/, "continuous video speech must be divided into bounded chunks");
assert.match(realtime, /input_audio_buffer\.commit/, "manual video chunks must commit accumulated audio");
assert.match(realtime, /type: "response\.create"/, "each committed video chunk must request a translation response");
// Retaining the stream is what makes a restart instant; limiting it to media tabs
// was why stopping a meeting used to demand a trip back to the toolbar icon.
assert.match(offscreen, /reason !== "tab_closed" && tabStream\?\.active \? tabStream : null/, "any stop but a closed tab must retain the live authorized stream");
assert.equal(/reusableTabStream[\s\S]{0,120}captureKind === "media"/.test(offscreen), false, "stream reuse must not be restricted to media tabs");
assert.match(offscreen, /holdPreparedCapture\(reusableTabStream, activeSettings\.captureTabId\)/, "a stopped session must be immediately ready to restart");

console.log("capture routing regression test: OK");
