import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { t } from "../src/i18n.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [popup, popupJs, offscreenJs, contentModuleJs, realtimeJs, backgroundJs, historyJs, usageJs, usage, usageCss, options, history, releaseCss, optionsCss, historyCss, manifestText, localTranslatorJs] = await Promise.all([
  read("../src/popup.html"),
  read("../src/popup.js"),
  read("../src/offscreen.js"),
  read("../src/conference-content-module.js"),
  read("../src/realtime.js"),
  read("../src/background.js"),
  read("../src/history.js"),
  read("../src/usage.js"),
  read("../src/usage.html"),
  read("../src/usage.css"),
  read("../src/options.html"),
  read("../src/history.html"),
  read("../src/release.css"),
  read("../src/options-enhancements.css"),
  read("../src/history.css"),
  read("../manifest.json"),
  read("../src/local-translator.js")
]);

const allHtml = `${popup}\n${options}\n${history}\n${usage}`;
const translationKeys = [...allHtml.matchAll(/data-i18n(?:-aria|-title|-placeholder)?="([^"]+)"/g)].map((match) => match[1]);
for (const key of new Set(translationKeys)) assert.notEqual(t("en", key), key, `English translation is missing for ${key}`);
for (const language of ["en", "ru", "es", "de", "fr", "pt-BR"]) {
  // Button captions can legitimately be identical across languages ("Original"),
  // but the descriptive titles must be genuinely translated.
  const captions = ["muteAll", "original", "interpreter", "monitorLabel"];
  const titles = ["enableOutgoingMonitor", "disableOutgoingMonitor","muteOutgoingInterpreter", "unmuteOutgoingInterpreter", "muteIncomingInterpreter", "unmuteIncomingInterpreter", "muteOutgoingTranslation", "unmuteOutgoingTranslation", "muteOutgoing", "unmuteOutgoing", "muteIncomingTranslation", "unmuteIncomingTranslation", "muteIncoming", "unmuteIncoming", "addOutgoingOriginal", "removeOutgoingOriginal", "addIncomingOriginal", "removeIncomingOriginal"];
  for (const key of [...captions, ...titles]) assert.notEqual(t(language, key), key, `${language}.${key} is missing`);
  for (const key of titles) {
    if (language !== "en") assert.notEqual(t(language, key), t("en", key), `${language}.${key} still falls back to English`);
  }
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
for (const id of ["mute-outgoing-interpreter", "mute-outgoing-translation", "add-outgoing-original", "add-outgoing-monitor", "mute-outgoing", "mute-incoming-interpreter", "mute-incoming-translation", "add-incoming-original", "mute-incoming"]) {
  assert.match(popup, new RegExp(`id="${id}"`), `the main panel must expose the ${id} control`);
}
assert.match(popupJs, /aria-pressed/, "mute controls must announce their state accessibly");
assert.match(realtimeJs, /Mirror the speaker's delivery exactly: loudness, energy, pace, emotion/, "the interpreter must mirror how something was said, not only what was said");
assert.match(realtimeJs, /stretch drawn-out words and interjections/, "stretched, emphatic delivery must survive translation instead of being tidied up");
assert.equal(realtimeJs.includes('eagerness: "high"'), false, "an eager turn detector clips drawn-out delivery and fires on background noise");
for (const source of [offscreenJs, contentModuleJs]) {
  assert.match(source, /autoGainControl: false/, "automatic gain control would flatten the delivery the interpreter is asked to mirror");
  assert.match(source, /noiseSuppression: false/, "noise suppression gates quiet speech away once the gain boost is gone");
  assert.match(source, /echoCancellation: true/, "echo cancellation must stay on or the translated voice re-enters the microphone");
}
assert.match(offscreenJs, /incomingOutput\.muted = !incomingTranslationAudible/, "the translated voice you hear must follow its own mute");
assert.match(offscreenJs, /setPassthrough\("outgoing", audioEnabled && !outgoingMuted && \(outgoingOriginalOn \|\| !outgoingTranslationAudible\)/, "your original voice must be sent on request, and whenever the translation is not being sent");
assert.match(offscreenJs, /setPassthrough\("incoming", !incomingMuted && \(incomingOriginalOn \|\| !incomingTranslationAudible\)/, "the original voice must play on request, and whenever the translation is not playing");
assert.match(releaseCss, /\.add-button\[aria-pressed="true"\]/, "an add-style toggle must not read as a mute warning when enabled");
// Playing the return feed inside the captured tab put it straight back into
// tabCapture, so the incoming interpreter translated the outgoing translation.
assert.match(contentModuleJs, /if \(outputElement\) outputElement\.muted = true;/, "the conference tab must never play the return feed itself");
assert.equal(/outputElement\.muted = !monitorOn/.test(contentModuleJs), false, "unmuting in the tab feeds the return audio back into tab capture");
assert.match(contentModuleJs, /CONFERENCE_MONITOR_OFFER/, "the return feed must leave the tab over a loopback connection");
assert.match(offscreenJs, /acceptMonitorFeed/, "the offscreen document must play the return feed, out of tabCapture's reach");
assert.match(offscreenJs, /outgoingMonitor\.muted = !outgoingTranslationAudible \|\| !outgoingMonitorOn/, "the return feed must follow the panel switch and stop when nothing is being sent");
assert.match(offscreenJs, /incomingTranslator\?\.close\(\);\s*\n\s*incomingTranslator = null;/, "switching the interpreter off must close its realtime session so no tokens are spent");
// A reconnect must not revive an interpreter that was switched off, and must not put
// a parked one back on the wire: the session comes back, the audio does not.
assert.match(offscreenJs, /incomingTranslator = incomingInterpreterOff \? null :/, "a reconnect must not revive an interpreter that is switched off");
assert.match(offscreenJs, /incomingTranslator\?\.setStreaming\(incomingInterpreterWanted\(\)\)/, "a reconnect must leave a parked side silent");
assert.match(offscreenJs, /!incomingInterpreterOff && !idleParked\.has\("incoming"\)/, "an idle-parked direction must stay closed until its speaker talks again");
assert.match(offscreenJs, /settings\.summaryProvider === "ollama"/, "meeting notes must be able to run on a local model");
// Using the local model has to be verifiable, both before and after a meeting.
assert.match(options, /id="test-ollama"/, "the local notes provider must be testable before relying on it");
// A class-level `display` outranks the browser's [hidden] rule, so any row the
// options page toggles from JS has to opt back in or it ignores `hidden` entirely.
for (const [selector, id] of [[".api-test-control", "ollama-test-row"], [".notes-controls", "ollama-fields"], [".field-help", "ollama-help"]]) {
  assert.ok(options.includes(`id="${id}"`), `${id} must exist to be toggled`);
  assert.ok(optionsCss.includes(`${selector}[hidden] { display: none; }`), `${selector} must honour the hidden attribute`);
}
assert.match(backgroundJs, /TEST_OLLAMA/, "the test must reach Ollama and report whether the chosen model exists");
assert.match(offscreenJs, /record\.summaryEngine = settings\.summaryProvider === "ollama"/, "each meeting must record which engine wrote its notes");
assert.match(historyJs, /summaryEngineLabel/, "the history must show which engine wrote the notes");
assert.match(contentModuleJs, /if \(interpreterOff\) return \{ ok: true \};/, "starting with the outgoing interpreter off must not open a realtime session");
assert.equal(/(outgoing|incoming)Muted\)\s*(return|stop\()/.test(offscreenJs), false, "mute must never stop the session or the transcript");
assert.match(popupJs, /saveSettings\(\{ \[key\]: mutes\[key\] \}\)/, "a mute chosen before starting must persist into the session");
assert.match(popupJs, /button\.disabled = busy \|\| Boolean\(overrides\[key\]\)/, "a narrower control must be inert once a broader one already covers it");
assert.match(popupJs, /renderTranscript\(\)/, "status refreshes must render new transcript lines");
assert.match(offscreenJs, /liveTranscript\.slice\(-32\)/, "status must return a bounded transcript window");
assert.match(offscreenJs, /if \(meeting\) meeting\.transcript\.push\(item\)/, "only note-enabled meetings may persist live transcript items");
assert.match(releaseCss, /height: calc\(100dvh - 16px\)/, "the side panel must have a fixed viewport-sized workspace");
// The spoken words are only useful if they can be read against the translation, which
// takes a second column and the width to put it in.
assert.match(releaseCss, /width: min\(calc\(100% - 16px\), 920px\)/, "the panel must be able to grow wide enough for two columns");
assert.match(releaseCss, /grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/, "a wide panel must place the two transcripts side by side");
assert.match(popup, /id="source-feed"/, "the spoken words must have their own feed");
assert.match(popupJs, /liveTranscript\.filter\(\(item\) => item\.kind === "source"\)/, "the panel must split the two kinds of transcript line");
assert.match(offscreenJs, /state\.sourceTranscriptCount \+= 1/, "each column must count its own lines");
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

// Usage must come from what the API reports, not from elapsed time.
assert.match(realtimeJs, /event\.response\?\.usage/, "token usage must be read from the API's own report");
// The realtime model drives nearly all cost, so it must be choosable and its
// usage attributable — shown as the official model id, not a marketing label.
assert.equal(/const REALTIME_MODEL = "/.test(realtimeJs) || /const REALTIME_MODEL = "/.test(backgroundJs), false, "the realtime model must not be hardcoded");
assert.match(options, /<select id="realtime-model">/, "the translation model must be a normal select");
assert.match(options, />gpt-realtime-1\.5</, "the select must show the official model id");
assert.match(realtimeJs, /translations\/calls/, "translate models must use the dedicated translations endpoint");
assert.match(realtimeJs, /output:\s*\{\s*language:/, "translate sessions must set the target language code");
// The session's own turns are billed on the realtime model, and input transcription
// on the transcription model, so the reported model is a parameter that defaults to
// the session's rather than a constant.
assert.match(realtimeJs, /reportUsage\(usage, model = this\.sessionModel\(\)\)/, "usage must default to the session's own model");
assert.match(realtimeJs, /this\.onUsage\(\{[\s\S]{0,200}?model,/, "usage must say which model produced it");
assert.match(realtimeJs, /this\.reportUsage\(event\.usage, this\.transcriptionModel\)/, "input transcription must be billed to the model the session settled on");
assert.match(offscreenJs, /pendingModels\.set\(model, perModel\)/, "usage must accumulate per model for comparison");
assert.match(usageJs, /average: total \/ \(Number\(entry\.responses\) \|\| 1\)/, "models must be compared per response, not by raw total");
assert.match(options, /id="realtime-model"/, "the translation model must be selectable in settings");
// The note-only modes mute the reply, so asking for audio bought the most
// expensive tokens available and discarded them.
assert.match(realtimeJs, /output_modalities: this\.verbatim \? \["text"\] : \["audio"\]/, "modes that never play a reply must not request audio output");
assert.match(realtimeJs, /response\.output_text\.delta/, "text-only responses report through the text events");
// A speaking mode that loses its dubbing loses the utterance entirely, unless the
// session was also asked to transcribe what it heard.
assert.match(realtimeJs, /transcription: this\.inputTranscription\(\)/, "speaking sessions must request a transcript of their input");
// An update naming audio.input replaces that block, so transcription and turn
// detection have to travel together or the utterance is never closed to transcribe.
assert.match(realtimeJs, /transcription: this\.inputTranscription\(\) \} : \{\}\),\s*\n\s*turn_detection: this\.turnDetection\(\)/, "transcription and turn detection must be set in the same message");
assert.match(realtimeJs, /conversation\.item\.input_audio_transcription\.completed/, "the spoken words arrive on the input transcription event");
// A translate session streams the same words under a different name, with no
// conversation item behind them.
assert.match(realtimeJs, /session\.input_transcript\.delta/, "a translate session reports the spoken words on its own stream");
assert.match(realtimeJs, /scheduleSourceFlush\(\)/, "streamed spoken words must be buffered into whole utterances");
// Speech is read as it is said: the partial line is drawn while the utterance is
// still open, and announced instead of waiting for the next poll.
assert.match(realtimeJs, /this\.onSourcePartial\(this\.sourceBuffer\)/, "the unfinished utterance must reach the panel");
assert.match(offscreenJs, /pendingSourceLines/, "deltas must grow one line rather than stacking half-sentences");
assert.match(offscreenJs, /type: "TRANSCRIPT_UPDATED"/, "a new line must be announced, not waited for");
assert.match(popupJs, /message\?\.type === "TRANSCRIPT_UPDATED"/, "the panel must redraw on the announcement");
// Reading a line back in the other language is Chrome's own on-device translation:
// no key, no request, no tokens — and it must stay that way.
assert.equal(/fetch\(|XMLHttpRequest|api\.openai\.com/.test(localTranslatorJs), false, "the reading translation must never leave the machine");
assert.match(localTranslatorJs, /Translator\.availability/, "availability must be checked before a translator is used");
// The line reads either as it was said or as it means, swapped in place by a button on
// the line itself. That press is also the gesture Chrome requires before it will fetch
// a language pack, which is why the download hangs off it.
assert.match(popupJs, /lineButton\("translate-toggle"/, "every finished line must carry its own translate button");
// A line the interpreter never voiced can be said again by hand, and it has to arrive
// where the interpreter's voice arrives — the meeting, not just this machine.
assert.match(popupJs, /lineButton\("speak-line"/, "spoken lines must carry a button that says them out loud");
assert.match(popupJs, /item\.kind === "source"/, "only the spoken column repairs a missed utterance");
assert.match(offscreenJs, /replayContextFor\(settings\.outgoingDeviceId\)/, "a replayed line must leave through the meeting's own route");
assert.match(offscreenJs, /REPLAY_FEED_OFFER/, "a browser conference must receive the replay over the tab loopback");
// Waiting for the whole file, or for an SDP round trip, puts the delay this feature
// repairs back in front of it.
assert.match(offscreenJs, /response_format: "pcm"/, "a replayed line must not wait to be decoded");
assert.match(offscreenJs, /scheduleSamples\(sink, decoded\.samples\)/, "a replayed line must start playing on its first chunk");
assert.match(offscreenJs, /if \(settings\.webRtcOutgoing\) ensureReplayFeed\(\)/, "the replay loopback must be negotiated with the call");
assert.match(contentModuleJs, /live-voice:replay-track/, "the tab must hand the replay audio to the outgoing bridge");
assert.match(popupJs, /toggleLineTranslation\(translate\.dataset\.translate\)/, "pressing it must swap that line");
assert.match(popupJs, /speakLine\(speak\.dataset\.speak\)/, "pressing the speaker must say that line");
assert.match(popupJs, /if \(shownTranslations\.delete\(id\)\)/, "pressing it again must put the original back");
assert.match(popupJs, /await ensureLocalTranslation\(\)/, "the first press must be allowed to fetch the language pack");
assert.match(popupJs, /pretranslateLines\(\)/, "finished lines must be translated before they are asked for");
assert.match(popupJs, /if \(!item \|\| item\.pending/, "a half-spoken line must not be translated");
// A session that will not take the field drops it silently, so the request has to be
// checked against what came back and retried on a narrower shape.
assert.match(realtimeJs, /transcriptionVariants\(\)/, "the transcription request must have fallbacks");
assert.match(realtimeJs, /"whisper-1"/, "the last fallback must be the model every session has always taken");
assert.match(realtimeJs, /session\?\.audio\?\.input\?\.transcription/, "the effective session config must be checked, not the request");
assert.match(realtimeJs, /this\.sessionUpdatesSeen >= this\.sessionUpdatesSent/, "an early answer must not be read as a refusal of a later request");
assert.match(contentModuleJs, /sourceTranscript: true/, "the conference tab owns your own voice and must transcribe it too");
assert.match(offscreenJs, /sourceTranscript: mode\.audio/, "only the speaking modes pay for input transcription");
assert.match(offscreenJs, /onSourceTranscript: \(text\) =>/, "the spoken words must reach the transcript");
assert.match(offscreenJs, /kind = "translation"/, "transcript items must say whether they are the translation or the original");
assert.match(offscreenJs, /item\.kind !== "source"/, "the summary must not read the same conversation twice");
// Per-minute storage is what makes the minute/hour/day scales possible; a coarser
// resolution cannot be un-aggregated later.
assert.match(offscreenJs, /Math\.floor\(Date\.now\(\) \/ 60000\)/, "usage must be recorded per minute, not per day");
assert.match(offscreenJs, /usageBuckets\[minute\] = values\.map/, "usage minutes must accumulate rather than overwrite");
assert.match(offscreenJs, /USAGE_RETENTION_MINUTES/, "per-minute history must be bounded");
// Most of a call is spent listening, so a side that hears nothing must park itself
// and stop billing — including when the silence is the start of the call. It parks on
// the same timer rather than immediately: connecting costs seconds, and the first
// sentence is the one the user pressed Start to say.
assert.match(offscreenJs, /if \(autoPauseSeconds\(\)\) \{[\s\S]*armIdlePark\("incoming"\)/, "a silent call must park itself on the auto-pause window");
assert.match(offscreenJs, /idleParked\.add\(key\);\s*\n\s*applyInterpreterState/, "parking must close the session that is not being spoken into");
assert.match(offscreenJs, /if \(outgoingInterpreterEligible\(settings\)\) setupSpeechGate\("outgoing"/, "a parked side still needs its gate, or nothing can unpark it");
assert.match(contentModuleJs, /if \(idleParked\) return \{ ok: true \};/, "the conference tab must also start parked");
assert.match(usageJs, /Math\.floor\(minute \/ size\) \* size/, "the chart must fold minutes into the selected scale");
assert.match(usageJs, /stored\.usageDaily/, "usage recorded before per-minute buckets must still appear");
assert.match(usageJs, /const peak = Math\.max/, "the chart must scale bars against the busiest day");
assert.match(usage, /id="usage-chart"/, "the usage page must chart token usage");
// Bars mean nothing without a scale, and the gridlines must match its marks.
assert.equal((usage.match(/<div class="usage-grid"[^>]*>(.*?)<\/div>/s)?.[1].match(/<i>/g) || []).length, 5, "gridlines must match the five scale marks");
assert.match(usageJs, /scale\.replaceChildren/, "the chart must label its vertical scale");
// Pointing at a colour must isolate that colour, in the bars and in the tooltip.
assert.match(usageJs, /function segmentUnder/, "hovering a bar segment must be detected per colour");
assert.match(usageJs, /chart\.dataset\.hovered = segment/, "the chart must expose which colour is hovered so CSS can lift it");
assert.match(usageCss, /\.usage-chart\[data-hovered="audio"\] \.usage-bar-text/, "the other series must recede while a colour is hovered");
assert.match(usageJs, /segment === key \? " is-active" : ""/, "the tooltip row for the hovered colour must be highlighted");
assert.match(usageCss, /\.usage-plot\.preview-audio \.usage-bar-text/, "hovering a legend colour must preview that series");
assert.match(usageCss, /--usage-plot-height:\s*clamp\(/, "scale, gridlines and bars must share one concrete height");
// A custom property defined as var(itself) is invalid, so every length using it
// silently falls back to auto and the element collapses — no error anywhere.
for (const [name, sheet] of [["usage.css", usageCss], ["release.css", releaseCss], ["history.css", historyCss], ["options-enhancements.css", optionsCss]]) {
  const selfReferencing = [...sheet.matchAll(/(--[\w-]+)\s*:\s*var\(\s*(--[\w-]+)\s*\)/g)].filter(([, declared, used]) => declared === used);
  assert.equal(selfReferencing.length, 0, `${name} declares a self-referencing custom property: ${selfReferencing.map(([, n]) => n).join(", ")}`);
}
assert.match(popup, /id="open-usage"/, "usage must be reachable from the panel, not buried in per-meeting history");
assert.match(popupJs, /usage\.html/, "the usage button must open the usage page");
// Usage is not per meeting, so deleting meetings must leave it alone.
assert.equal(historyJs.includes("usageDaily"), false, "clearing meeting history must not erase recorded usage");
assert.match(usageJs, /chrome\.storage\.onChanged\.addListener/, "an open usage page must refresh when a session ends");
// The outgoing interpreter lives in the conference tab, so its cost is invisible
// unless that tab reports it — this was why a dubbed phrase recorded nothing.
assert.match(contentModuleJs, /onUsage: \(usage\) => chrome\.runtime\.sendMessage\(\{ type: "CONFERENCE_USAGE"/, "the conference tab must report what its interpreter spent");
assert.match(backgroundJs, /CONFERENCE_USAGE/, "usage from the conference tab must reach the offscreen document");
assert.match(offscreenJs, /message\.type === "ADD_USAGE"/, "the offscreen document must accept usage reported from a tab");
assert.match(offscreenJs, /usageFlushTimer = setTimeout/, "usage must be persisted while a session runs, not only when it stops");

assert.match(history, /id="history-search"/, "meeting history must be searchable");
assert.match(history, /id="history-count"/, "meeting history must expose its size");
assert.match(historyCss, /aria-current="true"/, "the selected meeting must be visually explicit");

assert.equal(JSON.parse(manifestText).version, "0.9.2");
console.log("release UI regression test: OK");
