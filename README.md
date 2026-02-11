# Twitch AI Monitor

Twitchチャットをリアルタイムで監視し、非日本語コメントをAIで自動翻訳するWebアプリケーションです。
配信者の音声をリアルタイムで文字起こし・翻訳する機能も搭載しています。

## 機能

- Twitchチャットのリアルタイム表示
- 非日本語コメントをGemini 3 Flashで自動翻訳
- 翻訳の基準言語をUIから選択可能 (日本語・英語・韓国語・中国語・スペイン語・ポルトガル語・フランス語・ドイツ語・ロシア語・タイ語)
- 配信者の音声をリアルタイムで文字起こし (OpenAI Whisper API)
- VADベースの発話区間検出で高精度な音声分割
- 配信者の発言を自動翻訳 (選択言語 → 英語 / その他 → 選択言語)
- 過去の会話と配信者の発言を考慮した文脈のある翻訳
- 文字起こしプロセスのエラー時に自動リトライ
- チャットTTS読み上げの重複排除 (バイグラム類似度による自動検出)
- チャットと配信者の発言を時系列で表示 (配信者表示ON/OFF切替可)
- 手動翻訳機能 (選択言語 → 英語 / その他 → 選択言語)
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

音声文字起こし機能には以下のツールが必要です。起動時に自動チェックされ、未インストールの場合はエラーメッセージとともに終了します。

- [ffmpeg](https://ffmpeg.org/) — 音声の抽出・変換

```bash
# インストール例 (Ubuntu/Debian)
sudo apt install ffmpeg
```

## プロジェクト構成

```
server.js              # エントリポイント (Express + Socket.IO + TMI の配線層)
lib/db.js              # SQLite スキーマ + クエリ
lib/audio.js           # 音声ユーティリティ (WAV変換, RMS計算)
lib/translator.js      # Gemini翻訳 (チャット・文字起こし・手動)
lib/transcription.js   # 文字起こしパイプライン (VAD・Whisper・リトライ)
lib/twitch-hls.js      # Twitch HLS URL取得 (GQL API + Usher API)
public/index.html      # Web UI
```

## 技術スタック

- Node.js / Express v5 / Socket.IO v4
- tmi.js (Twitch IRC)
- SQLite (better-sqlite3)
- Google Gemini 3 Flash (@google/genai)
- OpenAI Whisper API (音声文字起こし)
- Twitch GQL API + ffmpeg (配信音声取得)
