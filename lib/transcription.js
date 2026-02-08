const { spawn } = require("child_process");
const { createWavBuffer, calcRMS } = require("./audio");

// VAD (Voice Activity Detection) Configuration
const VAD_SPEECH_THRESHOLD = 300;
const VAD_SPEECH_ONSET_FRAMES = 3;
const VAD_SILENCE_DURATION_MS = 800;
const FRAME_DURATION_MS = 50;
const FRAME_SIZE = 16000 * 2 * (FRAME_DURATION_MS / 1000);
const VAD_SILENCE_FRAMES = Math.ceil(VAD_SILENCE_DURATION_MS / FRAME_DURATION_MS);
const MIN_CHUNK_BYTES = 16000 * 2 * 1;  // 1 second
const MAX_CHUNK_BYTES = 16000 * 2 * 15; // 15 seconds
const PRE_ROLL_BYTES = 16000 * 2 * (200 / 1000); // 200ms
const DEBOUNCE_DELAY_MS = 1500;
const MAX_CONCURRENT_WHISPER = 2;
const MAX_RETRIES = 5;

class Transcriber {
  constructor(openai, callbacks) {
    this._openai = openai;
    this._onTranscription = callbacks.onTranscription;
    this._onStopped = callbacks.onStopped || (() => {});
    this._proc = null;
    this._retryCount = 0;
    this._retryTimer = null;
    this._inFlight = 0;
    this._whisperQueue = [];
  }

  start(channel) {
    if (this._proc) this.stop();

    const url = `https://www.twitch.tv/${channel}`;
    const streamlinkProc = spawn("streamlink", [url, "audio_only", "-O"]);
    const ffmpegProc = spawn("ffmpeg", [
      "-i", "pipe:0",
      "-ac", "1",
      "-ar", "16000",
      "-f", "s16le",
      "-loglevel", "error",
      "pipe:1",
    ]);

    streamlinkProc.stdout.pipe(ffmpegProc.stdin);

    // VAD state (per-session)
    let dataReceived = false;
    let rawBuffer = Buffer.alloc(0);
    let speechBuffer = Buffer.alloc(0);
    let preRollBuffer = Buffer.alloc(0);
    let vadState = "idle";
    let speechOnsetCount = 0;
    let silenceFrameCount = 0;

    // Debounce state
    let pendingTexts = [];
    let debounceTimer = null;

    const flushPendingTexts = () => {
      debounceTimer = null;
      if (pendingTexts.length === 0) return;
      const combinedText = pendingTexts.join(" ");
      pendingTexts = [];
      this._onTranscription(combinedText);
    };

    const onResult = (text) => {
      pendingTexts.push(text);
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flushPendingTexts, DEBOUNCE_DELAY_MS);
    };

    const finalizeChunk = () => {
      if (speechBuffer.length >= MIN_CHUNK_BYTES) {
        this._transcribeChunk(speechBuffer, onResult);
      }
      speechBuffer = Buffer.alloc(0);
      silenceFrameCount = 0;
      speechOnsetCount = 0;
      vadState = "idle";
    };

    const processFrame = (frame) => {
      const rms = calcRMS(frame);
      const isSpeech = rms >= VAD_SPEECH_THRESHOLD;

      if (vadState === "idle") {
        preRollBuffer = Buffer.concat([preRollBuffer, frame]);
        if (preRollBuffer.length > PRE_ROLL_BYTES) {
          preRollBuffer = preRollBuffer.subarray(preRollBuffer.length - PRE_ROLL_BYTES);
        }

        if (isSpeech) {
          speechOnsetCount++;
          if (speechOnsetCount >= VAD_SPEECH_ONSET_FRAMES) {
            vadState = "speaking";
            speechBuffer = Buffer.from(preRollBuffer);
            preRollBuffer = Buffer.alloc(0);
            silenceFrameCount = 0;
          }
        } else {
          speechOnsetCount = 0;
        }
      } else {
        speechBuffer = Buffer.concat([speechBuffer, frame]);

        if (isSpeech) {
          silenceFrameCount = 0;
        } else {
          silenceFrameCount++;
          if (silenceFrameCount >= VAD_SILENCE_FRAMES) {
            finalizeChunk();
            return;
          }
        }

        if (speechBuffer.length >= MAX_CHUNK_BYTES) {
          this._transcribeChunk(Buffer.from(speechBuffer), onResult);
          speechBuffer = Buffer.alloc(0);
          silenceFrameCount = 0;
        }
      }
    };

    const cleanup = () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      flushPendingTexts();
    };

    ffmpegProc.stdout.on("data", (data) => {
      if (!dataReceived) {
        dataReceived = true;
        this._retryCount = 0;
      }
      rawBuffer = Buffer.concat([rawBuffer, data]);
      while (rawBuffer.length >= FRAME_SIZE) {
        const frame = rawBuffer.subarray(0, FRAME_SIZE);
        rawBuffer = rawBuffer.subarray(FRAME_SIZE);
        processFrame(frame);
      }
    });

    streamlinkProc.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) console.error("streamlink:", msg);
    });

    ffmpegProc.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) console.error("ffmpeg:", msg);
    });

    streamlinkProc.on("error", (err) => {
      console.error("streamlink spawn error:", err.message);
      this._handleError(channel);
    });

    ffmpegProc.on("error", (err) => {
      console.error("ffmpeg spawn error:", err.message);
      this._handleError(channel);
    });

    streamlinkProc.on("close", () => {
      this._handleError(channel);
    });

    this._proc = { streamlink: streamlinkProc, ffmpeg: ffmpegProc, cleanup };
  }

  stop() {
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    this._retryCount = 0;
    this._kill();
  }

  _kill() {
    if (!this._proc) return;
    if (this._proc.cleanup) this._proc.cleanup();
    try { this._proc.streamlink.kill(); } catch (e) {}
    try { this._proc.ffmpeg.kill(); } catch (e) {}
    this._proc = null;
  }

  _handleError(channel) {
    if (!this._proc) return;
    this._kill();
    if (this._retryCount < MAX_RETRIES) {
      const delay = Math.min(1000 * Math.pow(2, this._retryCount), 30000);
      this._retryCount++;
      console.log(`Retrying transcription in ${delay}ms (attempt ${this._retryCount}/${MAX_RETRIES})`);
      this._retryTimer = setTimeout(() => this.start(channel), delay);
    } else {
      this._retryCount = 0;
      console.error("Transcription max retries exceeded");
      this._onStopped();
    }
  }

  async _transcribeChunk(pcmChunk, onResult) {
    if (this._inFlight >= MAX_CONCURRENT_WHISPER) {
      await new Promise((resolve) => this._whisperQueue.push(resolve));
    }
    this._inFlight++;
    try {
      const wavBuffer = createWavBuffer(pcmChunk);
      const file = new File([wavBuffer], "audio.wav", { type: "audio/wav" });
      const response = await this._openai.audio.transcriptions.create({
        model: "whisper-1",
        file,
        prompt: "配信中のライブ実況です。ゲーム配信、雑談配信などの会話が続いています。",
      });
      const text = response.text.trim();
      if (text) onResult(text);
    } catch (e) {
      console.error("Transcription error:", e.message);
    } finally {
      this._inFlight--;
      if (this._whisperQueue.length > 0) this._whisperQueue.shift()();
    }
  }
}

module.exports = { Transcriber };
