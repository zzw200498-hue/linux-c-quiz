/**
 * Electron 主进程：把「题库服务 + 网页界面」塞进一个真正的桌面窗口里。
 *
 * 工作方式：
 *   1. 先确定题库目录（bank 所在的文件夹）
 *   2. 在主进程里直接 require 内置服务（server.cjs），监听 127.0.0.1 的随机空闲端口
 *   3. 开一个无边框窗口（红黄绿灯画在页面里），加载这个本地地址
 *
 * 这样不用外挂 node、不用借用浏览器，双击 exe 就是一个独立 App。
 */
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');

/**
 * 默认题库目录：
 *   1) 优先读环境变量 QUIZ_WS（方便自己指定）
 *   2) 否则取本仓库根目录下的 bank（开发模式直接可用）
 * 打包成 exe 后这个路径不存在，于是会弹窗让用户自己选工作区。
 */
const DEFAULT_WS = process.env.QUIZ_WS || path.join(__dirname, '..', '..', 'bank');

let mainWindow = null;
let workspace = '';
let port = 0;

/* ---------------- 启动日志（排错用） ---------------- */

function startupLog(msg) {
  try {
    const file = path.join(app.getPath('userData'), 'startup.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch {
    /* 日志写不了就算了，不能因为它把 App 拖崩 */
  }
}
const origLog = console.log;
console.log = (...a) => {
  startupLog(a.map(String).join(' '));
  origLog(...a);
};
process.on('uncaughtException', (e) => {
  startupLog('uncaughtException: ' + (e && e.stack ? e.stack : e));
  try {
    dialog.showErrorBox('程序出错了', String(e && e.stack ? e.stack : e));
  } catch {
    /* 对话框也起不来的话，至少日志里有 */
  }
});

/* ---------------- 题库目录（工作区）解析 ---------------- */

function wsConfigFile() {
  return path.join(app.getPath('userData'), 'quiz-ws.json');
}

function resolveWorkspace() {
  // 1) 命令行：LinuxCQuiz.exe --ws="D:\my-bank"
  const arg = process.argv.find((a) => a.startsWith('--ws='));
  if (arg) return arg.slice(5);
  // 2) 环境变量
  if (process.env.QUIZ_WS) return process.env.QUIZ_WS;
  // 3) 上次选择过的（记在 Electron 的用户数据目录）
  try {
    const j = JSON.parse(fs.readFileSync(wsConfigFile(), 'utf8'));
    // 只认「工作区根」：旧版本可能缓存了往里探过一层的路径，这里自动纠正
    if (j && j.ws && fs.existsSync(j.ws)) {
      if (isWorkspaceRoot(j.ws)) return j.ws;
      const up = path.dirname(j.ws);
      if (isWorkspaceRoot(up)) {
        saveWorkspace(up);
        return up;
      }
      return j.ws;
    }
  } catch {
    /* 没选过就继续往下 */
  }
  // 4) 默认工作区
  if (fs.existsSync(DEFAULT_WS)) return DEFAULT_WS;
  return '';
}

function saveWorkspace(ws) {
  try {
    fs.mkdirSync(path.dirname(wsConfigFile()), { recursive: true });
    fs.writeFileSync(wsConfigFile(), JSON.stringify({ ws }, null, 2), 'utf8');
  } catch (e) {
    console.warn('[electron] 保存工作区失败', e);
  }
}

/**
 * 判断目录是不是「工作区根」。
 *
 * 关键：工作区根 = .vscode / .quiz 所在的那一层（settings.json 在这里，
 * 里面的 quiz.bankPath 再指向真正的 yaml 目录）。不要把工作区根往下探一层，
 * 否则服务端再拼一次 bankPath 就会多套一层目录，导致一张卷子都读不到。
 */
function isWorkspaceRoot(dir) {
  return fs.existsSync(path.join(dir, '.vscode')) || fs.existsSync(path.join(dir, '.quiz'));
}

/** 目录里有没有 yaml 试卷（用来给用户提示选错了） */
function hasYaml(dir) {
  try {
    return fs.readdirSync(dir).some((n) => /\.ya?ml$/i.test(n));
  } catch {
    return false;
  }
}

async function askWorkspace() {
  const r = await dialog.showOpenDialog({
    title: '选择题库工作区目录（bank 文件夹，里面有 .vscode / .quiz）',
    defaultPath: DEFAULT_WS,
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths.length) return '';

  let dir = r.filePaths[0];
  // 用户如果选到了 yaml 所在的那一层（工作区根/bank），往上退一层回到工作区根
  if (!isWorkspaceRoot(dir) && isWorkspaceRoot(path.dirname(dir))) {
    dir = path.dirname(dir);
  }
  if (!isWorkspaceRoot(dir)) {
    const ok = dialog.showMessageBoxSync({
      type: 'warning',
      title: '这个目录看起来不对',
      message: `这里没有 .vscode 或 .quiz 目录：\n${dir}\n\n继续用它会读不到题库和作答记录。`,
      buttons: ['仍然使用', '重新选择'],
      defaultId: 1,
      cancelId: 1,
    });
    if (ok === 1) return askWorkspace();
  }
  saveWorkspace(dir);
  return dir;
}

/* ---------------- 内置服务 ---------------- */

function pickPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function startServer() {
  // server.cjs 会读这两个环境变量（与 node 直跑模式一致）
  process.env.QUIZ_WS = workspace;
  process.env.QUIZ_PORT = String(port);
  require(path.join(__dirname, 'app', 'server.cjs'));
}

/* ---------------- 窗口 ---------------- */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 1000,
    minHeight: 660,
    frame: false, // 用页面里的红黄绿灯，做出 mac 窗口的感觉
    backgroundColor: '#eef0f3',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 页面内的外链用系统浏览器打开，别把 App 窗口顶掉
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`).catch((e) => {
    dialog.showErrorBox('界面加载失败', String(e && e.message ? e.message : e));
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/* ---------------- 进程控制 ---------------- */

const gotLock = app.requestSingleInstanceLock();
startupLog(`=== 启动 === argv=${process.argv.join(' ')} lock=${gotLock}`);
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    // 工作区：解析不到就问用户
    workspace = resolveWorkspace();
    if (!workspace || !isWorkspaceRoot(workspace)) workspace = await askWorkspace();
    if (!workspace) {
      dialog.showErrorBox('没有选择题库目录', 'App 需要知道 bank 文件夹在哪，重新启动后再选一次。');
      app.quit();
      return;
    }

    port = await pickPort();
    startupLog(`工作区：${workspace}`);
    try {
      startServer();
      startupLog(`服务已启动：http://127.0.0.1:${port}`);
    } catch (e) {
      dialog.showErrorBox('题库服务启动失败', String(e && e.stack ? e.stack : e));
      app.quit();
      return;
    }

    ipcMain.handle('quiz:ws', () => workspace);
    ipcMain.on('quiz:min', () => mainWindow && mainWindow.minimize());
    ipcMain.on('quiz:max', () => {
      if (!mainWindow) return;
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    });
    ipcMain.on('quiz:close', () => mainWindow && mainWindow.close());
    ipcMain.handle('quiz:open-ws', async () => {
      const dir = await askWorkspace();
      if (dir) {
        workspace = dir;
        saveWorkspace(dir);
        if (mainWindow) mainWindow.webContents.reload();
      }
      return dir;
    });

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  app.quit();
});
