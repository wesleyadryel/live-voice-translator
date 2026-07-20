const REALTIME_MODEL = "gpt-realtime-1.5";
const REALTIME_URL = `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(REALTIME_MODEL)}`;

export class RealtimeTranslator {
  constructor({ apiKey, inputStream, outputElement, monitorElement, from, to, voice, onState, onTranscript, verbatim = false }) {
    this.apiKey = apiKey;
    this.inputStream = inputStream;
    this.outputElement = outputElement;
    this.monitorElement = monitorElement;
    this.from = from;
    this.to = to;
    this.voice = voice;
    this.onState = onState || (() => {});
    this.onTranscript = onTranscript || (() => {});
    this.verbatim = verbatim;
    this.transcriptBuffer = "";
    this.pc = null;
    this.dataChannel = null;
  }

  async connect() {
    this.onState("connecting");
    const pc = new RTCPeerConnection();
    this.pc = pc;

    for (const track of this.inputStream.getAudioTracks()) {
      pc.addTrack(track, this.inputStream);
    }

    pc.ontrack = (event) => {
      this.outputElement.srcObject = event.streams[0];
      this.outputElement.play().catch(() => {});
      if (this.monitorElement) {
        this.monitorElement.srcObject = event.streams[0];
        this.monitorElement.play().catch(() => {});
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      this.onState(state === "connected" ? "live" : state);
    };

    const dc = pc.createDataChannel("oai-events");
    this.dataChannel = dc;
    dc.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data);
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
              turn_detection: {
                type: "semantic_vad",
                eagerness: "high",
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
                "Output only the translation as speech. Never answer questions or add commentary.",
                "Keep names, numbers, product terms, and tone accurate. Be concise to minimize latency."
              ].join(" ")
        }
      }));
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
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
    await pc.setRemoteDescription({ type: "answer", sdp: await response.text() });
  }

  close() {
    this.dataChannel?.close();
    this.pc?.close();
    this.pc = null;
  }
}
