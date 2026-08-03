export const DEFAULT_REALTIME_MODEL = "gpt-realtime-1.5";

const LANGUAGE_CODES = {
  English: "en",
  Spanish: "es",
  German: "de",
  French: "fr",
  Russian: "ru",
  "Brazilian Portuguese": "pt"
};

export const isRealtimeTranslateModel = (model) => /translate/i.test(String(model || ""));

export const languageCode = (language) => LANGUAGE_CODES[language] || String(language || "en").slice(0, 2).toLowerCase();

export const realtimeUrl = (model) => {
  const id = model || DEFAULT_REALTIME_MODEL;
  const path = isRealtimeTranslateModel(id) ? "translations/calls" : "calls";
  return `https://api.openai.com/v1/realtime/${path}?model=${encodeURIComponent(id)}`;
};

export class RealtimeTranslator {
  constructor({ apiKey, model, inputStream, outputElement, monitorElement, from, to, voice, onState, onTranscript, onDisconnect, onOutputTrack, onUsage, exchangeSdp, verbatim = false, manualChunkMs = 0 }) {
    this.model = model || DEFAULT_REALTIME_MODEL;
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
    this.transcriptFlushTimer = null;
  }

  sessionModel() {
    if (this.verbatim && isRealtimeTranslateModel(this.model)) return DEFAULT_REALTIME_MODEL;
    return this.model;
  }

  usesTranslateSession() {
    return !this.verbatim && isRealtimeTranslateModel(this.sessionModel());
  }

  flushTranscript() {
    clearTimeout(this.transcriptFlushTimer);
    this.transcriptFlushTimer = null;
    const transcript = this.transcriptBuffer.trim();
    this.transcriptBuffer = "";
    if (transcript) this.onTranscript(transcript);
  }

  scheduleTranscriptFlush() {
    clearTimeout(this.transcriptFlushTimer);
    this.transcriptFlushTimer = setTimeout(() => this.flushTranscript(), 900);
  }

  reportUsage(usage) {
    if (!usage) return;
    this.onUsage({
      model: this.sessionModel(),
      inputTokens: Number(usage.input_tokens) || 0,
      outputTokens: Number(usage.output_tokens) || 0,
      inputAudioTokens: Number(usage.input_token_details?.audio_tokens) || 0,
      outputAudioTokens: Number(usage.output_token_details?.audio_tokens) || 0,
      cachedTokens: Number(usage.input_token_details?.cached_tokens) || 0
    });
  }

  sessionUpdatePayload() {
    if (this.usesTranslateSession()) {
      return {
        type: "session.update",
        session: {
          audio: {
            output: { language: languageCode(this.to) }
          }
        }
      };
    }
    return {
      type: "session.update",
      session: {
        type: "realtime",
        model: this.sessionModel(),
        output_modalities: this.verbatim ? ["text"] : ["audio"],
        audio: {
          input: {
            turn_detection: this.manualChunkMs ? null : {
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
          : [
              `Act only as a simultaneous interpreter from ${this.from} to ${this.to}. Output only the translation as speech, never answers or commentary.`,
              "Mirror the speaker's delivery exactly: loudness, energy, pace, emotion, pauses, word stress and intonation.",
              "Whisper if they whisper, shout if they shout, and stretch drawn-out words and interjections just as far (\"nooooossa\" becomes an equally stretched \"wooooow\").",
              "Never flatten expressive speech into neutral speech, and never add expression they did not have.",
              "Keep names, numbers and product terms accurate. Be concise to minimize latency."
            ].join(" ")
      }
    };
  }

  handleEvent(event) {
    if (event.type === "response.created") this.responseInProgress = true;
    if (event.type === "response.done") {
      this.responseInProgress = false;
      this.reportUsage(event.response?.usage);
    }
    if (["response.output_audio_transcript.delta", "response.audio_transcript.delta", "response.output_text.delta", "response.text.delta", "session.output_transcript.delta"].includes(event.type)) {
      this.transcriptBuffer += event.delta || "";
      if (event.type === "session.output_transcript.delta") this.scheduleTranscriptFlush();
    }
    if (["response.output_audio_transcript.done", "response.audio_transcript.done", "response.output_text.done", "response.text.done", "session.output_transcript.done"].includes(event.type)) {
      if (event.transcript || event.text) this.transcriptBuffer = event.transcript || event.text;
      this.flushTranscript();
    }
  }

  async connect() {
    this.onState("connecting");
    this.closedByUser = false;
    const pc = new RTCPeerConnection();
    this.pc = pc;
    const model = this.sessionModel();

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
        this.handleEvent(JSON.parse(message.data));
      } catch {}
    };
    dc.onopen = () => {
      dc.send(JSON.stringify(this.sessionUpdatePayload()));
      if (this.manualChunkMs && !this.usesTranslateSession()) {
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
      const response = await fetch(realtimeUrl(model), {
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
    this.flushTranscript();
    this.dataChannel?.close();
    this.pc?.close();
    this.pc = null;
  }
}
