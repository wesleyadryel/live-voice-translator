import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
const mainSource = await readFile(new URL("../src/conference-main.js", import.meta.url), "utf8");
const contentSource = await readFile(new URL("../src/conference-content-module.js", import.meta.url), "utf8");
const background = await readFile(new URL("../src/background.js", import.meta.url), "utf8");
const offscreen = await readFile(new URL("../src/offscreen.js", import.meta.url), "utf8");

const matches = manifest.content_scripts.flatMap((entry) => entry.matches);
for (const pattern of ["https://meet.google.com/*", "https://*.zoom.us/*", "https://telemost.yandex.ru/*", "https://web.telegram.org/*", "https://*.discord.com/*"]) {
  assert.ok(matches.includes(pattern), `conference adapter must load on ${pattern}`);
  assert.ok(manifest.host_permissions.includes(pattern) || manifest.host_permissions.some((host) => host === pattern), `host permission missing for ${pattern}`);
}
assert.ok(manifest.content_scripts.some((entry) => entry.world === "MAIN" && entry.run_at === "document_start"), "WebRTC hook must run in the page's main world before conference scripts");

// The host check gates outgoing voice routing, so a look-alike domain must never pass.
const isSupportedConferenceUrl = new Function(`${background.match(/function isSupportedConferenceUrl[\s\S]*?\n\}/)[0]}\nreturn isSupportedConferenceUrl;`)();
for (const url of [
  "https://discord.com/channels/@me",
  "https://canary.discord.com/channels/1/2",
  "https://web.telegram.org/k/",
  "https://meet.google.com/abc-defg-hij",
  "https://acme.zoom.us/wc/join/123"
]) {
  assert.ok(isSupportedConferenceUrl(url), `${url} must be treated as a conference tab`);
}
for (const url of ["https://notdiscord.com/app", "https://discord.com.attacker.example/app", "https://example.com", "not a url"]) {
  assert.equal(isSupportedConferenceUrl(url), false, `${url} must not be treated as a conference tab`);
}
assert.match(background, /Authorization: `Bearer \$\{apiKey\}`/, "only the service worker may attach the OpenAI API key");
assert.equal(contentSource.includes("apiKey"), false, "the page-side translator must never receive the API key");
assert.match(offscreen, /!settings\.webRtcOutgoing/, "offscreen must not create a second outgoing microphone translator");
assert.match(contentSource, /CONFERENCE_SET_MUTE/, "the conference tab owns the outgoing audio and must accept mute commands");
assert.match(background, /CONFERENCE_SET_MUTE/, "mute must reach the conference tab while WebRTC routing is active");
assert.match(mainSource, /live-voice:outgoing-mode/, "the page bridge must accept translated/original/silence switches");
assert.match(mainSource, /async function applyOriginalTracks/, "sending your untranslated voice must restore the page's own microphone track");
assert.match(mainSource, /senderPrototype\.replaceTrack = function replaceTrack/, "the app reclaiming its microphone must not silently undo the routing");
assert.match(mainSource, /routingGuardNeeded = \/\(\^\|\\\.\)discord\\\.com\$\/i\.test/, "the routing guard must stay scoped to Discord");
assert.match(mainSource, /if \(routingGuardNeeded && nativeReplaceTrack\)/, "the replaceTrack patch must not apply to apps that already route correctly");
assert.match(mainSource, /if \(routingGuardNeeded\) setInterval\(guardRouting/, "the watchdog must not run on apps that already route correctly");
assert.equal(background.includes("conferenceCable"), false, "browser conferences must not require a virtual audio cable");

class FakeEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
}

// enabled is an accessor on MediaStreamTrack.prototype, which is what the bridge
// guards against voice-activity muting, so the fake mirrors that shape.
class FakeMediaStreamTrack {
  constructor(name) { this.name = name; this.kind = "audio"; this.readyState = "live"; this.enabledValue = true; }
  stop() { this.readyState = "ended"; }
}
Object.defineProperty(FakeMediaStreamTrack.prototype, "enabled", {
  configurable: true,
  get() { return this.enabledValue; },
  set(value) { this.enabledValue = value; }
});
class FakeTrack extends FakeMediaStreamTrack {}

// replaceTrack lives on the prototype, exactly like RTCRtpSender, so the bridge's
// patch is exercised the same way it is in a real conference tab.
class FakeSender {
  constructor(track) { this.track = track; this.history = [track]; }
}
FakeSender.prototype.replaceTrack = async function replaceTrack(track) {
  this.track = track;
  this.history.push(track);
};

