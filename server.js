require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const tmi = require("tmi.js");
const Database = require("better-sqlite3");
const { GoogleGenAI } = require("@google/genai");
const OpenAI = require("openai");
const { spawn } = require("child_process");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Gemini AI setup
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// OpenAI Whisper setup
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// SQLite setup
const db = new Database(path.join(__dirname, "data.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS channels (
    name TEXT PRIMARY KEY,
    last_connected_at TEXT NOT NULL
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    username TEXT NOT NULL,
    message TEXT NOT NULL,
    timestamp TEXT NOT NULL
  )
`);

const upsertChannel = db.prepare(`
  INSERT INTO channels (name, last_connected_at) VALUES (?, ?)
  ON CONFLICT(name) DO UPDATE SET last_connected_at = excluded.last_connected_at
`);
const getChannels = db.prepare(
  `SELECT name FROM channels ORDER BY last_connected_at DESC`
);
db.exec(`
  CREATE TABLE IF NOT EXISTS transcriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    message TEXT NOT NULL,
    timestamp TEXT NOT NULL
  )
`);

const insertMessage = db.prepare(
  `INSERT INTO messages (channel, username, message, timestamp) VALUES (?, ?, ?, ?)`
);
const getRecentMessages = db.prepare(
  `SELECT username, message FROM messages WHERE channel = ? AND timestamp > ? ORDER BY id DESC LIMIT 20`
);
const insertTranscription = db.prepare(
  `INSERT INTO transcriptions (channel, message, timestamp) VALUES (?, ?, ?)`
);
const getRecentTranscriptions = db.prepare(
  `SELECT message FROM transcriptions WHERE channel = ? AND timestamp > ? ORDER BY id DESC LIMIT 10`
);

// Translation
const SYSTEM_INSTRUCTION = `あなたはTwitchチャットの翻訳者です。

ルール:
- 翻訳不要なもの（エモート、スタンプ、万国共通の短い語、URLのみ等）は「SKIP」と返してください
- メッセージが日本語の場合、英語に翻訳してください
- それ以外は自然な日本語に翻訳してください
- 会話の文脈を考慮して翻訳してください
- 翻訳文のみを返してください。説明や注釈は不要です`;

async function translateIfNeeded(msgData) {
  try {
    const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
    const recentTranscriptions = getRecentTranscriptions.all(msgData.channel, fiveMinAgo).reverse();
    const recent = getRecentMessages.all(msgData.channel, fiveMinAgo).reverse();
    let context = "";
    if (recentTranscriptions.length > 0) {
      context +=
        "配信者の最近の発言:\n" +
        recentTranscriptions.map((t) => `配信者: ${t.message}`).join("\n") +
        "\n\n";
    }
    if (recent.length > 0) {
      context +=
        "最近のチャット:\n" +
        recent.map((m) => `${m.username}: ${m.message}`).join("\n") +
        "\n\n";
    }

    const prompt = `${context}翻訳対象メッセージ (${msgData.username}): ${msgData.message}`;

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        thinkingConfig: { thinkingLevel: "minimal" },
      },
    });

    const translation = response.text.trim();
    if (translation && translation !== "SKIP") {
      io.emit("chat-translation", {
        id: msgData.id,
        translation,
      });
    }
  } catch (e) {
    console.error("Translation error:", e.message);
  }
}

const TRANSCRIPTION_SYSTEM_INSTRUCTION = `あなたはTwitch配信者の発言の翻訳者です。

