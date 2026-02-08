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

  return { translateChat, translateTranscription, translateManual };
}

module.exports = { createTranslator };
