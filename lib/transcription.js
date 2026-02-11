const { spawn, execFileSync } = require("child_process");
const { createWavBuffer, calcRMS } = require("./audio");
const { getTwitchAudioUrl } = require("./twitch-hls");

// システムの ffmpeg を優先し、なければ ffmpeg-static にフォールバック
function resolveFfmpegPath() {
  try {
    return execFileSync("which", ["ffmpeg"], { encoding: "utf8" }).trim();
  } catch {}
  return require("ffmpeg-static").replace("app.asar", "app.asar.unpacked");
}
const ffmpegPath = resolveFfmpegPath();

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

const HALLUCINATION_BLACKLIST = new Set([
  "ご視聴ありがとうございました",
  "ご視聴ありがとうございます",
  "チャンネル登録よろしくお願いします",
  "チャンネル登録をお願いします",
  "見てくれてありがとう",
  "最後までご視聴いただきありがとうございました",
  "ご清聴ありがとうございました",
  "お疲れ様でした",
]);

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

  async start(channel) {
    if (this._proc) this.stop();

    console.log(`[Transcriber] Starting for channel: ${channel}`);

    let hlsUrl;
    try {
      hlsUrl = await getTwitchAudioUrl(channel);
      console.log(`[Transcriber] HLS URL obtained`);
    } catch (e) {
      console.error("HLS URL fetch error:", e.message);
      this._scheduleRetry(channel);
      return;
    }

    // Guard: stop() may have been called while awaiting
    if (this._proc) return;

    console.log(`[Transcriber] Spawning ffmpeg: ${ffmpegPath}`);
    const ffmpegProc = spawn(ffmpegPath, [
      "-i", hlsUrl,
      "-ac", "1",
      "-ar", "16000",
      "-f", "s16le",
      "-loglevel", "error",
      "pipe:1",
    ]);

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
        console.log("[Transcriber] Receiving audio data");
      }
      rawBuffer = Buffer.concat([rawBuffer, data]);
      while (rawBuffer.length >= FRAME_SIZE) {
        const frame = rawBuffer.subarray(0, FRAME_SIZE);
        rawBuffer = rawBuffer.subarray(FRAME_SIZE);
        processFrame(frame);
      }
    });

    ffmpegProc.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) console.error("ffmpeg:", msg);
    });

    ffmpegProc.on("error", (err) => {
      console.error("ffmpeg spawn error:", err.message);
      this._handleError(channel);
    });

    ffmpegProc.on("close", () => {
      this._handleError(channel);
    });

    this._proc = { ffmpeg: ffmpegProc, cleanup };
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
    try { this._proc.ffmpeg.kill(); } catch (e) {}
    this._proc = null;
  }

  _handleError(channel) {
    if (!this._proc) return;
    this._kill();
    this._scheduleRetry(channel);
  }

  _scheduleRetry(channel) {
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
        model: "gpt-4o-mini-transcribe",
        file,
      });
      const text = response.text.trim();
      if (text && !HALLUCINATION_BLACKLIST.has(text)) onResult(text);
    } catch (e) {
      console.error("Transcription error:", e.message);
    } finally {
      this._inFlight--;
      if (this._whisperQueue.length > 0) this._whisperQueue.shift()();
    }
  }
}

module.exports = { Transcriber };
