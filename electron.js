const { app, BrowserWindow, Menu, dialog } = require("electron");
const path = require("path");
const fs = require("fs");

// ログファイルを userData ディレクトリに出力
const logPath = path.join(app.getPath("userData"), "app.log");
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(logPath, line);
}

// stdout/stderr もログファイルに転送
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);
process.stdout.write = (chunk, ...args) => {
  log(`[stdout] ${chunk.toString().trimEnd()}`);
  return origStdoutWrite(chunk, ...args);
};
process.stderr.write = (chunk, ...args) => {
  log(`[stderr] ${chunk.toString().trimEnd()}`);
  return origStderrWrite(chunk, ...args);
};

process.on("uncaughtException", (err) => {
  log(`[uncaughtException] ${err.stack || err}`);
  dialog.showErrorBox("エラー", `${err.message}\n\nログ: ${logPath}`);
  app.exit(1);
});

log(`app starting — logPath=${logPath}`);
log(`process.resourcesPath=${process.resourcesPath}`);
log(`__dirname=${__dirname}`);

let mainWindow = null;

async function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  Menu.setApplicationMenu(null);

  mainWindow.loadURL(`http://localhost:${port}`);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.on("ready", async () => {
  try {
    log("app ready — loading server");
    process.env.TWITCH_TRANSLATOR_DB_PATH = path.join(app.getPath("userData"), "data.db");
    log(`DB path: ${process.env.TWITCH_TRANSLATOR_DB_PATH}`);
    const { startServer } = require("./server");
    log("server module loaded");
    const port = await startServer();
    log(`server started on port ${port}`);
    createWindow(port);
  } catch (err) {
    log(`[startup error] ${err.stack || err}`);
    dialog.showErrorBox("起動エラー", `${err.message}\n\nログ: ${logPath}`);
    app.exit(1);
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
