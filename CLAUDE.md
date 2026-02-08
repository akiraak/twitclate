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
server.js              # エントリポイント (Express + Socket.IO + TMI の配線層)
lib/db.js              # SQLite スキーマ + prepared statements
lib/audio.js           # 音声ユーティリティ (createWavBuffer, calcRMS)
lib/translator.js      # Gemini翻訳 (チャット・文字起こし・手動の3種 + 文脈構築)
lib/transcription.js   # Transcriberクラス (VAD・Whisper・プロセス管理・リトライ)
public/index.html      # Web UI (HTML/CSS/JS一体型)
.env                   # 環境変数 (TWITCH_TOKEN, BOT_NAME, GEMINI_API_KEY, OPENAI_API_KEY)
data.db                # SQLiteデータベース (自動生成)
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
- 翻訳時に直近5分以内のチャット履歴(最大20件)と配信者発言(最大10件)を文脈として送信
- チャンネル接続時に自動で音声文字起こしを開始 (streamlink → ffmpeg → Whisper API)
- 音声はVAD (Voice Activity Detection) で発話区間を検出し、動的に1〜15秒のチャンクに分割
- 連続する文字起こし結果は1.5秒のデバウンスで結合してから翻訳に送信
- Whisper APIへの同時リクエストはセマフォで最大2に制限
- streamlink/ffmpegのエラー時は指数バックオフで最大5回自動リトライ
- チャットTTS読み上げの重複排除: 直近30秒のチャットと文字起こしをバイグラム類似度で比較し、TTS読み上げと判定されたものはスキップ
- 文字起こし結果はSQLiteに保存され、Geminiで翻訳 (日本語 → 英語 / その他 → 日本語)
- Web UIは単一タイムライン構成 (チャットと配信者の発言を時系列で表示、配信者表示ON/OFF切替可)
- 画面下部に手動翻訳エリア (日本語 → 英語 / その他 → 日本語)

## モジュール設計

- **server.js**: エントリポイント。モジュールの初期化、Socket.IO/TMIイベントの配線、TTS読み上げ検出ロジック
- **lib/db.js**: DBスキーマ定義とprepared statementsのエクスポート。他モジュールから `require` して使用
- **lib/audio.js**: 純粋関数 (`createWavBuffer`, `calcRMS`)。外部依存なし
- **lib/translator.js**: `createTranslator(ai)` ファクトリで生成。`buildContext()` で文脈構築を共通化。翻訳結果の文字列を返すだけでSocket.IOに依存しない
- **lib/transcription.js**: `Transcriber` クラス。VAD状態・Whisperセマフォ・リトライ状態をインスタンスにカプセル化。`onTranscription`/`onStopped` コールバックで server.js と疎結合

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

### transcriptions テーブル
| カラム | 型 | 説明 |
|--------|-----|------|
| `id` | INTEGER (PK, AUTO) | 文字起こしID |
| `channel` | TEXT | チャンネル名 |
| `message` | TEXT | 文字起こし本文 |
| `timestamp` | TEXT | 日時 (ISO 8601) |

## Socket.IO イベント

### クライアント → サーバー
- `join-channel` (channel: string) — チャンネルに接続
- `leave-channel` — チャンネルから切断
- `toggle-transcription` (enabled: boolean) — 配信者文字起こしのON/OFF切替
- `manual-translate` (text: string) — 手動翻訳リクエスト

### サーバー → クライアント
- `current-channel` (channel) — 接続中のチャンネル (再接続時)
- `channel-joined` (channel) — 接続成功
- `channel-left` — 切断完了
- `channel-error` (message) — 接続エラー
- `chat-message` ({id, channel, username, message, timestamp}) — チャットメッセージ
- `chat-translation` ({id, translation}) — 翻訳結果 (元メッセージのidに紐づく)
- `channel-list` (string[]) — 保存済みチャンネル候補一覧
- `transcription` ({id, text, timestamp}) — 音声文字起こし結果
- `transcription-translation` ({id, translation}) — 文字起こしの翻訳結果
- `transcription-stopped` — 文字起こしリトライ上限到達による停止通知
- `manual-translate-result` (translation: string) — 手動翻訳結果

## コーディング規約

- UI テキストは日本語
- CommonJS (`require`) を使用、ES Modules は使わない
- フロントエンドはフレームワーク不使用 (Vanilla JS)
- 新しいnpmパッケージを追加する場合は最小限にする
