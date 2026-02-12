const path = require("path");
const { execFileSync } = require("child_process");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const tmi = require("tmi.js");
const { GoogleGenAI } = require("@google/genai");
const OpenAI = require("openai");

// --- 起動時の依存チェック (ffmpeg のみ) ---
function resolveFfmpegPath() {
  try {
    return execFileSync("which", ["ffmpeg"], { encoding: "utf8" }).trim();
  } catch {}
  return require("ffmpeg-static").replace("app.asar", "app.asar.unpacked");
}
function checkDependencies() {
  const ffmpegPath = resolveFfmpegPath();
  try {
    execFileSync(ffmpegPath, ["-version"], { stdio: "ignore" });
  } catch {
    throw new Error(`必要な外部コマンドが見つかりません: ffmpeg (パス: ${ffmpegPath})`);
  }
}
checkDependencies();

const { upsertChannel, getChannels, insertMessage, insertTranscription, getRecentMessages, getSetting, upsertSetting, clearAllData } = require("./lib/db");
const { createTranslator } = require("./lib/translator");
const { Transcriber } = require("./lib/transcription");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- 遅延初期化される AI クライアント ---
let ai = null;
let openai = null;
let translator = null;
let transcriber = null;
let isInitialized = false;

const SETTING_KEYS = ["TWITCH_TOKEN", "BOT_NAME", "GEMINI_API_KEY", "OPENAI_API_KEY"];

function loadSettings() {
  const settings = {};
  for (const key of SETTING_KEYS) {
    const row = getSetting.get(key);
    if (row) settings[key] = row.value;
  }
  return settings;
}

function maskValue(value) {
  if (!value) return "";
  if (value.length <= 8) return "***";
  return value.slice(0, 4) + "***" + value.slice(-4);
}

function getMaskedSettings() {
  const settings = loadSettings();
  const masked = {};
  for (const key of SETTING_KEYS) {
    masked[key] = maskValue(settings[key] || "");
  }
  return masked;
}

let tmiClient = null;
let currentChannel = null;
let currentLanguage = "ja";
let transcriptionId = 0;

// --- トピック要約 ---
let summaryActivityCount = 0;
let summaryTimer = null;
let lastSummaryText = null;
let summaryRunning = false;

const SUMMARY_INTERVAL = 20000;
const SUMMARY_FORCE_COUNT = 5;

async function runSummary() {
  if (summaryRunning || !translator || !currentChannel) return;
  summaryRunning = true;
  summaryActivityCount = 0;
  try {
    const summary = await translator.summarizeTopic(currentChannel, currentLanguage);
    if (summary && summary !== lastSummaryText) {
      lastSummaryText = summary;
      io.emit("topic-summary", summary);
    }
  } catch (e) {
    console.error("Topic summary error:", e.message);
  } finally {
    summaryRunning = false;
  }
}

function onSummaryActivity() {
  summaryActivityCount++;
  if (summaryActivityCount >= SUMMARY_FORCE_COUNT) {
    runSummary();
  }
}

function startSummaryTimer() {
  stopSummaryTimer();
  summaryActivityCount = 0;
  lastSummaryText = null;
  summaryTimer = setInterval(() => {
    if (summaryActivityCount < 1) return;
    runSummary();
  }, SUMMARY_INTERVAL);
}

function stopSummaryTimer() {
  if (summaryTimer) {
    clearInterval(summaryTimer);
    summaryTimer = null;
  }
  summaryActivityCount = 0;
  lastSummaryText = null;
  io.emit("topic-summary-cleared");
}

// TTS readout detection
const TTS_WINDOW_SECONDS = 30;
const TTS_SIMILARITY_THRESHOLD = 0.5;

function normalizeText(text) {
  return text
    .replace(/[\s\u3000]+/g, "")
    .replace(/[、。！？,.!?…・「」『』（）()\[\]【】:：;；～~\-]/g, "")
    .toLowerCase();
}

