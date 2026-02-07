# Twitch AI Monitor

Twitchチャットをリアルタイムで監視し、非日本語コメントをAIで自動翻訳するWebアプリケーションです。
配信者の音声をリアルタイムで文字起こし・翻訳する機能も搭載しています。

## 機能

- Twitchチャットのリアルタイム表示
- 非日本語コメントをGemini 3 Flashで自動翻訳
- 配信者の音声をリアルタイムで文字起こし (OpenAI Whisper API)
- 配信者の非日本語発言を自動翻訳
- 過去の会話と配信者の発言を考慮した文脈のある翻訳
- 2ペインUI (左: 配信者の文字起こし+翻訳、右: チャット+翻訳)
- 接続チャンネル履歴のサジェスト表示

## セットアップ

```bash
npm install
```

`.env` ファイルを作成して環境変数を設定します。

```
TWITCH_TOKEN=oauth:your_token
BOT_NAME=your_bot_name
GEMINI_API_KEY=your_api_key
OPENAI_API_KEY=your_openai_api_key
```

| 変数 | 説明 | 取得先 |
|------|------|--------|
| `TWITCH_TOKEN` | Twitch OAuth トークン | https://twitchapps.com/tmi/ |
| `BOT_NAME` | Twitch ユーザー名 | あなたのTwitchアカウント名 |
| `GEMINI_API_KEY` | Google Gemini API キー | https://aistudio.google.com/apikey |
| `OPENAI_API_KEY` | OpenAI API キー (Whisper文字起こし用) | https://platform.openai.com/api-keys |

## 起動

```bash
npm start
```

http://localhost:3000 を開き、チャンネル名を入力して「開始」をクリックします。

## 必要な外部ツール

音声文字起こし機能には以下のツールが必要です。

- [streamlink](https://streamlink.github.io/) — 配信ストリームの取得
- [ffmpeg](https://ffmpeg.org/) — 音声の抽出・変換

## 技術スタック

- Node.js / Express v5 / Socket.IO v4
- tmi.js (Twitch IRC)
- SQLite (better-sqlite3)
- Google Gemini 3 Flash (@google/genai)
- OpenAI Whisper API (音声文字起こし)
- streamlink + ffmpeg (配信音声取得)
