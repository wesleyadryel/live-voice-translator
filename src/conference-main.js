(() => {
  if (window.__liveVoiceWebRtcBridge) return;

  const NativePeerConnection = window.RTCPeerConnection;
  if (!NativePeerConnection) return;

  const peerConnections = new Set();
  const originalTracks = new Map();
  let active = false;
  let replacementTrack = null;
  let silenceContext = null;
  let silenceTrack = null;

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

  async function applyReplacement(track) {
    replacementTrack = track;
    const senders = [...peerConnections].flatMap((pc) => pc.getSenders?.() || []).filter((sender) => sender.track?.kind === "audio" || originalTracks.has(sender));
    const results = await Promise.allSettled(senders.map((sender) => replaceSender(sender, track)));
    const replaced = results.filter((result) => result.status === "fulfilled" && result.value).length;
    report(replaced ? "routed" : "waiting-for-sender", String(replaced));
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

  async function activate() {
    active = true;
    report("activating");
    await applyReplacement(ensureSilenceTrack());
  }

  async function useTranslatedTrack(elementId) {
    const element = document.getElementById(elementId);
    const track = element?.srcObject?.getAudioTracks?.()[0];
    if (!track) throw new Error("TRANSLATED_AUDIO_TRACK_MISSING");
    await applyReplacement(track);
  }

  async function deactivate() {
    active = false;
    replacementTrack = null;
    const restores = [];
    for (const [sender, track] of originalTracks) {
      if (track.readyState === "live") restores.push(sender.replaceTrack(track));
    }
    await Promise.allSettled(restores);
    originalTracks.clear();
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
  window.addEventListener("live-voice:deactivate", () => deactivate().catch((error) => report("error", error.message)));
  window.__liveVoiceWebRtcBridge = { peerConnections, originalTracks };
  report("ready");
})();