function isTTSMatch(transcriptionText, chatMessage) {
  const nt = normalizeText(transcriptionText);
  const nc = normalizeText(chatMessage);
  if (!nt || !nc || nc.length < 2) return false;
  if (nt.includes(nc) || nc.includes(nt)) return true;

  const bigramsA = new Set();
  for (let i = 0; i < nt.length - 1; i++) bigramsA.add(nt.slice(i, i + 2));
  const bigramsB = new Set();
  for (let i = 0; i < nc.length - 1; i++) bigramsB.add(nc.slice(i, i + 2));

  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }
  return (2 * intersection) / (bigramsA.size + bigramsB.size) >= TTS_SIMILARITY_THRESHOLD;
}

function isTTSReadout(text) {
  if (!currentChannel) return false;
  const windowAgo = new Date(Date.now() - TTS_WINDOW_SECONDS * 1000).toISOString();
  const recentChats = getRecentMessages.all(currentChannel, windowAgo);
  return recentChats.some((chat) => isTTSMatch(text, chat.message));
}

function initializeServices(settings) {
  ai = new GoogleGenAI({ apiKey: settings.GEMINI_API_KEY });
  openai = new OpenAI({ apiKey: settings.OPENAI_API_KEY });
  translator = createTranslator(ai);

  if (transcriber) {
    transcriber.stop();
  }
  transcriber = new Transcriber(openai, {
    onTranscription: (text) => {
      if (isTTSReadout(text)) return;
      const timestamp = new Date().toISOString();
      if (currentChannel) {
        insertTranscription.run(currentChannel, text, timestamp);
      }
      const id = ++transcriptionId;
      io.emit("transcription", { id, text, timestamp });
      onSummaryActivity();
      translator.correctTranscription(text, currentChannel)
        .then((corrected) => {
          if (corrected && corrected !== text) {
            io.emit("transcription-corrected", { id, corrected });
          }
          const textForTranslation = corrected || text;
          return translator.translateTranscription(textForTranslation, currentChannel, currentLanguage)
            .then((translation) => {
              if (translation) io.emit("transcription-translation", { id, translation });
            });
        })
        .catch((e) => console.error("Transcription correction/translation error:", e.message));
    },
    onStopped: () => {
      io.emit("transcription-stopped");
    },
  });

  // TMI で使うために process.env にも設定
  process.env.BOT_NAME = settings.BOT_NAME;
  process.env.TWITCH_TOKEN = settings.TWITCH_TOKEN;

  isInitialized = true;
  console.log("Services initialized successfully");
}

// 起動時に DB から設定を読み込み、揃っていれば自動初期化
const savedSettings = loadSettings();
if (SETTING_KEYS.every((k) => savedSettings[k])) {
  initializeServices(savedSettings);
}

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
    const result = insertMessage.run(ch, tags["display-name"], message, timestamp);
    const id = Number(result.lastInsertRowid);
    const data = { id, channel: ch, username: tags["display-name"], message, timestamp };
    console.log(`[${ch}] ${data.username}: ${message}`);
    io.emit("chat-message", data);
    onSummaryActivity();
    translator.translateChat(data, currentLanguage)
      .then((translation) => {
        if (translation) io.emit("chat-translation", { id: data.id, translation });
      })
      .catch((e) => console.error("Translation error:", e.message));
  });

  return client;
}

app.use(express.static(path.join(__dirname, "public")));

