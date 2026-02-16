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

// --- エラーメッセージ多言語辞書 ---
const ERROR_MESSAGES = {
  summaryFailed: {
    ja: "トピック要約に失敗しました", en: "Failed to summarize topics", ko: "토픽 요약에 실패했습니다",
    zh: "主题摘要失败", es: "Error al resumir temas", pt: "Falha ao resumir tópicos",
    fr: "Échec du résumé des sujets", de: "Themenzusammenfassung fehlgeschlagen", ru: "Не удалось создать сводку тем",
    th: "สรุปหัวข้อล้มเหลว", tr: "Konu özeti başarısız", it: "Riepilogo argomenti non riuscito",
    pl: "Podsumowanie tematów nie powiodło się", ar: "فشل في تلخيص المواضيع", id: "Gagal merangkum topik",
    vi: "Tóm tắt chủ đề thất bại", uk: "Не вдалося створити підсумок тем", nl: "Samenvatting van onderwerpen mislukt",
    sv: "Misslyckades med att sammanfatta ämnen", cs: "Shrnutí témat se nezdařilo", hi: "विषय सारांश विफल",
    ms: "Gagal meringkaskan topik",
  },
  moodFailed: {
    ja: "ムード分析に失敗しました", en: "Failed to analyze mood", ko: "분위기 분석에 실패했습니다",
    zh: "情绪分析失败", es: "Error al analizar el estado de ánimo", pt: "Falha ao analisar o humor",
    fr: "Échec de l'analyse d'ambiance", de: "Stimmungsanalyse fehlgeschlagen", ru: "Не удалось проанализировать настроение",
    th: "วิเคราะห์อารมณ์ล้มเหลว", tr: "Ruh hali analizi başarısız", it: "Analisi dell'umore non riuscita",
    pl: "Analiza nastroju nie powiodła się", ar: "فشل في تحليل المزاج", id: "Gagal menganalisis suasana",
    vi: "Phân tích tâm trạng thất bại", uk: "Не вдалося проаналізувати настрій", nl: "Stemmingsanalyse mislukt",
    sv: "Misslyckades med att analysera stämning", cs: "Analýza nálady se nezdařila", hi: "मूड विश्लेषण विफल",
    ms: "Gagal menganalisis suasana hati",
  },
  transcriptionTranslateFailed: {
    ja: "文字起こしの翻訳に失敗しました", en: "Failed to translate transcription", ko: "자막 번역에 실패했습니다",
    zh: "转录翻译失败", es: "Error al traducir la transcripción", pt: "Falha ao traduzir a transcrição",
    fr: "Échec de la traduction de la transcription", de: "Transkriptionsübersetzung fehlgeschlagen", ru: "Не удалось перевести транскрипцию",
    th: "แปลคำถอดเสียงล้มเหลว", tr: "Transkripsiyon çevirisi başarısız", it: "Traduzione della trascrizione non riuscita",
    pl: "Tłumaczenie transkrypcji nie powiodło się", ar: "فشل في ترجمة النسخ", id: "Gagal menerjemahkan transkripsi",
    vi: "Dịch phiên âm thất bại", uk: "Не вдалося перекласти транскрипцію", nl: "Vertaling van transcriptie mislukt",
    sv: "Misslyckades med att översätta transkription", cs: "Překlad přepisu se nezdařil", hi: "ट्रांसक्रिप्शन अनुवाद विफल",
    ms: "Gagal menterjemah transkripsi",
  },
  transcriptionStopped: {
    ja: "文字起こしが停止しました（リトライ上限）", en: "Transcription stopped (retry limit reached)", ko: "자막이 중지되었습니다 (재시도 한도 초과)",
    zh: "转录已停止（重试次数上限）", es: "Transcripción detenida (límite de reintentos)", pt: "Transcrição interrompida (limite de tentativas)",
    fr: "Transcription arrêtée (limite de tentatives)", de: "Transkription gestoppt (Wiederholungslimit)", ru: "Транскрипция остановлена (лимит попыток)",
    th: "การถอดเสียงหยุดแล้ว (ครบจำนวนลองใหม่)", tr: "Transkripsiyon durduruldu (yeniden deneme sınırı)", it: "Trascrizione interrotta (limite tentativi)",
    pl: "Transkrypcja zatrzymana (limit prób)", ar: "توقف النسخ (تم الوصول للحد الأقصى)", id: "Transkripsi dihentikan (batas percobaan ulang)",
    vi: "Phiên âm đã dừng (đạt giới hạn thử lại)", uk: "Транскрипцію зупинено (ліміт спроб)", nl: "Transcriptie gestopt (limiet bereikt)",
    sv: "Transkription stoppad (försöksgräns nådd)", cs: "Přepis zastaven (limit pokusů)", hi: "ट्रांसक्रिप्शन रुक गया (पुनः प्रयास सीमा)",
    ms: "Transkripsi dihentikan (had cuba semula)",
  },
  translationFailed: {
    ja: "チャットの翻訳に失敗しました", en: "Failed to translate chat", ko: "채팅 번역에 실패했습니다",
    zh: "聊天翻译失败", es: "Error al traducir el chat", pt: "Falha ao traduzir o chat",
    fr: "Échec de la traduction du chat", de: "Chat-Übersetzung fehlgeschlagen", ru: "Не удалось перевести чат",
    th: "แปลแชทล้มเหลว", tr: "Sohbet çevirisi başarısız", it: "Traduzione della chat non riuscita",
    pl: "Tłumaczenie czatu nie powiodło się", ar: "فشل في ترجمة الدردشة", id: "Gagal menerjemahkan chat",
    vi: "Dịch chat thất bại", uk: "Не вдалося перекласти чат", nl: "Chatvertaling mislukt",
    sv: "Misslyckades med att översätta chatt", cs: "Překlad chatu se nezdařil", hi: "चैट अनुवाद विफल",
    ms: "Gagal menterjemah sembang",
  },
  transcriptionStartFailed: {
    ja: "文字起こしの開始に失敗しました", en: "Failed to start transcription", ko: "자막 시작에 실패했습니다",
    zh: "启动转录失败", es: "Error al iniciar la transcripción", pt: "Falha ao iniciar a transcrição",
    fr: "Échec du démarrage de la transcription", de: "Transkriptionsstart fehlgeschlagen", ru: "Не удалось запустить транскрипцию",
    th: "เริ่มถอดเสียงล้มเหลว", tr: "Transkripsiyon başlatılamadı", it: "Avvio della trascrizione non riuscito",
    pl: "Uruchomienie transkrypcji nie powiodło się", ar: "فشل في بدء النسخ", id: "Gagal memulai transkripsi",
    vi: "Bắt đầu phiên âm thất bại", uk: "Не вдалося запустити транскрипцію", nl: "Starten van transcriptie mislukt",
    sv: "Misslyckades med att starta transkription", cs: "Spuštění přepisu se nezdařilo", hi: "ट्रांसक्रिप्शन शुरू करना विफल",
    ms: "Gagal memulakan transkripsi",
  },
};

