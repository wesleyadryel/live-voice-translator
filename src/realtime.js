const REALTIME_MODEL = "gpt-realtime-1.5";
const REALTIME_URL = `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(REALTIME_MODEL)}`;

export class RealtimeTranslator {
  constructor({ apiKey, inputStream, outputElement, monitorElement, from, to, voice, onState, onTranscript, onDisconnect, onOutputTrack, exchangeSdp, verbatim = false, manualChunkMs = 0 }) {
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
        if (event.type === "response.done") this.responseInProgress = false;
        if (event.type === "response.output_audio_transcript.delta" || event.type === "response.audio_transcript.delta") {
          this.transcriptBuffer += event.delta || "";
        }
        if (event.type === "response.output_audio_transcript.done" || event.type === "response.audio_transcript.done") {
          const transcript = (event.transcript || this.transcriptBuffer).trim();
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
          output_modalities: ["audio"],
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
            ? `Repeat every spoken utterance verbatim in ${this.from}. Output only the exact spoken words as speech. Never answer, summarize, or add commentary.`
            : [
                `Act only as a simultaneous interpreter from ${this.from} to ${this.to}.`,
                `Translate every spoken utterance naturally into ${this.to}.`,
                // The model hears the source audio, so it can mirror how something was
                // said, not just what was said. Without this it defaults to a flat,
                // uniform read that strips the speaker's intent.
                "Perform the translation the way the speaker delivered it: match their loudness, energy, speaking rate, and emotion.",
                "If they whisper, whisper; if they raise their voice, raise yours; if they sound hesitant, amused, urgent, or annoyed, carry that across.",
                "Keep their pauses, emphasis on particular words, and rising or falling intonation, including questions asked as statements.",
                "Reproduce stretched-out words, drawn-out vowels, interjections, exclamations, laughter and sighs with the same exaggeration: if they say \"nooooossa\", the translation is an equally stretched \"wooooow\", never a clipped, tidy one.",
                "Never flatten an expressive delivery into a neutral one, and never add expression the speaker did not have.",
                "Output only the translation as speech. Never answer questions or add commentary.",
                "Keep names, numbers, product terms, and tone accurate. Be concise to minimize latency."
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
