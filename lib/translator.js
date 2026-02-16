const { getRecentMessages, getRecentTranscriptions } = require("./db");

const LANG_NAMES_JA = {
  ja: "日本語",
  en: "英語",
  ko: "韓国語",
  zh: "中国語",
  es: "スペイン語",
  pt: "ポルトガル語",
  fr: "フランス語",
  de: "ドイツ語",
  ru: "ロシア語",
  th: "タイ語",
  tr: "トルコ語",
  it: "イタリア語",
  pl: "ポーランド語",
  ar: "アラビア語",
  id: "インドネシア語",
  vi: "ベトナム語",
  uk: "ウクライナ語",
  nl: "オランダ語",
  sv: "スウェーデン語",
  cs: "チェコ語",
  hi: "ヒンディー語",
  ms: "マレー語",
};

function buildChatInstruction(langCode) {
  const langName = LANG_NAMES_JA[langCode] || langCode;
  if (langCode === "en") {
    return `あなたはTwitchチャットの翻訳者です。

ルール:
- 翻訳不要なもの（エモート、スタンプ、万国共通の短い語、URLのみ等）は「SKIP」と返してください
- メッセージが英語の場合、「SKIP」と返してください
- それ以外は自然な英語に翻訳してください
- 会話の文脈を考慮して翻訳してください
- 翻訳文のみを返してください。説明や注釈は不要です`;
  }
  return `あなたはTwitchチャットの翻訳者です。

ルール:
- 翻訳不要なもの（エモート、スタンプ、万国共通の短い語、URLのみ等）は「SKIP」と返してください
- メッセージが${langName}の場合、英語に翻訳してください
- それ以外は自然な${langName}に翻訳してください
- 会話の文脈を考慮して翻訳してください
- 翻訳文のみを返してください。説明や注釈は不要です`;
}

function buildTranscriptionInstruction(langCode) {
  const langName = LANG_NAMES_JA[langCode] || langCode;
  if (langCode === "en") {
    return `あなたはTwitch配信者の発言の翻訳者です。

ルール:
- 発言が英語の場合、「SKIP」と返してください
- それ以外は自然な英語に翻訳してください
- 会話の文脈を考慮して翻訳してください
- 翻訳文のみを返してください。説明や注釈は不要です`;
  }
  return `あなたはTwitch配信者の発言の翻訳者です。

ルール:
- 発言が${langName}の場合、英語に翻訳してください
- それ以外は自然な${langName}に翻訳してください
- 会話の文脈を考慮して翻訳してください
- 翻訳文のみを返してください。説明や注釈は不要です`;
}

function buildManualInstruction(langCode) {
  const langName = LANG_NAMES_JA[langCode] || langCode;
  if (langCode === "en") {
    return `あなたは翻訳者です。

ルール:
- 入力が英語の場合、日本語に翻訳してください
- 入力が英語以外の場合、英語に翻訳してください
- 翻訳文のみを返してください。説明や注釈は不要です`;
  }
  return `あなたは翻訳者です。

ルール:
- 入力が${langName}の場合、英語に翻訳してください
- 入力が${langName}以外の場合、${langName}に翻訳してください
- 翻訳文のみを返してください。説明や注釈は不要です`;
}

function buildContext(channel) {
  if (!channel) return "";
  const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
  const recentTrans = getRecentTranscriptions.all(channel, fiveMinAgo).reverse();
  const recentChat = getRecentMessages.all(channel, fiveMinAgo).reverse();
  let context = "";
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
  return context;
}

function createTranslator(ai) {
  async function _generate(prompt, systemInstruction) {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        systemInstruction,
        thinkingConfig: { thinkingLevel: "minimal" },
      },
    });
    return response.text.trim();
  }

  async function translateChat(msgData, langCode) {
    const context = buildContext(msgData.channel);
    const prompt = `${context}翻訳対象メッセージ (${msgData.username}): ${msgData.message}`;
    const result = await _generate(prompt, buildChatInstruction(langCode));
    return result && result !== "SKIP" ? result : null;
  }

  async function translateTranscription(text, channel, langCode) {
    const context = buildContext(channel);
    const prompt = `${context}翻訳対象の配信者の発言: ${text}`;
    const result = await _generate(prompt, buildTranscriptionInstruction(langCode));
    return result && result !== "SKIP" ? result : null;
  }

  async function translateManual(text, langCode) {
    const prompt = `翻訳対象: ${text}`;
    return await _generate(prompt, buildManualInstruction(langCode));
  }

  async function correctTranscription(text, channel) {
    const context = buildContext(channel);
    const systemInstruction = `あなたはTwitch配信の音声文字起こしの補正者です。

ルール:
- 音声認識の誤りを文脈から判断して補正してください
- 固有名詞、ゲーム用語、スラングなどの誤認識を特に注意してください
- 修正が不要な場合はそのまま返してください
- 補正後のテキストのみを返してください。説明や注釈は不要です`;
    const prompt = `${context}補正対象の文字起こし: ${text}`;
    return await _generate(prompt, systemInstruction);
  }

  async function summarizeTopic(channel, langCode) {
    const context = buildContext(channel);
    if (!context) return null;
    const langName = LANG_NAMES_JA[langCode] || langCode;
    const systemInstruction = `あなたはTwitch配信のチャット要約者です。

ルール:
- 配信者の発言とチャットの流れから、今話題になっていることを${langName}で箇条書きにしてください
- 各項目は「・」で始めてください
- 最大5項目まで
- 簡潔に、1項目1行で書いてください
- 会話が少なすぎて話題を特定できない場合は「SKIP」と返してください
- 箇条書きのみを返してください。説明や前置きは不要です`;
    const prompt = `${context}上記の会話の流れから、今の話題を箇条書きで要約してください。`;
    const result = await _generate(prompt, systemInstruction);
    return result && result !== "SKIP" ? result : null;
  }

  async function analyzeMood(channel, langCode) {
    const context = buildContext(channel);
    if (!context) return null;
    const systemInstruction = `あなたはTwitch配信のムード分析者です。

配信者の発言とチャットの流れから、以下の3つの指標を1〜10のスケールで評価してください。

- streamer_tension: 配信者の盛り上がり度 (1=落ち着いている, 10=非常にテンションが高い)
- viewer_tension: 視聴者の盛り上がり度 (1=静か, 10=非常に盛り上がっている)
- atmosphere: チャットの雰囲気 (1=平和, 10=混沌)

必ず以下のJSON形式のみで返してください。説明や前置きは不要です:
{"streamer_tension":5,"viewer_tension":5,"atmosphere":5}`;
    const prompt = `${context}上記の会話の流れから、配信のムードを分析してJSON形式で返してください。`;
    try {
      const result = await _generate(prompt, systemInstruction);
      if (!result) return null;
      const cleaned = result.replace(/```json\s*|```\s*/g, "").trim();
      const parsed = JSON.parse(cleaned);
      const clamp = (v) => Math.max(1, Math.min(10, Math.round(Number(v) || 5)));
      return {
        streamer_tension: clamp(parsed.streamer_tension),
        viewer_tension: clamp(parsed.viewer_tension),
        atmosphere: clamp(parsed.atmosphere),
      };
    } catch {
      return null;
    }
  }

  return { translateChat, translateTranscription, translateManual, correctTranscription, summarizeTopic, analyzeMood };
}

module.exports = { createTranslator };
