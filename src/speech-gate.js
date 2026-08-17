// Realtime audio is billed for as long as it is streamed, not per translated
// phrase, and most of a meeting is silence on any given side. This watches a stream
// locally — nothing leaves the machine — so a direction can hold its session open
// only while someone is actually talking.
const SAMPLE_INTERVAL_MS = 100;

// Accepts either a stream or an analyser that already sits in the direction's audio
// graph. The analyser is preferred: building a second context around a stream that
// came out of the first one gives the two independent clocks, and the drift between
// them is heard as clicks in everything downstream.
export function createSpeechGate(input, { onSpeechStart, onSpeechEnd, threshold = 0.012, releaseMs = 900, workletUrl = "" } = {}) {
  const provided = typeof input?.getFloatTimeDomainData === "function" ? input : null;
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  const track = provided ? null : input?.getAudioTracks?.()[0];
  if (!provided && (!AudioContextClass || !track)) return { get speaking() { return true; }, close() {} };

  const context = provided ? null : new AudioContextClass();
  const source = context ? context.createMediaStreamSource(input) : null;
  const analyser = provided || context.createAnalyser();
  if (!provided) {
    analyser.fftSize = 512;
    source.connect(analyser);
    context.resume?.().catch(() => {});
  }

  const samples = new Float32Array(analyser.fftSize);
  let speaking = false;
  let lastLoudAt = 0;
  let timer = null;
  let closed = false;
  let worklet = null;

  function measure() {
    analyser.getFloatTimeDomainData(samples);
    let total = 0;
    for (const sample of samples) total += sample * sample;
    return Math.sqrt(total / samples.length);
  }

  function report(level) {
    if (closed) return;
    const now = Date.now();
    if (level >= threshold) lastLoudAt = now;
    // The release window keeps the session open across the natural pauses inside a
    // sentence, so speech is not chopped into separate reconnects.
    const next = now - lastLoudAt < releaseMs;
    if (next === speaking) return;
    speaking = next;
    try { (speaking ? onSpeechStart : onSpeechEnd)?.(); } catch {}
  }

  function tick() {
    if (closed) return;
    report(measure());
    timer = setTimeout(tick, SAMPLE_INTERVAL_MS);
  }

  // The audio thread is the only clock a hidden document cannot have slowed down, so
  // that is where the level is measured whenever the worklet can be loaded. The timer
  // stays as the fallback for contexts that cannot reach the module.
  async function useWorklet(url) {
    const graphContext = context || analyser.context;
    if (!graphContext?.audioWorklet) return false;
    try {
      await graphContext.audioWorklet.addModule(url);
      if (closed) return true;
      const node = new AudioWorkletNode(graphContext, "speech-gate", { numberOfInputs: 1, numberOfOutputs: 0 });
      node.port.onmessage = (event) => report(Number(event.data) || 0);
      analyser.connect(node);
      worklet = node;
      clearTimeout(timer);
      timer = null;
      return true;
    } catch {
      return false;
    }
  }

  tick();
  if (workletUrl) useWorklet(workletUrl).then((ok) => { if (!ok && !closed && !timer) tick(); });

  return {
    get speaking() { return speaking; },
    close() {
      closed = true;
      clearTimeout(timer);
      if (worklet) {
        worklet.port.onmessage = null;
        try { analyser.disconnect(worklet); } catch {}
        worklet = null;
      }
      // A borrowed analyser belongs to the audio stage, which closes its own context.
      if (!context) return;
      try { source.disconnect(); } catch {}
      context.close().catch(() => {});
    }
  };
}
