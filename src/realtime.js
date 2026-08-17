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

// The interpreter's own transcript is the translation it spoke, so an utterance the
// interpreter never voiced — a dropped response, silent dubbing, a session that died
// mid-turn — leaves no text behind at all. Asking the same session to transcribe what
// it hears keeps the words as they were actually said, on a path that does not depend
// on the translation succeeding. This is the model the API documents for live speech;
// the older ones are still accepted by the session but do not always produce anything.
export const SOURCE_TRANSCRIPTION_MODEL = "gpt-live-transcribe";

// 0 leaves the model's own semantic detector in charge: it ends a turn when the
// sentence sounds finished, which suits continuous speech. A speaker who leaves
// gaps between words gets cut mid-thought by that, so any value above 0 replaces it
// with a plain silence window — the one setting that states outright how long a
// pause may be before the phrase is considered over.
export const PAUSE_AUTO_MS = 0;
export const MIN_PAUSE_MS = 300;
export const MAX_PAUSE_MS = 3000;

export function clampPauseMs(value) {
  const ms = Math.round(Number(value));
  // Only 0 means automatic. Anything the user actually dialled in is honoured as a
  // window, raised to the shortest one worth having rather than falling back to a
  // detector they were trying to get away from.
  if (!Number.isFinite(ms) || ms <= 0) return PAUSE_AUTO_MS;
  return Math.min(MAX_PAUSE_MS, Math.max(MIN_PAUSE_MS, ms));
}

export const languageCode = (language) => LANGUAGE_CODES[language] || String(language || "en").slice(0, 2).toLowerCase();

export const realtimeUrl = (model) => {
  const id = model || DEFAULT_REALTIME_MODEL;
  const path = isRealtimeTranslateModel(id) ? "translations/calls" : "calls";
  return `https://api.openai.com/v1/realtime/${path}?model=${encodeURIComponent(id)}`;
};