function getErrorMessage(key) {
  return ERROR_MESSAGES[key][currentLanguage] || ERROR_MESSAGES[key].en;
}

const ERROR_DETAILS = {
  invalidKey: {
    ja: "APIキーが無効です。設定画面で正しいキーを入力してください。",
    en: "Invalid API key. Please enter a valid key in settings.",
    ko: "API 키가 유효하지 않습니다. 설정에서 올바른 키를 입력하세요.",
    zh: "API密钥无效。请在设置中输入正确的密钥。",
    es: "Clave API inválida. Ingrese una clave válida en la configuración.",
    pt: "Chave API inválida. Insira uma chave válida nas configurações.",
    fr: "Clé API invalide. Veuillez entrer une clé valide dans les paramètres.",
    de: "Ungültiger API-Schlüssel. Bitte geben Sie einen gültigen Schlüssel in den Einstellungen ein.",
    ru: "Недействительный ключ API. Введите правильный ключ в настройках.",
    th: "คีย์ API ไม่ถูกต้อง กรุณาใส่คีย์ที่ถูกต้องในการตั้งค่า",
    tr: "Geçersiz API anahtarı. Lütfen ayarlardan geçerli bir anahtar girin.",
    it: "Chiave API non valida. Inserisci una chiave valida nelle impostazioni.",
    pl: "Nieprawidłowy klucz API. Wprowadź poprawny klucz w ustawieniach.",
    ar: "مفتاح API غير صالح. يرجى إدخال مفتاح صحيح في الإعدادات.",
    id: "Kunci API tidak valid. Masukkan kunci yang valid di pengaturan.",
    vi: "Khóa API không hợp lệ. Vui lòng nhập khóa đúng trong cài đặt.",
    uk: "Недійсний ключ API. Введіть правильний ключ у налаштуваннях.",
    nl: "Ongeldige API-sleutel. Voer een geldige sleutel in bij de instellingen.",
    sv: "Ogiltig API-nyckel. Ange en giltig nyckel i inställningarna.",
    cs: "Neplatný klíč API. Zadejte platný klíč v nastavení.",
    hi: "API कुंजी अमान्य है। कृपया सेटिंग्स में सही कुंजी दर्ज करें।",
    ms: "Kunci API tidak sah. Sila masukkan kunci yang sah dalam tetapan.",
  },
  rateLimited: {
    ja: "APIのリクエスト制限に達しました。しばらくお待ちください。",
    en: "API rate limit reached. Please wait a moment.",
    ko: "API 요청 한도에 도달했습니다. 잠시 기다려 주세요.",
    zh: "已达到API请求限制。请稍候。",
    es: "Se alcanzó el límite de solicitudes API. Espere un momento.",
    pt: "Limite de requisições da API atingido. Aguarde um momento.",
    fr: "Limite de requêtes API atteinte. Veuillez patienter.",
    de: "API-Anfragelimit erreicht. Bitte warten Sie einen Moment.",
    ru: "Достигнут лимит запросов API. Подождите немного.",
    th: "ถึงขีดจำกัดคำขอ API แล้ว กรุณารอสักครู่",
    tr: "API istek sınırına ulaşıldı. Lütfen biraz bekleyin.",
    it: "Limite di richieste API raggiunto. Attendere un momento.",
    pl: "Osiągnięto limit zapytań API. Proszę chwilę poczekać.",
    ar: "تم الوصول إلى حد طلبات API. يرجى الانتظار قليلاً.",
    id: "Batas permintaan API tercapai. Harap tunggu sebentar.",
    vi: "Đã đạt giới hạn yêu cầu API. Vui lòng đợi một chút.",
    uk: "Досягнуто ліміт запитів API. Зачекайте трохи.",
    nl: "API-aanvraaglimiet bereikt. Even geduld.",
    sv: "API-förfrågningsgräns nådd. Vänta en stund.",
    cs: "Dosažen limit požadavků API. Počkejte chvíli.",
    hi: "API अनुरोध सीमा पूरी हो गई। कृपया कुछ देर प्रतीक्षा करें।",
    ms: "Had permintaan API dicapai. Sila tunggu sebentar.",
  },
  serverError: {
    ja: "APIサーバーでエラーが発生しました。しばらくしてから再試行されます。",
    en: "API server error. It will be retried shortly.",
    ko: "API 서버 오류가 발생했습니다. 잠시 후 재시도됩니다.",
    zh: "API服务器错误。稍后将自动重试。",
    es: "Error del servidor API. Se reintentará en breve.",
    pt: "Erro no servidor da API. Será tentado novamente em breve.",
    fr: "Erreur du serveur API. Une nouvelle tentative sera effectuée.",
    de: "API-Serverfehler. Es wird in Kürze erneut versucht.",
    ru: "Ошибка сервера API. Повторная попытка будет выполнена.",
    th: "เกิดข้อผิดพลาดของเซิร์ฟเวอร์ API จะลองใหม่อีกครั้ง",
    tr: "API sunucu hatası. Kısa süre içinde yeniden denenecek.",
    it: "Errore del server API. Verrà riprovato a breve.",
    pl: "Błąd serwera API. Ponowna próba nastąpi wkrótce.",
    ar: "خطأ في خادم API. ستتم إعادة المحاولة قريبًا.",
    id: "Kesalahan server API. Akan dicoba lagi segera.",
    vi: "Lỗi máy chủ API. Sẽ thử lại sau.",
    uk: "Помилка сервера API. Повторна спроба буде виконана.",
    nl: "API-serverfout. Er wordt binnenkort opnieuw geprobeerd.",
    sv: "API-serverfel. Nytt försök görs snart.",
    cs: "Chyba serveru API. Bude opakováno.",
    hi: "API सर्वर में त्रुटि। शीघ्र ही पुनः प्रयास किया जाएगा।",
    ms: "Ralat pelayan API. Akan dicuba semula sebentar lagi.",
  },
  connectionError: {
    ja: "APIサーバーに接続できません。ネットワークを確認してください。",
    en: "Cannot connect to API server. Please check your network.",
    ko: "API 서버에 연결할 수 없습니다. 네트워크를 확인하세요.",
    zh: "无法连接到API服务器。请检查网络。",
    es: "No se puede conectar al servidor API. Verifique su red.",
    pt: "Não foi possível conectar ao servidor da API. Verifique sua rede.",
    fr: "Impossible de se connecter au serveur API. Vérifiez votre réseau.",
    de: "Verbindung zum API-Server nicht möglich. Überprüfen Sie Ihr Netzwerk.",
    ru: "Не удаётся подключиться к серверу API. Проверьте сеть.",
    th: "ไม่สามารถเชื่อมต่อกับเซิร์ฟเวอร์ API ได้ กรุณาตรวจสอบเครือข่าย",
    tr: "API sunucusuna bağlanılamıyor. Ağınızı kontrol edin.",
    it: "Impossibile connettersi al server API. Controlla la rete.",
    pl: "Nie można połączyć się z serwerem API. Sprawdź połączenie sieciowe.",
    ar: "تعذر الاتصال بخادم API. يرجى التحقق من الشبكة.",
    id: "Tidak dapat terhubung ke server API. Periksa jaringan Anda.",
    vi: "Không thể kết nối đến máy chủ API. Vui lòng kiểm tra mạng.",
    uk: "Неможливо підключитися до сервера API. Перевірте мережу.",
    nl: "Kan geen verbinding maken met de API-server. Controleer uw netwerk.",
    sv: "Kan inte ansluta till API-servern. Kontrollera ditt nätverk.",
    cs: "Nelze se připojit k serveru API. Zkontrolujte síť.",
    hi: "API सर्वर से कनेक्ट नहीं हो पा रहा। कृपया नेटवर्क जांचें।",
    ms: "Tidak dapat menyambung ke pelayan API. Sila semak rangkaian anda.",
  },
};

