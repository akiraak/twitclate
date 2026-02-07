# Twitch AI Monitor

Twitchチャットをリアルタイムで監視し、非日本語コメントをAIで日本語訳するWebアプリケーション。

## 技術スタック

- **Runtime:** Node.js (CommonJS)
- **Web:** Express v5 + Socket.IO v4
- **Twitch接続:** tmi.js (IRC経由)
- **DB:** SQLite (better-sqlite3) — `data.db` に保存
- **AI翻訳:** Google Gemini 3 Flash (@google/genai)
- **音声文字起こし:** streamlink + ffmpeg + OpenAI Whisper API
- **フロントエンド:** Vanilla HTML/CSS/JS (public/index.html 単一ファイル)

## プロジェクト構成

```
server.js          # メインサーバー (Express + Socket.IO + TMI + SQLite + Gemini)
public/index.html  # Web UI (HTML/CSS/JS一体型)
.env               # 環境変数 (TWITCH_TOKEN, BOT_NAME, GEMINI_API_KEY)
data.db            # SQLiteデータベース (自動生成)
```

## 起動方法

```bash
npm start  # node server.js — デフォルト http://localhost:3000
```

## 環境変数 (.env)

| 変数 | 説明 |
|------|------|
| `TWITCH_TOKEN` | Twitch OAuth トークン (`oauth:...`) |
| `BOT_NAME` | Twitch bot ユーザー名 |
| `GEMINI_API_KEY` | Google Gemini API キー |
| `OPENAI_API_KEY` | OpenAI API キー (Whisper文字起こし用) |
| `PORT` | サーバーポート (デフォルト: 3000) |

## アーキテクチャ

- サーバーは一度に1つのTwitchチャンネルに接続する (シングルチャンネル)
- Socket.IOでブラウザとリアルタイム通信
- チャットメッセージはSQLiteに保存される (翻訳の文脈用)
- 接続したチャンネル名はSQLiteに保存され、Web UIでサジェスト候補として表示される
- 非日本語メッセージはGemini 3 Flashで日本語に翻訳 (非同期・ノンブロッキング)
- 翻訳時に直近20件のチャット履歴を文脈として送信

## DB スキーマ

### channels テーブル
| カラム | 型 | 説明 |
|--------|-----|------|
| `name` | TEXT (PK) | チャンネル名 |
| `last_connected_at` | TEXT | 最終接続日時 (ISO 8601) |

### messages テーブル
| カラム | 型 | 説明 |
|--------|-----|------|
| `id` | INTEGER (PK, AUTO) | メッセージID |
| `channel` | TEXT | チャンネル名 |
| `username` | TEXT | ユーザー名 |
| `message` | TEXT | メッセージ本文 |
| `timestamp` | TEXT | 送信日時 (ISO 8601) |

## Socket.IO イベント

### クライアント → サーバー
- `join-channel` (channel: string) — チャンネルに接続
- `leave-channel` — チャンネルから切断
### サーバー → クライアント
- `current-channel` (channel) — 接続中のチャンネル (再接続時)
- `channel-joined` (channel) — 接続成功
- `channel-left` — 切断完了
- `channel-error` (message) — 接続エラー
- `chat-message` ({id, channel, username, message, timestamp}) — チャットメッセージ
- `chat-translation` ({id, translation}) — 翻訳結果 (元メッセージのidに紐づく)
- `channel-list` (string[]) — 保存済みチャンネル候補一覧
- `transcription` ({text, timestamp}) — 音声文字起こし結果

## コーディング規約

- UI テキストは日本語
- CommonJS (`require`) を使用、ES Modules は使わない
- フロントエンドはフレームワーク不使用 (Vanilla JS)
- 新しいnpmパッケージを追加する場合は最小限にする
