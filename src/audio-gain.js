// A side whose microphone is set wrong at its source arrives wrong at the
// interpreter too, and a realtime model only transcribes what it can actually hear.
// Automatic gain control is deliberately off at capture time — it flattens the
// delivery the interpreter is asked to mirror — so the level is corrected here
// instead, as one explicit stage the user controls in both directions. The nodes
// stay in the graph for the whole session, so moving the slider changes the live
// audio without a reconnect.
//
// This is also the only audio context a direction gets. Everything that listens to
// that side — the interpreter, the speech gate, the untranslated voice you hear —
// hangs off this one graph. Chaining a second context onto a stream produced by the
// first one gives each of them an independent clock, and the drift between them is
// heard as clicks and dropouts, which is exactly the audio a realtime session
// cannot segment into phrases.
// 1 is the untouched signal: below it the side is attenuated, above it boosted.
// A microphone that was set too loud at its source clips before the interpreter
// ever hears it, so turning a side down is as necessary as lifting it.
export const MIN_GAIN = 0.1;
export const UNITY_GAIN = 1;
export const MAX_GAIN = 8;

// Speech that is hard to make out is rarely fixed by volume alone. These three
// shape the band the words actually live in: rumble and hum below it, the
// consonants that carry intelligibility inside it, hiss and interference above it.
// Every one of them defaults to a value that does nothing, so an untouched call
// sounds exactly as it did before.
export const LOW_CUT_OFF = 0;
export const MAX_LOW_CUT = 300;
export const CLARITY_OFF = 0;
export const MAX_CLARITY = 12;
export const HIGH_CUT_OFF = 20000;
export const MIN_HIGH_CUT = 3000;

// Consonants — the sounds that separate "pé" from "sé" — sit around here, and they
// are the first thing lost to a bad line. The band is wide enough to lift them
// without turning the voice thin.
const CLARITY_FREQUENCY = 2800;
const CLARITY_Q = 1.2;

function clampRange(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function clampGain(value) { return clampRange(value, MIN_GAIN, MAX_GAIN, UNITY_GAIN); }
export function clampLowCut(value) { return clampRange(value, LOW_CUT_OFF, MAX_LOW_CUT, LOW_CUT_OFF); }
export function clampClarity(value) { return clampRange(value, CLARITY_OFF, MAX_CLARITY, CLARITY_OFF); }
export function clampHighCut(value) { return clampRange(value, MIN_HIGH_CUT, HIGH_CUT_OFF, HIGH_CUT_OFF); }

function captureSampleRate(track) {
  const rate = Number(track.getSettings?.().sampleRate);
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

// Used when there is nothing to build a graph with: the untouched stream is still
// the correct input, so no caller has to special-case a missing stage.
function passiveStage(stream) {
  return { stream, analyser: null, setTuning() {}, setSinkId() {}, setPassthrough() {}, close() {} };
}

export function createAudioStage(stream, tuning = {}) {
  const { deviceId = "default" } = tuning;
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  const track = stream?.getAudioTracks?.()[0];
  if (!AudioContextClass || !track) return passiveStage(stream);

  // A context running at a different rate than the capture makes every buffer go
  // through a sample-rate conversion on the way in. Tab capture is 48 kHz while the
  // default context follows the output device, so a 44.1 kHz headset put a resampler
  // in the path of the participant's voice — heard as crackle, and enough to stall
  // the transcription. Matching the capture rate removes the conversion entirely.
  const rate = captureSampleRate(track);
  const context = new AudioContextClass(rate ? { sampleRate: rate, latencyHint: "interactive" } : { latencyHint: "interactive" });
  const source = context.createMediaStreamSource(stream);
  // Filters sit before the gain so the boost lifts the voice that is left, not the
  // rumble and hiss that were about to be removed anyway.
  const lowCut = context.createBiquadFilter();
  lowCut.type = "highpass";
  const clarity = context.createBiquadFilter();
  clarity.type = "peaking";
  clarity.frequency.value = CLARITY_FREQUENCY;
  clarity.Q.value = CLARITY_Q;
  const highCut = context.createBiquadFilter();
  highCut.type = "lowpass";
  const gainNode = context.createGain();
  // A boost pushes peaks past full scale, where they would be clipped into
  // distortion the model then has to transcribe. The limiter only guards that case:
  // at or below 1 nothing can clip, so its threshold sits at full scale where it can
  // never engage, and the signal passes through untouched.
  const limiter = context.createDynamicsCompressor();
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  const destination = context.createMediaStreamDestination();
  // The speech gate reads its level here rather than from its own context, so
  // parking and unparking follow the same audio the interpreter is given.
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;

  let currentGain = UNITY_GAIN;
  let passthrough = false;
  let sink = "";

  source.connect(lowCut);
  lowCut.connect(clarity);
  clarity.connect(highCut);
  highCut.connect(gainNode);
  gainNode.connect(limiter);
  limiter.connect(destination);
  limiter.connect(analyser);
  context.resume?.().catch(() => {});

  function ramp(param, value, immediate) {
    // Ramped rather than assigned: an instant change is heard as a click. The one
    // exception is the initial setup, where there is no audio flowing yet to click.
    if (immediate) {
      param.value = value;
      return;
    }
    try { param.setTargetAtTime(value, context.currentTime, 0.05); }
    catch { param.value = value; }
  }

  // Each control is applied only when it is actually given, so a partial update —
  // one slider moving — never resets the rest of the direction to its defaults.
  function applyTuning({ gain, lowCutHz, clarityDb, highCutHz }, immediate = false) {
    if (gain !== undefined) {
      currentGain = clampGain(gain);
      ramp(gainNode.gain, currentGain, immediate);
      ramp(limiter.threshold, currentGain > UNITY_GAIN ? -2 : 0, immediate);
    }
    // A highpass at 10 Hz is below anything a microphone captures, so "off" stays a
    // real position on the slider without having to rewire the graph.
    if (lowCutHz !== undefined) ramp(lowCut.frequency, Math.max(10, clampLowCut(lowCutHz)), immediate);
    if (clarityDb !== undefined) ramp(clarity.gain, clampClarity(clarityDb), immediate);
    if (highCutHz !== undefined) ramp(highCut.frequency, clampHighCut(highCutHz), immediate);
  }

  applyTuning({
    gain: tuning.gain ?? UNITY_GAIN,
    lowCutHz: tuning.lowCutHz ?? LOW_CUT_OFF,
    clarityDb: tuning.clarityDb ?? CLARITY_OFF,
    highCutHz: tuning.highCutHz ?? HIGH_CUT_OFF
  }, true);

  return {
    stream: destination.stream,
    analyser,
    setTuning(values) { applyTuning(values || {}); },
    setSinkId(nextDeviceId) {
      const next = !nextDeviceId || nextDeviceId === "default" ? "" : nextDeviceId;
      if (next === sink || !("setSinkId" in context)) return;
      sink = next;
      context.setSinkId(next).catch(() => {});
    },
    // Tab capture and the WebRTC bridge both divert audio away from its normal path,
    // so this side's untranslated voice is only audible while it is connected here.
    setPassthrough(enabled) {
      if (Boolean(enabled) === passthrough) return;
      passthrough = Boolean(enabled);
      if (passthrough) {
        limiter.connect(context.destination);
        context.resume?.().catch(() => {});
        return;
      }
      try { limiter.disconnect(context.destination); } catch {}
    },
    close() {
      try {
        for (const node of [source, lowCut, clarity, highCut, gainNode, limiter]) node.disconnect();
      } catch {}
      context.close().catch(() => {});
    }
  };
}