class FakePeerConnection {
  constructor() { this.senders = []; }
  addTrack(track) { const sender = new FakeSender(track); this.senders.push(sender); return sender; }
  addTransceiver(trackOrKind) { const track = typeof trackOrKind === "object" ? trackOrKind : null; const sender = new FakeSender(track); this.senders.push(sender); return { sender }; }
  getSenders() { return this.senders; }
  close() {}
}

const listeners = new Map();
const translatedTrack = new FakeTrack("translated");
const capturedMicTrack = new FakeTrack("mic-capture");
const returnTrack = new FakeTrack("their-translation");
const document = {
  getElementById(id) {
    if (id === "translated-output") return { srcObject: { getAudioTracks: () => [translatedTrack] } };
    if (id === "original-output") return { srcObject: { getAudioTracks: () => [capturedMicTrack] } };
    if (id === "return-output") return { srcObject: { getAudioTracks: () => [returnTrack] } };
    return null;
  }
};
const window = {
  // The routing guard is scoped to Discord, so the bridge is exercised on that host.
  location: { hostname: "discord.com" },
  RTCPeerConnection: FakePeerConnection,
  webkitRTCPeerConnection: FakePeerConnection,
  RTCRtpSender: FakeSender,
  MediaStreamTrack: FakeMediaStreamTrack,
  MediaStream: class { constructor(tracks = []) { this.tracks = tracks; } getAudioTracks() { return this.tracks; } },
  AudioContext: class {
    constructor() { this.mixed = []; }
    createOscillator() { return { connect: (node) => node, start() {} }; }
    createGain() { return { gain: { value: 1 }, connect: (node) => node }; }
    createMediaStreamSource(stream) { const context = this; return { connect() { context.mixed.push(...stream.getAudioTracks()); } }; }
    createMediaStreamDestination() {
      const context = this;
      const track = new FakeTrack("silence");
      return { stream: { getAudioTracks: () => [Object.assign(track, { get mixed() { return context.mixed; } })] } };
    }
    async resume() {}
    async close() {}
  },
  addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(listener); },
  dispatchEvent(event) { for (const listener of listeners.get(event.type) || []) listener(event); }
};

let watchdog = () => {};
vm.runInNewContext(mainSource, {
  window,
  document,
  CustomEvent: FakeEvent,
  MediaStream: window.MediaStream,
  setInterval: (fn) => { watchdog = fn; return 0; },
  URL,
  console
});
const originalTrack = new FakeTrack("original");
const pc = new window.RTCPeerConnection();
const sender = pc.addTrack(originalTrack);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

window.dispatchEvent(new FakeEvent("live-voice:activate"));
await flush();
assert.equal(sender.track.name, "silence", "activation must mute the original language before translated audio is ready");

window.dispatchEvent(new FakeEvent("live-voice:translated-track", { detail: { elementId: "translated-output" } }));
await flush();
assert.equal(sender.track, translatedTrack, "the conference must send the translated OpenAI audio track");

// Discord re-installs its own microphone whenever voice-activity gating flips, which
// silently undid the routing and left the participant hearing nothing. The swap must
// be refused outright: undoing it afterwards costs an interruption of the outgoing
// stream every time, which is heard as a chopped-up voice.
const pageMicTrack = new FakeTrack("page-mic");
const swapsBefore = sender.history.length;
await sender.replaceTrack(pageMicTrack);
await flush();
assert.equal(sender.track, translatedTrack, "the app taking its microphone back must not undo the routing");
assert.equal(sender.history.length, swapsBefore, "the routed track must never be swapped out and back, which glitches the audio");

// Gating also mutes by flipping enabled; that must be refused immediately rather
// than corrected a second later, which would drop speech.
translatedTrack.enabled = false;
assert.equal(translatedTrack.enabled, true, "the routed track must refuse to be muted while it is live");

// A sender that appears through a renegotiation the hooks never saw is the one case
// left for the watchdog.
sender.track = pageMicTrack;
watchdog();
await flush();
assert.equal(sender.track, translatedTrack, "a sender that drifted back to the app's microphone must be restored");

window.dispatchEvent(new FakeEvent("live-voice:original-track", { detail: { elementId: "original-output" } }));
await flush();

// The conference app routinely disables or ends the microphone track it handed
// over once that track has been replaced; sending it back would be silence.
originalTrack.enabled = false;
window.dispatchEvent(new FakeEvent("live-voice:outgoing-mode", { detail: { mode: "original" } }));
await flush();
assert.equal(sender.track, capturedMicTrack, "muting the outgoing translation must send the extension's live microphone capture");
assert.equal(sender.track.enabled, true, "the untranslated voice must be sent enabled");

