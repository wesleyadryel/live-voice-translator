import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { t } from "../src/i18n.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [popup, options, history, releaseCss, optionsCss, historyCss, manifestText] = await Promise.all([
  read("../src/popup.html"),
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

assert.match(popup, /id="swap-languages"/, "the main panel must let users swap conversation languages");
assert.match(popup, /id="capture-context"/, "the main panel must identify the current capture context");
assert.match(releaseCss, /height: calc\(100dvh - 16px\)/, "the side panel must have a fixed viewport-sized workspace");
assert.match(releaseCss, /prefers-reduced-motion/, "motion must respect the operating-system accessibility setting");

assert.equal(options.includes('id="save-transcript"'), false, "privacy switches removed from the product brief must not remain in settings");
assert.equal(options.includes('id="retention-days"'), false, "automatic-retention controls must not remain in settings");
assert.match(options, /summary-tasks/);
assert.match(options, /summary-deadlines/);
assert.match(options, /summary-owners/);
assert.match(optionsCss, /position: sticky/, "the save action must remain reachable on long settings pages");

assert.match(history, /id="history-search"/, "meeting history must be searchable");
assert.match(history, /id="history-count"/, "meeting history must expose its size");
assert.match(historyCss, /aria-current="true"/, "the selected meeting must be visually explicit");

assert.equal(JSON.parse(manifestText).version, "0.9.1");
console.log("release UI regression test: OK");