ルール:
- 発言が日本語の場合、英語に翻訳してください
- それ以外は自然な日本語に翻訳してください
- 会話の文脈を考慮して翻訳してください
- 翻訳文のみを返してください。説明や注釈は不要です`;

let transcriptionId = 0;

async function translateTranscription(id, text) {
  try {
    let context = "";
    if (currentChannel) {
      const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
      const recentTrans = getRecentTranscriptions.all(currentChannel, fiveMinAgo).reverse();
      const recentChat = getRecentMessages.all(currentChannel, fiveMinAgo).reverse();
      if (recentTrans.length > 0) {
        context +=
          "配信者の最近の発言:\n" +
          recentTrans.map((t) => `配信者: ${t.message}`).join("\n") +
          "\n\n";
      }
      if (recentChat.length > 0) {
        context +=
          "最近のチャット:\n" +
          recentChat.map((m) => `${m.username}: ${m.message}`).join("\n") +
          "\n\n";
      }
    }

    const prompt = `${context}翻訳対象の配信者の発言: ${text}`;

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        systemInstruction: TRANSCRIPTION_SYSTEM_INSTRUCTION,
        thinkingConfig: { thinkingLevel: "minimal" },
      },
    });

    const translation = response.text.trim();
    if (translation && translation !== "SKIP") {
      io.emit("transcription-translation", { id, translation });
    }
  } catch (e) {
    console.error("Transcription translation error:", e.message);
  }
}

// Transcription
let transcription = null;

function createWavBuffer(pcmData) {
  const header = Buffer.alloc(44);
  const sampleRate = 16000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const fileSize = 36 + dataSize;

  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // subchunk1 size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmData]);
}

async function transcribeChunk(pcmChunk) {
  try {
    const wavBuffer = createWavBuffer(pcmChunk);
    const file = new File([wavBuffer], "audio.wav", { type: "audio/wav" });

    const response = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file,
    });

    const text = response.text.trim();
    if (text) {
      const timestamp = new Date().toISOString();
      if (currentChannel) {
        insertTranscription.run(currentChannel, text, timestamp);
      }
      const id = ++transcriptionId;
      io.emit("transcription", {
        id,
        text,
        timestamp,
      });
      translateTranscription(id, text);
    }
  } catch (e) {
    console.error("Transcription error:", e.message);
  }
}

function startTranscription(channel) {
  if (transcription) {
    stopTranscription();
  }

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

  let buffer = Buffer.alloc(0);
  const CHUNK_SIZE = 16000 * 2 * 7; // 7 seconds of 16kHz mono 16bit = 224,000 bytes

  ffmpegProc.stdout.on("data", (data) => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= CHUNK_SIZE) {
      const chunk = buffer.subarray(0, CHUNK_SIZE);
      buffer = buffer.subarray(CHUNK_SIZE);
      transcribeChunk(chunk);
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
    stopTranscription();
    io.emit("transcription-stopped");
  });

  ffmpegProc.on("error", (err) => {
    console.error("ffmpeg spawn error:", err.message);
    stopTranscription();
    io.emit("transcription-stopped");
  });

  streamlinkProc.on("close", () => {
    if (transcription) {
      stopTranscription();
      io.emit("transcription-stopped");
    }
  });

  transcription = { streamlink: streamlinkProc, ffmpeg: ffmpegProc };
}

function stopTranscription() {
  if (!transcription) return;
  try { transcription.streamlink.kill(); } catch (e) {}
  try { transcription.ffmpeg.kill(); } catch (e) {}
  transcription = null;
}

app.use(express.static("public"));

let tmiClient = null;
let currentChannel = null;

function createTmiClient(channel) {
  const client = new tmi.Client({
    identity: {
      username: process.env.BOT_NAME,
      password: process.env.TWITCH_TOKEN,
    },
    channels: [channel],
  });

  client.on("message", (ch, tags, message, self) => {
    if (self) return;
    const timestamp = new Date().toISOString();

    // Save to DB and get ID
    const result = insertMessage.run(ch, tags["display-name"], message, timestamp);
    const id = Number(result.lastInsertRowid);

    const data = { id, channel: ch, username: tags["display-name"], message, timestamp };
    console.log(`[${ch}] ${data.username}: ${message}`);
    io.emit("chat-message", data);

    // Translate in background (non-blocking)
    translateIfNeeded(data);
  });

  return client;
}

io.on("connection", (socket) => {
  if (currentChannel) {
    socket.emit("current-channel", currentChannel);
  }
  // Send saved channel list
  socket.emit("channel-list", getChannels.all().map((r) => r.name));

  socket.on("join-channel", async (channel) => {
    if (!channel || typeof channel !== "string") return;
    channel = channel.trim().toLowerCase().replace(/^#/, "");
    if (!channel) return;

    if (tmiClient) {
      try {
        await tmiClient.disconnect();
      } catch (e) {
        // ignore disconnect errors
      }
      tmiClient = null;
      currentChannel = null;
    }

    tmiClient = createTmiClient(channel);
    try {
      await tmiClient.connect();
      currentChannel = channel;
      upsertChannel.run(channel, new Date().toISOString());
      console.log(`Connected to #${channel}`);
      io.emit("channel-joined", channel);
      // Broadcast updated channel list to all clients
      io.emit("channel-list", getChannels.all().map((r) => r.name));
      // Auto-start transcription
      startTranscription(channel);
    } catch (e) {
      console.error(`Failed to connect to #${channel}:`, e);
      tmiClient = null;
      socket.emit("channel-error", `Failed to connect to #${channel}`);
    }
  });

  socket.on("manual-translate", async (text) => {
    if (!text || typeof text !== "string") return;
    text = text.trim();
    if (!text) return;
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `翻訳対象: ${text}`,
        config: {
          systemInstruction: `あなたは翻訳者です。

ルール:
- 入力が日本語の場合、英語に翻訳してください
- 入力が日本語以外の場合、日本語に翻訳してください
- 翻訳文のみを返してください。説明や注釈は不要です`,
          thinkingConfig: { thinkingLevel: "minimal" },
        },
      });
      socket.emit("manual-translate-result", response.text.trim());
    } catch (e) {
      console.error("Manual translation error:", e.message);
      socket.emit("manual-translate-result", "翻訳エラー");
    }
  });

  socket.on("leave-channel", async () => {
    stopTranscription();
    if (tmiClient) {
      try {
        await tmiClient.disconnect();
      } catch (e) {
        // ignore disconnect errors
      }
      tmiClient = null;
      currentChannel = null;
      console.log("Disconnected from channel");
      io.emit("channel-left");
    }
  });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
