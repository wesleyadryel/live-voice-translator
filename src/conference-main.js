(() => {
  if (window.__liveVoiceWebRtcBridge) return;

  const NativePeerConnection = window.RTCPeerConnection;
  if (!NativePeerConnection) return;

  const peerConnections = new Set();
  const originalTracks = new Map();
  let active = false;
  let replacementTrack = null;
  let translatedTrack = null;
  let originalMicTrack = null;
  // translated: the participant hears the interpreter.
  // original: the participant hears the untranslated voice from this page's own mic.
  // both: the participant hears the original voice and the interpreter together.
  // silence: the participant hears nothing at all.
  let outgoingMode = "translated";
  let silenceContext = null;
  let silenceTrack = null;
  let mixContext = null;
  let mixTrack = null;

  function report(status, detail = "") {
    window.dispatchEvent(new CustomEvent("live-voice:route-status", { detail: { status, detail } }));
  }

  function remember(sender, track = sender?.track) {
    if (sender && track?.kind === "audio" && !originalTracks.has(sender)) originalTracks.set(sender, track);
  }

  async function replaceSender(sender, track) {
    if (!sender || sender.track?.kind !== "audio" || !track) return false;
    remember(sender);
    await sender.replaceTrack(track);
    return true;
  }

  async function applyReplacement(track, status = "routed") {
    replacementTrack = track;
    const senders = [...peerConnections].flatMap((pc) => pc.getSenders?.() || []).filter((sender) => sender.track?.kind === "audio" || originalTracks.has(sender));
    const results = await Promise.allSettled(senders.map((sender) => replaceSender(sender, track)));
    const replaced = results.filter((result) => result.status === "fulfilled" && result.value).length;
    report(replaced ? status : "waiting-for-sender", String(replaced));
    return replaced;
  }

  function ensureSilenceTrack() {
    if (silenceTrack?.readyState === "live") return silenceTrack;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    silenceContext = new AudioContextClass();
    const oscillator = silenceContext.createOscillator();
    const gain = silenceContext.createGain();
    const destination = silenceContext.createMediaStreamDestination();
    gain.gain.value = 0;
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    silenceTrack = destination.stream.getAudioTracks()[0];
    return silenceTrack;
  }

  function releaseMix() {
    mixTrack?.stop();
    mixTrack = null;
    mixContext?.close().catch(() => {});
    mixContext = null;
  }

  // A sender carries a single track, so hearing both voices means mixing them into
  // one. Rebuilt on demand: it only changes when the user flips the control.
  function buildMixTrack(tracks) {
    releaseMix();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    mixContext = new AudioContextClass();
    const destination = mixContext.createMediaStreamDestination();
    for (const track of tracks) {
      mixContext.createMediaStreamSource(new MediaStream([track])).connect(destination);
    }
    mixContext.resume?.().catch(() => {});
    mixTrack = destination.stream.getAudioTracks()[0];
    return mixTrack;
  }

  // Fallback for sending the untranslated voice: hand the page's own microphone
  // track back. Conference apps often disable or end that track once it has been
  // replaced, so re-enable it and treat a dead one as unusable.
  async function applyOriginalTracks() {
    replacementTrack = null;
    const restores = [];
    for (const [sender, track] of originalTracks) {
      if (track.readyState !== "live") continue;
      track.enabled = true;
      restores.push(sender.replaceTrack(track));
    }
    await Promise.allSettled(restores);
    report(restores.length ? "original" : "waiting-for-sender", String(restores.length));
  }

  function liveOriginalTrack() {
    if (originalMicTrack?.readyState !== "live") return null;
    originalMicTrack.enabled = true;
    return originalMicTrack;
  }

  async function applyOutgoingMode() {
    if (!active) return;
    if (outgoingMode === "silence") return applyReplacement(ensureSilenceTrack());
    if (outgoingMode === "both") {
      const tracks = [liveOriginalTrack(), translatedTrack?.readyState === "live" ? translatedTrack : null].filter(Boolean);
      if (tracks.length > 1) return applyReplacement(buildMixTrack(tracks), "both");
      // Only one voice is available yet; send it alone rather than nothing.
      if (tracks.length === 1) return applyReplacement(tracks[0], tracks[0] === translatedTrack ? "routed" : "original");
      return applyReplacement(ensureSilenceTrack());
    }
    if (outgoingMode === "original") {
      // Prefer the extension's own live capture: it is known good, because the
      // interpreter is listening through it right now.
      const original = liveOriginalTrack();
      if (original) return applyReplacement(original, "original");
      return applyOriginalTracks();
    }
    if (!translatedTrack) return applyReplacement(ensureSilenceTrack());
    return applyReplacement(translatedTrack);
  }

  async function setOutgoingMode(mode) {
    outgoingMode = ["translated", "original", "both", "silence"].includes(mode) ? mode : "translated";
    await applyOutgoingMode();
  }

  async function activate() {
    active = true;
    translatedTrack = null;
    originalMicTrack = null;
    report("activating");
    await applyOutgoingMode();
  }

  function trackFromElement(elementId) {
    return document.getElementById(elementId)?.srcObject?.getAudioTracks?.()[0] || null;
  }

  async function useTranslatedTrack(elementId) {
    const track = trackFromElement(elementId);
    if (!track) throw new Error("TRANSLATED_AUDIO_TRACK_MISSING");
    translatedTrack = track;
    await applyOutgoingMode();
  }

  async function useOriginalTrack(elementId) {
    const track = trackFromElement(elementId);
    if (!track) throw new Error("ORIGINAL_AUDIO_TRACK_MISSING");
    originalMicTrack = track;
    if (outgoingMode === "original") await applyOutgoingMode();
  }

  async function deactivate() {
    active = false;
    replacementTrack = null;
    translatedTrack = null;
    originalMicTrack = null;
    outgoingMode = "translated";
    const restores = [];
    for (const [sender, track] of originalTracks) {
      if (track.readyState === "live") restores.push(sender.replaceTrack(track));
    }
    await Promise.allSettled(restores);
    originalTracks.clear();
    releaseMix();
    silenceTrack?.stop();
    silenceTrack = null;
    await silenceContext?.close().catch(() => {});
    silenceContext = null;
    report("restored");
  }

  const nativeAddTrack = NativePeerConnection.prototype.addTrack;
  NativePeerConnection.prototype.addTrack = function addTrack(track, ...streams) {
    const sender = nativeAddTrack.call(this, track, ...streams);
    peerConnections.add(this);
    remember(sender, track);
    if (active && replacementTrack && track?.kind === "audio") sender.replaceTrack(replacementTrack).catch((error) => report("error", error.message));
    return sender;
  };

  const nativeAddTransceiver = NativePeerConnection.prototype.addTransceiver;
  if (nativeAddTransceiver) {
    NativePeerConnection.prototype.addTransceiver = function addTransceiver(trackOrKind, init) {
      const transceiver = nativeAddTransceiver.call(this, trackOrKind, init);
      peerConnections.add(this);
      const original = typeof trackOrKind === "object" ? trackOrKind : transceiver.sender?.track;
      remember(transceiver.sender, original);
      if (active && replacementTrack && (trackOrKind === "audio" || original?.kind === "audio")) transceiver.sender.replaceTrack(replacementTrack).catch((error) => report("error", error.message));
      return transceiver;
    };
  }

  const nativeClose = NativePeerConnection.prototype.close;
  NativePeerConnection.prototype.close = function close() {
    peerConnections.delete(this);
    return nativeClose.call(this);
  };

  const WrappedPeerConnection = new Proxy(NativePeerConnection, {
    construct(Target, args, NewTarget) {
      const pc = Reflect.construct(Target, args, NewTarget === WrappedPeerConnection ? Target : NewTarget);
      peerConnections.add(pc);
      return pc;
    }
  });
  window.RTCPeerConnection = WrappedPeerConnection;
  if (window.webkitRTCPeerConnection === NativePeerConnection) window.webkitRTCPeerConnection = WrappedPeerConnection;

  window.addEventListener("live-voice:activate", () => activate().catch((error) => report("error", error.message)));
  window.addEventListener("live-voice:translated-track", (event) => useTranslatedTrack(event.detail?.elementId).catch((error) => report("error", error.message)));
  window.addEventListener("live-voice:original-track", (event) => useOriginalTrack(event.detail?.elementId).catch((error) => report("error", error.message)));
  window.addEventListener("live-voice:outgoing-mode", (event) => setOutgoingMode(event.detail?.mode).catch((error) => report("error", error.message)));
  window.addEventListener("live-voice:deactivate", () => deactivate().catch((error) => report("error", error.message)));
  window.__liveVoiceWebRtcBridge = { peerConnections, originalTracks };
  report("ready");
})();