function formatErrorDetail(e) {
  const status = e.status;
  const msg = e.message || "";
  if (status === 401 || status === 403 || /api.key/i.test(msg) || /auth/i.test(msg)) {
    return (ERROR_DETAILS.invalidKey[currentLanguage] || ERROR_DETAILS.invalidKey.en);
  }
  if (status === 429 || /rate.limit/i.test(msg) || /resource.*exhausted/i.test(msg)) {
    return (ERROR_DETAILS.rateLimited[currentLanguage] || ERROR_DETAILS.rateLimited.en);
  }
  if (status >= 500) {
    return (ERROR_DETAILS.serverError[currentLanguage] || ERROR_DETAILS.serverError.en);
  }
  if (/connection|timeout|timed.out|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(msg)) {
    return (ERROR_DETAILS.connectionError[currentLanguage] || ERROR_DETAILS.connectionError.en);
  }
  return msg;
}

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
    io.emit("error-log", { category: "summary", message: formatErrorDetail(e), detail: e.message, timestamp: new Date().toISOString() });
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

// --- ムード分析 ---
let moodActivityCount = 0;
let moodTimer = null;
let lastMoodData = null;
let moodRunning = false;

const MOOD_INTERVAL = 30000;
const MOOD_FORCE_COUNT = 8;

