const REALTIME_MODEL = "gpt-realtime-1.5";
const REALTIME_URL = `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(REALTIME_MODEL)}`;

export class RealtimeTranslator {
  constructor({ apiKey, inputStream, outputElement, monitorElement, from, to, voice, onState, onTranscript, onDisconnect, onOutputTrack, onUsage, exchangeSdp, verbatim = false, manualChunkMs = 0 }) {
    this.apiKey = apiKey;
    this.inputStream = inputStream;
    this.outputElement = outputElement;
    this.monitorElement = monitorElement;
    this.from = from;
    this.to = to;
    this.voice = voice;
    this.onState = onState || (() => {});
    this.onTranscript = onTranscript || (() => {});
    this.onDisconnect = onDisconnect || (() => {});
    this.onOutputTrack = onOutputTrack || (() => {});
    this.onUsage = onUsage || (() => {});
    this.exchangeSdp = exchangeSdp || null;
    this.verbatim = verbatim;
    this.manualChunkMs = manualChunkMs;
    this.transcriptBuffer = "";
    this.pc = null;
    this.dataChannel = null;
    this.closedByUser = false;
    this.wasConnected = false;
    this.responseInProgress = false;
    this.chunkTimer = null;
  }

  async connect() {
    this.onState("connecting");
    this.closedByUser = false;
    const pc = new RTCPeerConnection();
    this.pc = pc;

    for (const track of this.inputStream.getAudioTracks()) {
      pc.addTrack(track, this.inputStream);
    }

    pc.ontrack = (event) => {
      this.outputElement.srcObject = event.streams[0];
      this.outputElement.play().catch(() => {});
      this.onOutputTrack(event.track, event.streams[0]);
      if (this.monitorElement) {
        this.monitorElement.srcObject = event.streams[0];
        this.monitorElement.play().catch(() => {});
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === "connected") this.wasConnected = true;
      this.onState(state === "connected" ? "live" : state);
      if (!this.closedByUser && this.wasConnected && ["disconnected", "failed"].includes(state)) {
        this.onDisconnect(state);
      }
    };

    const dc = pc.createDataChannel("oai-events");
    this.dataChannel = dc;
    dc.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data);
        if (event.type === "response.created") this.responseInProgress = true;
        if (event.type === "response.done") {
          this.responseInProgress = false;
          // The API reports what each response actually cost, split between audio
          // and text, which is the only trustworthy source for usage reporting.
          const usage = event.response?.usage;
          if (usage) {
            this.onUsage({
              inputTokens: Number(usage.input_tokens) || 0,
              outputTokens: Number(usage.output_tokens) || 0,
              inputAudioTokens: Number(usage.input_token_details?.audio_tokens) || 0,
              outputAudioTokens: Number(usage.output_token_details?.audio_tokens) || 0,
              cachedTokens: Number(usage.input_token_details?.cached_tokens) || 0
            });
          }
        }
        // A text-only response reports through the text events instead of the
        // audio-transcript ones, so both shapes have to be accepted.
        if (["response.output_audio_transcript.delta", "response.audio_transcript.delta", "response.output_text.delta", "response.text.delta"].includes(event.type)) {
          this.transcriptBuffer += event.delta || "";
        }
        if (["response.output_audio_transcript.done", "response.audio_transcript.done", "response.output_text.done", "response.text.done"].includes(event.type)) {
          // Audio events carry `transcript`, text events carry `text`.
          const transcript = (event.transcript || event.text || this.transcriptBuffer).trim();
          this.transcriptBuffer = "";
          if (transcript) this.onTranscript(transcript);
        }
      } catch {}
    };
    dc.onopen = () => {
      dc.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          model: REALTIME_MODEL,
          // The note-only modes never play the reply — the element is muted — so
          // asking for audio bought expensive output tokens and threw them away.
          output_modalities: this.verbatim ? ["text"] : ["audio"],
          audio: {
            input: {
              turn_detection: this.manualChunkMs ? null : {
                // "high" ends the turn at the first plausible gap, which clips
                // drawn-out or emphatic delivery mid-word and, with noise
                // suppression off, lets background sound trigger false turns that
                // interrupt the interpreter. "medium" waits for the phrase to land.
                type: "semantic_vad",
                eagerness: "medium",
                create_response: true,
                interrupt_response: true
              }
            },
            output: { voice: this.voice }
          },
          instructions: this.verbatim
            ? `Transcribe every spoken utterance verbatim in ${this.from}. Output only the exact spoken words as text. Never answer, summarize, translate, or add commentary.`
            // Auto-pause reopens the session often and these instructions are
            // resent every time, so they are kept tight — the same rules stated
            // once instead of restated from several angles.
            : [
                `Act only as a simultaneous interpreter from ${this.from} to ${this.to}. Output only the translation as speech, never answers or commentary.`,
                // The model hears the source audio, so it can mirror how something
                // was said. Without this it defaults to a flat, uniform read.
                "Mirror the speaker's delivery exactly: loudness, energy, pace, emotion, pauses, word stress and intonation.",
                "Whisper if they whisper, shout if they shout, and stretch drawn-out words and interjections just as far (\"nooooossa\" becomes an equally stretched \"wooooow\").",
                "Never flatten expressive speech into neutral speech, and never add expression they did not have.",
                "Keep names, numbers and product terms accurate. Be concise to minimize latency."
              ].join(" ")
        }
      }));
      if (this.manualChunkMs) {
        this.chunkTimer = setInterval(() => {
          if (this.dataChannel?.readyState !== "open" || this.responseInProgress) return;
          this.dataChannel.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          this.dataChannel.send(JSON.stringify({ type: "response.create" }));
        }, this.manualChunkMs);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    let answerSdp;
    if (this.exchangeSdp) {
      answerSdp = await this.exchangeSdp(offer.sdp);
    } else {
      const response = await fetch(REALTIME_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/sdp"
        },
        body: offer.sdp
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`OpenAI ${response.status}: ${detail.slice(0, 180)}`);
      }
      answerSdp = await response.text();
    }
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
  }

  close() {
    this.closedByUser = true;
    clearInterval(this.chunkTimer);
    this.chunkTimer = null;
    this.dataChannel?.close();
    this.pc?.close();
    this.pc = null;
  }
}
