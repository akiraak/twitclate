# Twitch Translator

Twitchチャットをリアルタイムで監視し、非日本語コメントをAIで自動翻訳するアプリケーションです。
配信者の音声をリアルタイムで文字起こし・翻訳する機能も搭載しています。

## 機能

- Twitchチャットのリアルタイム表示
- 非日本語コメントをGemini 3 Flashで自動翻訳
- 翻訳の基準言語をUIから選択可能 (22言語対応: 日本語・英語・韓国語・中国語・スペイン語・ポルトガル語・フランス語・ドイツ語・ロシア語・タイ語・トルコ語・イタリア語・ポーランド語・アラビア語・インドネシア語・ベトナム語・ウクライナ語・オランダ語・スウェーデン語・チェコ語・ヒンディー語・マレー語)
- 配信者の音声をリアルタイムで文字起こし (OpenAI Whisper API)
- VADベースの発話区間検出で高精度な音声分割
- 配信者の発言を自動翻訳 (選択言語 → 英語 / その他 → 選択言語)
- 過去の会話と配信者の発言を考慮した文脈のある翻訳
- 文字起こしプロセスのエラー時に自動リトライ
- チャットTTS読み上げの重複排除 (バイグラム類似度による自動検出)
- チャットと配信者の発言を時系列で表示 (配信者表示ON/OFF切替可)
- 手動翻訳機能 (右サイドバー、選択言語 → 英語 / その他 → 選択言語)
- 接続チャンネル履歴のサジェスト表示
- Web UIから設定可能 (APIキー等はSQLiteに保存)
- Electronデスクトップアプリとしても動作

## セットアップ

```bash
npm install
```

## 起動

```bash
npm start
```

http://localhost:3000 を開き、初回起動時に表示される設定モーダルでAPIキーを入力します。

| 設定項目 | 説明 | 取得先 |
|----------|------|--------|
| Twitch OAuth トークン | `oauth:` 付きトークン | https://twitchapps.com/tmi/ |
| Twitch Bot ユーザー名 | あなたのTwitchアカウント名 | — |
| Gemini API キー | Google Gemini API キー | https://aistudio.google.com/apikey |
| OpenAI API キー | Whisper文字起こし用 | https://platform.openai.com/api-keys |

設定はSQLiteに保存され、次回起動時に自動で読み込まれます。

## ダウンロード

[ダウンロードページ](https://akiraak.github.io/twitch-translator/) から最新の Windows 版インストーラーを取得できます。

## Electron デスクトップアプリ

```bash
# 開発時
npm run electron

# Windows向けビルド
npm run dist:win
```

ビルドされたアプリでは設定がユーザーデータディレクトリに保存されます。

## リリース

`v*` タグを push すると GitHub Actions が自動で Windows 向けビルドを実行し、GitHub Releases に公開します。

```bash
git tag v1.0.0
git push origin v1.0.0
```

## プロジェクト構成

```
server.js              # エントリポイント (Express + Socket.IO + TMI の配線層)
electron.js            # Electron メインプロセス (ウィンドウ管理・DBパス設定・ログ出力)
lib/db.js              # SQLite スキーマ + クエリ
lib/audio.js           # 音声ユーティリティ (WAV変換, RMS計算)
lib/translator.js      # Gemini翻訳 (チャット・文字起こし・手動)
lib/transcription.js   # 文字起こしパイプライン (VAD・Whisper・リトライ)
lib/twitch-hls.js      # Twitch HLS URL取得 (GQL API + Usher API)
public/index.html      # Web UI (設定モーダル含む)
docs/index.html        # ダウンロードサイト (GitHub Pages)
.github/workflows/release.yml  # リリース自動化 (GitHub Actions)
```

## 技術スタック

- Node.js / Express v5 / Socket.IO v4
- Electron (デスクトップアプリ)
- tmi.js (Twitch IRC)
- SQLite (better-sqlite3)
- Google Gemini 3 Flash (`gemini-3-flash-preview`, @google/genai)
- OpenAI Whisper API (`gpt-4o-mini-transcribe`, 音声文字起こし)
- Twitch GQL API + ffmpeg (配信音声取得)
