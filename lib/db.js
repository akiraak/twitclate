const Database = require("better-sqlite3");
const path = require("path");

const dbPath = process.env.TWITCH_TRANSLATOR_DB_PATH
  || path.join(__dirname, "..", "data.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS channels (
    name TEXT PRIMARY KEY,
    last_connected_at TEXT NOT NULL
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    username TEXT NOT NULL,
    message TEXT NOT NULL,
    timestamp TEXT NOT NULL
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS transcriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    message TEXT NOT NULL,
    timestamp TEXT NOT NULL
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

module.exports = {
  db,
  upsertChannel: db.prepare(`
    INSERT INTO channels (name, last_connected_at) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET last_connected_at = excluded.last_connected_at
  `),
  getChannels: db.prepare(
    `SELECT name FROM channels ORDER BY last_connected_at DESC`
  ),
  insertMessage: db.prepare(
    `INSERT INTO messages (channel, username, message, timestamp) VALUES (?, ?, ?, ?)`
  ),
  getRecentMessages: db.prepare(
    `SELECT username, message FROM messages WHERE channel = ? AND timestamp > ? ORDER BY id DESC LIMIT 20`
  ),
  insertTranscription: db.prepare(
    `INSERT INTO transcriptions (channel, message, timestamp) VALUES (?, ?, ?)`
  ),
  getRecentTranscriptions: db.prepare(
    `SELECT message FROM transcriptions WHERE channel = ? AND timestamp > ? ORDER BY id DESC LIMIT 10`
  ),
  getSetting: db.prepare(
    `SELECT value FROM settings WHERE key = ?`
  ),
  upsertSetting: db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
};
