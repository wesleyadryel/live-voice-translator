import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
const mainSource = await readFile(new URL("../src/conference-main.js", import.meta.url), "utf8");
const contentSource = await readFile(new URL("../src/conference-content-module.js", import.meta.url), "utf8");
const background = await readFile(new URL("../src/background.js", import.meta.url), "utf8");
const offscreen = await readFile(new URL("../src/offscreen.js", import.meta.url), "utf8");

const matches = manifest.content_scripts.flatMap((entry) => entry.matches);
for (const pattern of ["https://meet.google.com/*", "https://*.zoom.us/*", "https://telemost.yandex.ru/*"]) {
  assert.ok(matches.includes(pattern), `conference adapter must load on ${pattern}`);
}
assert.ok(manifest.content_scripts.some((entry) => entry.world === "MAIN" && entry.run_at === "document_start"), "WebRTC hook must run in the page's main world before conference scripts");
assert.match(background, /Authorization: `Bearer \$\{apiKey\}`/, "only the service worker may attach the OpenAI API key");
assert.equal(contentSource.includes("apiKey"), false, "the page-side translator must never receive the API key");
assert.match(offscreen, /!settings\.webRtcOutgoing/, "offscreen must not create a second outgoing microphone translator");
assert.equal(background.includes("conferenceCable"), false, "browser conferences must not require a virtual audio cable");

class FakeEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
}

class FakeTrack {
  constructor(name) { this.name = name; this.kind = "audio"; this.readyState = "live"; }
  stop() { this.readyState = "ended"; }
}

class FakeSender {
  constructor(track) { this.track = track; this.history = [track]; }
  async replaceTrack(track) { this.track = track; this.history.push(track); }
}

class FakePeerConnection {
  constructor() { this.senders = []; }
  addTrack(track) { const sender = new FakeSender(track); this.senders.push(sender); return sender; }
  addTransceiver(trackOrKind) { const track = typeof trackOrKind === "object" ? trackOrKind : null; const sender = new FakeSender(track); this.senders.push(sender); return { sender }; }
  getSenders() { return this.senders; }
  close() {}
}

const listeners = new Map();
const translatedTrack = new FakeTrack("translated");
const document = {
  getElementById(id) {
    return id === "translated-output" ? { srcObject: { getAudioTracks: () => [translatedTrack] } } : null;
  }
};
const window = {
  RTCPeerConnection: FakePeerConnection,
  webkitRTCPeerConnection: FakePeerConnection,
  AudioContext: class {
    createOscillator() { return { connect: (node) => node, start() {} }; }
    createGain() { return { gain: { value: 1 }, connect: (node) => node }; }
    createMediaStreamDestination() { return { stream: { getAudioTracks: () => [new FakeTrack("silence")] } }; }
    async close() {}
  },
  addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(listener); },
  dispatchEvent(event) { for (const listener of listeners.get(event.type) || []) listener(event); }
};

vm.runInNewContext(mainSource, { window, document, CustomEvent: FakeEvent, URL, console });
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

window.dispatchEvent(new FakeEvent("live-voice:deactivate"));
await flush();
assert.equal(sender.track, originalTrack, "stopping translation must restore the user's microphone");

console.log("conference WebRTC replacement test: OK");