const lateSender = pc.addTrack(new FakeTrack("late"));
await flush();
assert.equal(lateSender.track, capturedMicTrack, "a sender added while sending the original voice must carry it too");

window.dispatchEvent(new FakeEvent("live-voice:outgoing-mode", { detail: { mode: "both" } }));
await flush();
assert.deepEqual(sender.track.mixed, [capturedMicTrack, translatedTrack], "sending both voices must mix the capture and the interpreter into one track");

// The participant's own translated voice is sent back so they hear how it came
// out; it rides along with whatever else is going out.
window.dispatchEvent(new FakeEvent("live-voice:return-track", { detail: { elementId: "return-output" } }));
await flush();
assert.deepEqual(sender.track.mixed, [capturedMicTrack, translatedTrack, returnTrack], "the return feed must be mixed into what is already sent");

window.dispatchEvent(new FakeEvent("live-voice:outgoing-mode", { detail: { mode: "translated" } }));
await flush();
assert.deepEqual(sender.track.mixed, [translatedTrack, returnTrack], "the return feed must ride along in plain translated mode too");

window.dispatchEvent(new FakeEvent("live-voice:return-track", { detail: { elementId: null } }));
await flush();
assert.equal(sender.track, translatedTrack, "dropping the return feed must leave the translation alone");

window.dispatchEvent(new FakeEvent("live-voice:outgoing-mode", { detail: { mode: "both" } }));
await flush();

window.dispatchEvent(new FakeEvent("live-voice:outgoing-mode", { detail: { mode: "silence" } }));
await flush();
assert.equal(sender.track.name, "silence", "muting everything outgoing must leave the participant in silence");
assert.deepEqual(sender.track.mixed ?? [], [], "the silence track must not carry the previous mix");

window.dispatchEvent(new FakeEvent("live-voice:outgoing-mode", { detail: { mode: "translated" } }));
await flush();
assert.equal(sender.track, translatedTrack, "unmuting must return to the translated audio without a reconnect");

// With no usable capture left, the page's own track is the fallback. It must be the
// most recent one the page installed — restoring the track it already swapped away
// from would send a dead microphone — and it must be re-enabled on the way out.
capturedMicTrack.stop();
pageMicTrack.enabled = false;
window.dispatchEvent(new FakeEvent("live-voice:outgoing-mode", { detail: { mode: "original" } }));
await flush();
assert.equal(sender.track, pageMicTrack, "the fallback must restore the microphone the page installed most recently");
assert.equal(pageMicTrack.enabled, true, "a disabled fallback track must be re-enabled before it is sent");

window.dispatchEvent(new FakeEvent("live-voice:deactivate"));
await flush();
assert.equal(sender.track, pageMicTrack, "stopping translation must restore the user's microphone");

// On the apps that already route correctly the bridge must behave exactly as before:
// no sender patch, no watchdog. Fresh classes so the patches above cannot leak in.
class PlainSender { constructor(track) { this.track = track; } }
PlainSender.prototype.replaceTrack = async function replaceTrack(track) { this.track = track; };
class PlainPeerConnection {
  constructor() { this.senders = []; }
  addTrack(track) { const s = new PlainSender(track); this.senders.push(s); return s; }
  addTransceiver() { const s = new PlainSender(null); this.senders.push(s); return { sender: s }; }
  getSenders() { return this.senders; }
  close() {}
}
const pristineReplaceTrack = PlainSender.prototype.replaceTrack;
const pristineAddTrack = PlainPeerConnection.prototype.addTrack;
let meetWatchdogInstalled = false;
const meetWindow = {
  location: { hostname: "meet.google.com" },
  RTCPeerConnection: PlainPeerConnection,
  RTCRtpSender: PlainSender,
  AudioContext: window.AudioContext,
  MediaStream: window.MediaStream,
  addEventListener() {},
  dispatchEvent() {}
};
vm.runInNewContext(mainSource, {
  window: meetWindow,
  document,
  CustomEvent: FakeEvent,
  MediaStream: meetWindow.MediaStream,
  setInterval: () => { meetWatchdogInstalled = true; return 0; },
  URL,
  console
});
assert.equal(PlainSender.prototype.replaceTrack, pristineReplaceTrack, "outside Discord the sender prototype must be left alone");
assert.equal(meetWatchdogInstalled, false, "outside Discord no routing watchdog may run");
assert.notEqual(PlainPeerConnection.prototype.addTrack, pristineAddTrack, "the shared track hooks must still be installed everywhere");

console.log("conference WebRTC replacement test: OK");
