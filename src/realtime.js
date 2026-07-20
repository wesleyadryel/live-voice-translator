const REALTIME_URL = "https://api.openai.com/v1/realtime/calls";

export class RealtimeTranslator {
  constructor({ apiKey, inputStream, outputElement, from, to, voice, onState }) {
    this.apiKey = apiKey;
    this.inputStream = inputStream;
    this.outputElement = outputElement;
    this.from = from;
    this.to = to;
    this.voice = voice;
    this.onState = onState || (() => {});
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
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      this.onState(state === "connected" ? "live" : state);
    };

    const dc = pc.createDataChannel("oai-events");
    this.dataChannel = dc;
    dc.onopen = () => {
      dc.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          model: "gpt-realtime",
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
          instructions: [
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
