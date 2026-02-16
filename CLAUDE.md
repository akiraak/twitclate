# Twitclate

Twitchチャットをリアルタイムで監視し、非日本語コメントをAIで日本語訳するWebアプリケーション。

## 技術スタック

- **Runtime:** Node.js (CommonJS)
- **Web:** Express v5 + Socket.IO v4
- **Twitch接続:** tmi.js (IRC経由)
- **DB:** SQLite (better-sqlite3) — `data.db` に保存 (Electron では userData ディレクトリ)
- **AI翻訳:** Google Gemini 3 Flash (`gemini-3-flash-preview`, @google/genai)
- **音声文字起こし:** Twitch GQL API + ffmpeg + OpenAI Whisper API (`gpt-4o-mini-transcribe`)
- **フロントエンド:** Vanilla HTML/CSS/JS (public/index.html 単一ファイル)

## プロジェクト構成

```
server.js              # エントリポイント (Express + Socket.IO + TMI の配線層)
electron.js            # Electron メインプロセス (ウィンドウ管理・DBパス設定・ログ出力)
lib/db.js              # SQLite スキーマ + prepared statements
lib/audio.js           # 音声ユーティリティ (createWavBuffer, calcRMS)
lib/translator.js      # Gemini翻訳 (チャット・文字起こし・手動・トピック要約・ムード分析 + 文脈構築)
lib/transcription.js   # Transcriberクラス (VAD・Whisper・プロセス管理・リトライ)
lib/twitch-hls.js      # Twitch HLS URL取得 (GQL API + Usher API)
public/index.html      # Web UI (HTML/CSS/JS一体型、設定モーダル含む)
docs/index.html        # ダウンロードサイト (GitHub Pages、日英対応)
.github/workflows/release.yml  # リリース自動化 (GitHub Actions)
data.db                # SQLiteデータベース (自動生成)
```

## 起動方法

```bash
npm start  # node server.js — デフォルト http://localhost:3000
```

## 設定管理

APIキー等の設定はWeb UI上の設定モーダルから入力し、SQLite の `settings` テーブルに保存される。
dotenv / `.env` ファイルは使用しない。

| 設定キー | 説明 |
|----------|------|
| `TWITCH_TOKEN` | Twitch OAuth トークン (`oauth:...`) |
| `BOT_NAME` | Twitch bot ユーザー名 |
| `GEMINI_API_KEY` | Google Gemini API キー |
| `OPENAI_API_KEY` | OpenAI API キー (Whisper文字起こし用) |

環境変数 `PORT` でサーバーポートを変更可能 (デフォルト: 3000)。
環境変数 `TWITCLATE_DB_PATH` で DB ファイルパスを変更可能 (Electron では userData に自動設定)。

## アーキテクチャ

- サーバーは一度に1つのTwitchチャンネルに接続する (シングルチャンネル)
- Socket.IOでブラウザとリアルタイム通信
- チャットメッセージはSQLiteに保存される (翻訳の文脈用)
- 接続したチャンネル名はSQLiteに保存され、Web UIでサジェスト候補として表示される
- 翻訳の基準言語はUIから選択可能 (デフォルト: 日本語)。選択した言語 → 英語 / その他 → 選択言語 に翻訳
- 非日本語メッセージはGemini 3 Flashで翻訳 (非同期・ノンブロッキング)
- 翻訳時に直近5分以内のチャット履歴(最大20件)と配信者発言(最大10件)を文脈として送信
- チャンネル接続時に自動で音声文字起こしを開始 (Twitch GQL API → ffmpeg → Whisper API)
- 音声はVAD (Voice Activity Detection) で発話区間を検出し、動的に1〜15秒のチャンクに分割
- 連続する文字起こし結果は1.5秒のデバウンスで結合してから翻訳に送信
- Whisper APIへの同時リクエストはセマフォで最大2に制限
- 起動時に外部コマンド (ffmpeg) の存在をチェックし、不足時はエラーメッセージを表示して終了
- APIキー等の設定はWeb UIの設定モーダルから入力し、SQLiteに保存。設定が揃うとAIクライアントを遅延初期化
- HLS URL取得失敗/ffmpegのエラー時は指数バックオフで最大5回自動リトライ
- チャットTTS読み上げの重複排除: 直近30秒のチャットと文字起こしをバイグラム類似度で比較し、TTS読み上げと判定されたものはスキップ
- 文字起こしのハルシネーション防止: 定型的な誤認識フレーズ (「ご視聴ありがとうございました」等) をブラックリストで除外
- 文字起こし結果はSQLiteに保存され、Geminiで翻訳 (選択言語 → 英語 / その他 → 選択言語)
- Web UIは2ペインレイアウト: 左にタイムライン (チャットと配信者の発言を時系列で表示、配信者表示ON/OFF切替可)、右にサイドバー (トピック要約・アナリティクス・手動翻訳エリア等)
- チャットトピック自動要約: 20秒間隔で直近5分の会話を分析し、トピックを箇条書きでサイドバーに表示。5件以上の新メッセージで即時実行。前回と同じ内容は送信しない。履歴はタイムスタンプ付きで蓄積表示
- ムード分析: 30秒間隔で直近5分の会話をGeminiで分析し、配信者テンション・視聴者テンション・チャット雰囲気を1-10スケールで評価。8件以上の新メッセージで即時実行。トピック要約と同じタイマーパターン
- アナリティクスUI: メッセージ頻度グラフ (Canvas、直近5分/15秒バケット)、チャット速度 (msg/min)、盛り上がり度メーター、雰囲気メーターをサイドバーに表示。頻度グラフとチャット速度はクライアントサイドで5秒ごとに更新
- 待機時はタイムラインを暗転させてプレースホルダーを表示

