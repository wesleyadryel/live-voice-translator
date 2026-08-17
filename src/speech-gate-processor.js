// The speech gate measured on the audio thread. A hidden document — which is what an
// offscreen document always is — has its timers slowed to one tick per second, and to
// one per minute after a few minutes without audible playback. A parked side plays
// nothing, so exactly when the gate is needed to notice speech and wake the session,
// its clock is at its slowest: whole sentences go by before anything is streamed.
// Nothing throttles this thread, and the messages it posts are not timer callbacks.
const WINDOW_SECONDS = 0.05;

class SpeechGateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.squares = 0;
    this.frames = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      for (const sample of channel) this.squares += sample * sample;
      this.frames += channel.length;
    } else {
      // A disconnected input still has to advance the window, or a side that went
      // quiet by losing its track would never report the silence.
      this.frames += 128;
    }
    if (this.frames >= sampleRate * WINDOW_SECONDS) {
      this.port.postMessage(Math.sqrt(this.squares / this.frames));
      this.squares = 0;
      this.frames = 0;
    }
    return true;
  }
}

registerProcessor("speech-gate", SpeechGateProcessor);
