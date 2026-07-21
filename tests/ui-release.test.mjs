import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { t } from "../src/i18n.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [popup, popupJs, offscreenJs, options, history, releaseCss, optionsCss, historyCss, manifestText] = await Promise.all([
  read("../src/popup.html"),
  read("../src/popup.js"),
  read("../src/offscreen.js"),
  read("../src/options.html"),
  read("../src/history.html"),
  read("../src/release.css"),
  read("../src/options-enhancements.css"),
  read("../src/history.css"),
  read("../manifest.json")
]);

const allHtml = `${popup}\n${options}\n${history}`;
const translationKeys = [...allHtml.matchAll(/data-i18n(?:-aria|-title|-placeholder)?="([^"]+)"/g)].map((match) => match[1]);
for (const key of new Set(translationKeys)) assert.notEqual(t("en", key), key, `English translation is missing for ${key}`);
for (const language of ["en", "ru", "es", "de", "fr"]) {
  for (const hint of ["translationHint", "notesHint", "bothHint", "transcriptHint"]) {
    assert.ok(t(language, hint).length > 100, `${language}.${hint} must explain both live behavior and the final result`);
  }
}

assert.match(popup, /id="swap-languages"/, "the main panel must let users swap conversation languages");
assert.match(popup, /id="capture-context"/, "the main panel must identify the current capture context");
assert.match(popup, /id="live-transcript"/, "the main panel must expose the live meeting transcript");
assert.match(popup, /aria-live="polite"/, "new transcript lines must be announced accessibly");
for (const page of [popup, options, history]) {
  assert.match(page, /class="(?:app-icon|brand-mark)" src="\.\.\/assets\/icon-128\.png"/, "every extension surface must use the release app icon");
}
assert.match(popupJs, /renderTranscript\(\)/, "status refreshes must render new transcript lines");
assert.match(offscreenJs, /liveTranscript\.slice\(-16\)/, "status must return a bounded transcript window");
assert.match(offscreenJs, /if \(meeting\) meeting\.transcript\.push\(item\)/, "only note-enabled meetings may persist live transcript items");
assert.match(releaseCss, /height: calc\(100dvh - 16px\)/, "the side panel must have a fixed viewport-sized workspace");
assert.match(releaseCss, /prefers-reduced-motion/, "motion must respect the operating-system accessibility setting");

assert.equal(options.includes('id="save-transcript"'), false, "privacy switches removed from the product brief must not remain in settings");
assert.equal(options.includes('id="retention-days"'), false, "automatic-retention controls must not remain in settings");
assert.match(options, /class="header-language-picker"/, "interface language must stay visible without consuming a full settings card");
assert.match(options, /class="notes-controls"/, "note detail and session limit must share a compact control row");
assert.match(options, /class="api-meta-row"/, "API help and connection test must share one aligned support row");
assert.match(options, /class="secondary-button api-test-button"/, "the API test must use the full secondary-button treatment");
assert.match(options, /summary-tasks/);
assert.match(options, /summary-deadlines/);
assert.match(options, /summary-owners/);
assert.match(optionsCss, /position: sticky/, "the save action must remain reachable on long settings pages");
assert.match(optionsCss, /\.options-shell \.compact-settings-form > section \{/, "release section spacing must override the legacy settings selector");

assert.match(history, /id="history-search"/, "meeting history must be searchable");
assert.match(history, /id="history-count"/, "meeting history must expose its size");
assert.match(historyCss, /aria-current="true"/, "the selected meeting must be visually explicit");

assert.equal(JSON.parse(manifestText).version, "0.9.2");
console.log("release UI regression test: OK");