export class RealtimeTranslator {
  constructor({ apiKey, model, inputStream, outputElement, monitorElement, from, to, voice, onState, onTranscript, onSourceTranscript, onSourcePartial, onDisconnect, onOutputTrack, onUsage, exchangeSdp, verbatim = false, sourceTranscript = false, manualChunkMs = 0, pauseMs = PAUSE_AUTO_MS }) {
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
    this.onSourceTranscript = onSourceTranscript || (() => {});
    this.onSourcePartial = onSourcePartial || (() => {});
    this.onDisconnect = onDisconnect || (() => {});
    this.onOutputTrack = onOutputTrack || (() => {});
    this.onUsage = onUsage || (() => {});
    this.exchangeSdp = exchangeSdp || null;
    this.verbatim = verbatim;
    this.sourceTranscript = sourceTranscript;
    this.manualChunkMs = manualChunkMs;
    this.pauseMs = clampPauseMs(pauseMs);
    this.transcriptBuffer = "";
    this.sourceBuffer = "";
    this.sourceFlushTimer = null;
    this.pc = null;
    this.dataChannel = null;
    this.closedByUser = false;
    this.streaming = true;
    this.wasConnected = false;
    this.responseInProgress = false;
    this.chunkTimer = null;
    this.transcriptFlushTimer = null;
    // Which transcription variant has been asked for. -1 is "none yet"; the session
    // answers every update with its effective configuration, so the next one is only
    // sent once the previous has been seen to come back missing.
    this.transcriptionModel = SOURCE_TRANSCRIPTION_MODEL;
    this.transcriptionRequested = -1;
    this.transcriptionConfirmed = false;
    this.transcriptionGaveUp = false;
    // Every session.update is answered by one session.updated, and the answer to the
    // last one is the only one that describes the whole configuration. Counting both
    // keeps an early answer from being read as a refusal of a later request.
    this.sessionUpdatesSent = 0;
    this.sessionUpdatesSeen = 0;
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

  // The spoken words have their own buffer because they arrive on their own stream of
  // deltas, alongside and independent of the translation being spoken back.
  flushSource() {
    clearTimeout(this.sourceFlushTimer);
    this.sourceFlushTimer = null;
    const spoken = this.sourceBuffer.trim();
    this.sourceBuffer = "";
    if (spoken) this.onSourceTranscript(spoken);
  }

  scheduleSourceFlush() {
    clearTimeout(this.sourceFlushTimer);
    this.sourceFlushTimer = setTimeout(() => this.flushSource(), 900);
  }

  reportUsage(usage, model = this.sessionModel()) {
    if (!usage) return;
    this.onUsage({
      model,
      inputTokens: Number(usage.input_tokens) || 0,
      outputTokens: Number(usage.output_tokens) || 0,
      inputAudioTokens: Number(usage.input_token_details?.audio_tokens) || 0,
      outputAudioTokens: Number(usage.output_token_details?.audio_tokens) || 0,
      cachedTokens: Number(usage.input_token_details?.cached_tokens) || 0
    });
  }

  turnDetection() {
    if (this.manualChunkMs) return null;
    // A fixed silence window: the turn only ends after this much quiet, so a speaker
    // who pauses between words keeps the floor instead of having the phrase closed
    // and translated in halves. prefix_padding keeps the attack of the first word,
    // which is otherwise clipped off the front of the utterance.
    if (this.pauseMs) {
      return {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: this.pauseMs,
        create_response: true,
        interrupt_response: true
      };
    }
    return {
      type: "semantic_vad",
      eagerness: "medium",
      create_response: true,
      interrupt_response: true
    };
  }

  // Turn detection can be replaced on a live session, so the setting takes effect on
  // the call being complained about rather than the next one.
  setPauseMs(value) {
    const next = clampPauseMs(value);
    if (next === this.pauseMs) return;
    this.pauseMs = next;
    if (this.dataChannel?.readyState !== "open" || this.usesTranslateSession()) return;
    this.sessionUpdatesSent += 1;
    this.dataChannel.send(JSON.stringify(this.sessionUpdatePayload()));
  }

  // A realtime session takes only the model here: `language` belongs to a dedicated
  // transcription session and is refused outright as an unknown parameter. Sessions
  // also differ in which models they take, and some drop the field silently instead of
  // refusing it, so the request is a ladder ending at the model every session has
  // always accepted.
  transcriptionVariants() {
    return [
      { model: SOURCE_TRANSCRIPTION_MODEL },
      { model: "gpt-4o-mini-transcribe" },
      { model: "whisper-1" }
    ];
  }

  // A verbatim session already outputs the spoken words as text, so asking for input
  // transcription there would buy the same sentence twice.
  inputTranscription(attempt = Math.max(0, this.transcriptionRequested)) {
    if (!this.sourceTranscript || this.verbatim) return null;
    return this.transcriptionVariants()[attempt] || null;
  }

  // An update naming audio.input replaces that whole block rather than merging into
  // it, so a message carrying only the transcription takes turn detection down with
  // it — and an utterance that is never closed is never transcribed. A realtime
  // session therefore asks for transcription only as part of its full configuration.
  requestTranscription(attempt) {
    const transcription = this.inputTranscription(attempt);
    if (!transcription || this.dataChannel?.readyState !== "open") return false;
    this.transcriptionRequested = attempt;
    this.sessionUpdatesSent += 1;
    this.dataChannel.send(JSON.stringify(this.usesTranslateSession()
      // A translate session configures no input block of its own, so there is nothing
      // for this to overwrite.
      ? { type: "session.update", session: { audio: { input: { transcription } } } }
      : this.sessionUpdatePayload()));
    return true;
  }

  // Down a rung, or out of rungs. A refusal is reported as an error event and a silent
  // drop as a config that comes back without the field; both mean the same thing here.
  escalateTranscription() {
    if (!this.requestTranscription(this.transcriptionRequested + 1)) {
      this.transcriptionGaveUp = true;
      console.warn("[LiveVoice] this session refuses input transcription; the spoken column stays empty");
    }
  }

  // Called with the session's own account of what it applied. Anything missing means
  // the field was dropped, not that the words were silent.
  reviewTranscription(session) {
    if (!this.sourceTranscript || this.verbatim || this.transcriptionGaveUp) return;
    const effective = session?.audio?.input?.transcription;
    if (effective) {
      // The whole input config, because turn detection decides whether an utterance is
      // ever closed — and a transcript only exists once one is.
      if (!this.transcriptionConfirmed) console.info("[LiveVoice] input transcription on", JSON.stringify(session?.audio?.input || {}));
      this.transcriptionConfirmed = true;
      // Billed to whichever rung the session settled on, not to the one first asked for.
      this.transcriptionModel = effective.model || this.transcriptionModel;
      return;
    }
    if (this.transcriptionConfirmed || this.transcriptionRequested < 0) return;
    console.warn("[LiveVoice] input transcription not accepted", JSON.stringify(session?.audio?.input || {}));
    this.escalateTranscription();
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
            // Both in the same message, always: they live in one block that is replaced
            // as a whole, and transcription without turn detection transcribes nothing.
            ...(this.inputTranscription() ? { transcription: this.inputTranscription() } : {}),
            turn_detection: this.turnDetection()
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
    // A rejected session.update arrives as an ordinary event and changes nothing else:
    // without this the feature would simply stay silent with no way to tell why.
    if (event.type === "error") {
      const message = String(event.error?.message || "");
      console.warn("[LiveVoice] realtime error", message || event.error || event);
      // A refused update produces no session.updated, so the ladder would stall here
      // waiting for an answer that is never coming. This is that answer.
      if (/transcription/i.test(message) && !this.transcriptionConfirmed && !this.transcriptionGaveUp && this.transcriptionRequested >= 0) {
        this.sessionUpdatesSeen += 1;
        this.escalateTranscription();
      }
    }
    // What the session actually accepted, which is the only proof that input
    // transcription is on rather than merely requested.
    if (event.type === "session.updated") {
      this.sessionUpdatesSeen += 1;
      if (this.sessionUpdatesSeen >= this.sessionUpdatesSent) this.reviewTranscription(event.session);
    }
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
    // A transcription that fails arrives on its own event rather than as a plain
    // error, so it is the one place a silent spoken column can be explained.
    if (event.type === "conversation.item.input_audio_transcription.failed") {
      console.warn("[LiveVoice] input transcription failed", event.error?.message || event.error || event);
    }
    // What the speaker actually said, delivered per finished utterance rather than as
    // deltas: this line exists to be a record, not a live caption, and the completed
    // event already carries the whole sentence. A failed transcription is left silent
    // — the translation is still on its way and a warning in the transcript would only
    // sit where the missing words should be.
    // A translate session names the same thing differently and streams it: the words
    // being interpreted arrive as deltas next to the translation, with no conversation
    // item behind them. Buffered like the output transcript, flushed on the same quiet
    // window when no explicit end arrives.
    if (event.type === "session.input_transcript.delta") {
      this.sourceBuffer += event.delta || "";
      // Shown while it is still being said. Waiting for the whole utterance is right
      // for the record and wrong for reading along, so the partial goes out too and
      // the finished line replaces it.
      this.onSourcePartial(this.sourceBuffer);
      this.scheduleSourceFlush();
    }
    if (["session.input_transcript.done", "session.input_transcript.completed"].includes(event.type)) {
      if (event.transcript || event.text) this.sourceBuffer = event.transcript || event.text;
      this.flushSource();
    }
    if (["conversation.item.input_audio_transcription.completed", "conversation.item.input_audio_transcription.done"].includes(event.type)) {
      const spoken = String(event.transcript || event.text || "").trim();
      if (spoken) this.onSourceTranscript(spoken);
      // Transcription is billed apart from the interpreter's own turns, so it is
      // counted here too instead of quietly widening the session's real cost.
      this.reportUsage(event.usage, this.transcriptionModel);
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
      this.sessionUpdatesSent += 1;
      dc.send(JSON.stringify(this.sessionUpdatePayload()));
      // The payload just sent already carries the first rung; a translate session
      // configures no input block, so there it goes as its own message.
      if (this.usesTranslateSession()) this.requestTranscription(0);
      else if (this.inputTranscription()) this.transcriptionRequested = 0;
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

  // Parking without hanging up. The sender keeps its place in the session and simply
  // stops carrying audio: no packets leave, so nothing is streamed and nothing is
  // billed, and coming back is a track swap instead of a new call — which is the
  // difference between translating the first sentence after a pause and losing it to
  // a handshake.
  setStreaming(enabled) {
    if (this.streaming === enabled || !this.pc) return;
    this.streaming = enabled;
    const [track] = this.inputStream?.getAudioTracks?.() || [];
    for (const sender of this.pc.getSenders?.() || []) {
      if (sender.track?.kind === "audio" || (!sender.track && enabled)) {
        sender.replaceTrack(enabled ? track || null : null).catch(() => {});
      }
    }
  }

  close() {
    this.closedByUser = true;
    clearInterval(this.chunkTimer);
    this.chunkTimer = null;
    this.flushTranscript();
    this.flushSource();
    this.dataChannel?.close();
    this.pc?.close();
    this.pc = null;
  }
}
