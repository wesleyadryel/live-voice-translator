// Realtime audio is billed for as long as it is streamed, not per translated
// phrase, and most of a meeting is silence on any given side. This watches a stream
// locally — nothing leaves the machine — so a direction can hold its session open
// only while someone is actually talking.
const SAMPLE_INTERVAL_MS = 100;

export function createSpeechGate(stream, { onSpeechStart, onSpeechEnd, threshold = 0.012, releaseMs = 900 } = {}) {
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  const track = stream?.getAudioTracks?.()[0];
  if (!AudioContextClass || !track) return { get speaking() { return true; }, close() {} };

  const context = new AudioContextClass();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  context.resume?.().catch(() => {});

  const samples = new Float32Array(analyser.fftSize);
  let speaking = false;
  let lastLoudAt = 0;
  let timer = null;
  let closed = false;

  function measure() {
    analyser.getFloatTimeDomainData(samples);
    let total = 0;
    for (const sample of samples) total += sample * sample;
    return Math.sqrt(total / samples.length);
  }

  function tick() {
    if (closed) return;
    const now = Date.now();
    if (measure() >= threshold) lastLoudAt = now;
    // The release window keeps the session open across the natural pauses inside a
    // sentence, so speech is not chopped into separate reconnects.
    const next = now - lastLoudAt < releaseMs;
    if (next !== speaking) {
      speaking = next;
      try { (speaking ? onSpeechStart : onSpeechEnd)?.(); } catch {}
    }
    timer = setTimeout(tick, SAMPLE_INTERVAL_MS);
  }

  tick();

  return {
    get speaking() { return speaking; },
    close() {
      closed = true;
      clearTimeout(timer);
      try { source.disconnect(); } catch {}
      context.close().catch(() => {});
    }
  };
}