## モジュール設計

- **server.js**: エントリポイント。起動時のffmpegチェック、設定に基づくAIクライアントの遅延初期化、Socket.IO/TMIイベントの配線、TTS読み上げ検出ロジック、トピック要約タイマー管理、ムード分析タイマー管理、設定管理イベント
- **lib/db.js**: DBスキーマ定義とprepared statementsのエクスポート。他モジュールから `require` して使用
- **lib/audio.js**: 純粋関数 (`createWavBuffer`, `calcRMS`)。外部依存なし
- **lib/translator.js**: `createTranslator(ai)` ファクトリで生成。`buildContext()` で文脈構築を共通化。翻訳結果の文字列を返すだけでSocket.IOに依存しない。`langCode` 引数で翻訳方向を動的に切替。`correctTranscription()` で文字起こしの誤認識補正、`summarizeTopic()` でチャットトピック要約、`analyzeMood()` でムード分析 (配信者テンション・視聴者テンション・雰囲気をJSON形式で返却) も担当
- **lib/twitch-hls.js**: `getTwitchAudioUrl(channel)` で Twitch GQL API + Usher API から HLS audio_only URL を取得。外部依存なし (Node.js fetch のみ)
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

### settings テーブル
| カラム | 型 | 説明 |
|--------|-----|------|
| `key` | TEXT (PK) | 設定キー |
| `value` | TEXT | 設定値 |

## Socket.IO イベント

### クライアント → サーバー
- `join-channel` (channel: string) — チャンネルに接続
- `leave-channel` — チャンネルから切断
- `toggle-transcription` (enabled: boolean) — 配信者文字起こしのON/OFF切替
- `set-language` (lang: string) — 翻訳基準言語の変更 (ja, en, ko, zh, es, pt, fr, de, ru, th, tr, it, pl, ar, id, vi, uk, nl, sv, cs, hi, ms)
- `manual-translate` (text: string) — 手動翻訳リクエスト
- `get-settings` — マスク済み設定を要求
- `save-settings` ({TWITCH_TOKEN, BOT_NAME, GEMINI_API_KEY, OPENAI_API_KEY}) — 設定保存 + 再初期化
- `clear-all-data` — 全データ削除 (設定・チャンネル履歴・メッセージ・文字起こし)

### サーバー → クライアント
- `current-channel` (channel) — 接続中のチャンネル (再接続時)
- `channel-joined` (channel) — 接続成功
- `channel-left` — 切断完了
- `channel-error` (message) — 接続エラー
- `chat-message` ({id, channel, username, message, timestamp}) — チャットメッセージ
- `chat-translation` ({id, translation}) — 翻訳結果 (元メッセージのidに紐づく)
- `channel-list` (string[]) — 保存済みチャンネル候補一覧
- `current-language` (lang: string) — 現在の翻訳基準言語
- `transcription` ({id, text, timestamp}) — 音声文字起こし結果
- `transcription-corrected` ({id, corrected}) — Geminiによる文字起こし補正結果
- `transcription-translation` ({id, translation}) — 文字起こしの翻訳結果
- `transcription-stopped` — 文字起こしリトライ上限到達による停止通知
- `manual-translate-result` (translation: string) — 手動翻訳結果
- `settings-status` ({configured: boolean, settings: object}) — 設定状態 (接続時 + 保存後に送信)
- `settings-data` (object) — マスク済み設定値 (get-settings の応答)
- `topic-summary` (summary: string) — チャットトピック要約 (箇条書きテキスト)
- `topic-summary-cleared` — トピック要約クリア通知
- `mood-analysis` ({streamer_tension, viewer_tension, atmosphere}) — ムード分析結果 (各1-10)
- `mood-analysis-cleared` — ムード分析メーターリセット
- `error-log` ({message, timestamp}) — 処理失敗時のエラーログ (翻訳・文字起こし・要約・ムード分析等)
- `settings-error` (message: string) — 設定エラーメッセージ
- `data-cleared` — 全データ削除完了通知

## リリース

- `v*` タグの push で GitHub Actions が Windows 向けビルドを実行し、GitHub Releases に自動公開
- `package.json` の `build.publish` に `{ "provider": "github" }` を設定済み (electron-builder が `GH_TOKEN` で Releases にアップロード)
- ダウンロードサイト: `docs/index.html` (GitHub Pages、日英対応。GitHub API から最新リリースの exe URL を動的取得)

## コーディング規約

- UI テキストは日本語
- CommonJS (`require`) を使用、ES Modules は使わない
- フロントエンドはフレームワーク不使用 (Vanilla JS)
- 新しいnpmパッケージを追加する場合は最小限にする

## タスク管理

- `TODO.md` — 未着手の開発タスク・改善案
- `DONE.md` — 実装済み機能の一覧 (バージョン別)
- **コミット前に必ず TODO.md と DONE.md を更新すること** — 実装した機能を DONE.md に追記し、該当タスクを TODO.md から削除する