async function runMoodAnalysis() {
  if (moodRunning || !translator || !currentChannel) return;
  moodRunning = true;
  moodActivityCount = 0;
  try {
    const mood = await translator.analyzeMood(currentChannel, currentLanguage);
    if (mood) {
      lastMoodData = mood;
      io.emit("mood-analysis", mood);
    }
  } catch (e) {
    console.error("Mood analysis error:", e.message);
    io.emit("error-log", { category: "mood", message: formatErrorDetail(e), detail: e.message, timestamp: new Date().toISOString() });
  } finally {
    moodRunning = false;
  }
}

function onMoodActivity() {
  moodActivityCount++;
  if (moodActivityCount >= MOOD_FORCE_COUNT) {
    runMoodAnalysis();
  }
}

function startMoodTimer() {
  stopMoodTimer();
  moodActivityCount = 0;
  lastMoodData = null;
  moodTimer = setInterval(() => {
    if (moodActivityCount < 1) return;
    runMoodAnalysis();
  }, MOOD_INTERVAL);
}

function stopMoodTimer() {
  if (moodTimer) {
    clearInterval(moodTimer);
    moodTimer = null;
  }
  moodActivityCount = 0;
  lastMoodData = null;
  io.emit("mood-analysis-cleared");
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
      onMoodActivity();
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
        .catch((e) => {
          console.error("Transcription correction/translation error:", e.message);
          io.emit("error-log", { category: "transcription", message: formatErrorDetail(e), detail: e.message, timestamp: new Date().toISOString() });
        });
    },
    onStopped: () => {
      io.emit("transcription-stopped");
      io.emit("error-log", { category: "transcription", message: getErrorMessage("transcriptionStopped"), timestamp: new Date().toISOString() });
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
    onMoodActivity();
    translator.translateChat(data, currentLanguage)
      .then((translation) => {
        if (translation) io.emit("chat-translation", { id: data.id, translation });
      })
      .catch((e) => {
        console.error("Translation error:", e.message);
        io.emit("error-log", { category: "translation", message: formatErrorDetail(e), detail: e.message, timestamp: new Date().toISOString() });
      });
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
    if (lastMoodData) {
      socket.emit("mood-analysis", lastMoodData);
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
      stopMoodTimer();
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
      startMoodTimer();
      transcriber.start(channel).catch((e) => {
        console.error("Transcriber start error:", e);
        io.emit("error-log", { category: "transcription", message: formatErrorDetail(e), detail: e.message, timestamp: new Date().toISOString() });
      });
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
      transcriber.start(currentChannel).catch((e) => {
        console.error("Transcriber start error:", e);
        io.emit("error-log", { category: "transcription", message: formatErrorDetail(e), detail: e.message, timestamp: new Date().toISOString() });
      });
    } else {
      transcriber.stop();
    }
  });

  socket.on("leave-channel", async () => {
    stopSummaryTimer();
    stopMoodTimer();
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