io.on("connection", (socket) => {
  // 設定状態を送信
  socket.emit("settings-status", { configured: isInitialized, settings: getMaskedSettings() });

  if (currentChannel) {
    socket.emit("current-channel", currentChannel);
    if (lastSummaryText) {
      socket.emit("topic-summary", lastSummaryText);
    }
  }
  socket.emit("channel-list", getChannels.all().map((r) => r.name));
  socket.emit("current-language", currentLanguage);

  socket.on("get-settings", () => {
    socket.emit("settings-data", getMaskedSettings());
  });

  socket.on("save-settings", (data) => {
    if (!data || typeof data !== "object") {
      socket.emit("settings-error", "無効なデータです");
      return;
    }

    // 現在の設定を読み込み (マスク値のスキップ用)
    const current = loadSettings();

    for (const key of SETTING_KEYS) {
      const value = data[key];
      if (typeof value !== "string" || !value.trim()) continue;
      // マスクされた値 (***を含む) はスキップ
      if (value.includes("***")) continue;
      current[key] = value.trim();
    }

    // 全キーが揃っているかチェック
    const missing = SETTING_KEYS.filter((k) => !current[k]);
    if (missing.length > 0) {
      socket.emit("settings-error", `未入力の項目があります: ${missing.join(", ")}`);
      return;
    }

    // DB に保存
    for (const key of SETTING_KEYS) {
      upsertSetting.run(key, current[key]);
    }

    // サービスを (再) 初期化
    try {
      initializeServices(current);
      io.emit("settings-status", { configured: true, settings: getMaskedSettings() });
    } catch (e) {
      console.error("Settings initialization error:", e);
      socket.emit("settings-error", `初期化エラー: ${e.message}`);
    }
  });

  socket.on("clear-all-data", async () => {
    try {
      // 接続中のチャンネルを切断
      stopSummaryTimer();
      if (transcriber) transcriber.stop();
      if (tmiClient) {
        try { await tmiClient.disconnect(); } catch (e) {}
        tmiClient = null;
        currentChannel = null;
      }

      // DB の全データを削除
      clearAllData();

      // サービス状態をリセット
      ai = null;
      openai = null;
      translator = null;
      transcriber = null;
      isInitialized = false;

      // 全クライアントに通知
      io.emit("channel-left");
      io.emit("channel-list", []);
      io.emit("settings-status", { configured: false, settings: getMaskedSettings() });
      socket.emit("data-cleared");
      console.log("All data cleared");
    } catch (e) {
      console.error("Clear data error:", e);
      socket.emit("settings-error", `データ削除エラー: ${e.message}`);
    }
  });

  socket.on("join-channel", async (channel) => {
    if (!isInitialized) {
      socket.emit("channel-error", "設定が完了していません。先にAPIキーを設定してください。");
      return;
    }
    if (!channel || typeof channel !== "string") return;
    channel = channel.trim().toLowerCase().replace(/^#/, "");
    if (!channel) return;

    if (tmiClient) {
      try { await tmiClient.disconnect(); } catch (e) {}
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
      io.emit("channel-list", getChannels.all().map((r) => r.name));
      startSummaryTimer();
      transcriber.start(channel).catch((e) => console.error("Transcriber start error:", e));
    } catch (e) {
      console.error(`Failed to connect to #${channel}:`, e);
      tmiClient = null;
      socket.emit("channel-error", `Failed to connect to #${channel}`);
    }
  });

  socket.on("manual-translate", async (text) => {
    if (!isInitialized) {
      socket.emit("manual-translate-result", "設定が完了していません");
      return;
    }
    if (!text || typeof text !== "string") return;
    text = text.trim();
    if (!text) return;
    try {
      const result = await translator.translateManual(text, currentLanguage);
      socket.emit("manual-translate-result", result);
    } catch (e) {
      console.error("Manual translation error:", e.message);
      socket.emit("manual-translate-result", "翻訳エラー");
    }
  });

  socket.on("set-language", (lang) => {
    if (typeof lang === "string" && lang.trim()) {
      currentLanguage = lang.trim();
      io.emit("current-language", currentLanguage);
    }
  });

  socket.on("toggle-transcription", (enabled) => {
    if (!currentChannel || !transcriber) return;
    if (enabled) {
      transcriber.start(currentChannel).catch((e) => console.error("Transcriber start error:", e));
    } else {
      transcriber.stop();
    }
  });

  socket.on("leave-channel", async () => {
    stopSummaryTimer();
    if (transcriber) transcriber.stop();
    if (tmiClient) {
      try { await tmiClient.disconnect(); } catch (e) {}
      tmiClient = null;
      currentChannel = null;
      console.log("Disconnected from channel");
      io.emit("channel-left");
    }
  });
});

const PORT = process.env.PORT || 3000;

function startServer() {
  return new Promise((resolve) => {
    server.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      resolve(PORT);
    });
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer };
