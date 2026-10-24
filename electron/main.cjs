/**
 * MD Studio · Electron 主进程
 *
 * 关键点：
 * 1. 用自定义协议 mdstudio://app/ 加载 dist/ —— origin 固定，IndexedDB 才能持久
 * 2. mdstudio://local/<绝对路径> 直接服务磁盘文件，图片不需要读进内存
 * 3. fs.watch 递归监听工作区，外部改动主动推给渲染进程
 * 4. macOS 的 open-file 事件 → Finder 里双击 md 直接打开
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");

const DIST = path.join(__dirname, "..", "dist");
const DEV_URL = process.env.MD_DEV;
const DEV_URL_FALLBACK = "http://localhost:5274/";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "mdstudio",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: false,
    },
  },
]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
};

const MEDIA_EXT = /\.(png|jpe?g|gif|svg|webp|avif|bmp|ico|pdf|mp4|webm|mov|mp3|wav|woff2?)$/i;

function mimeOf(p) {
  return MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream";
}

/* ---------------- 协议：app 资源 + 本地文件 ---------------- */

function registerProtocol() {
  protocol.handle("mdstudio", async (req) => {
    const url = new URL(req.url);

    // mdstudio://local/<绝对路径>  →  直接读磁盘
    // 只放行媒体类型：Markdown 里能塞任意 <img src>，不限制的话
    // 等于给渲染层开了"读任意本地文件"的口子
    if (url.host === "local") {
      const abs = decodeURIComponent(url.pathname);
      if (!MEDIA_EXT.test(abs)) {
        return new Response("Forbidden", { status: 403 });
      }
      try {
        const data = await fsp.readFile(abs);
        return new Response(data, {
          headers: { "content-type": mimeOf(abs), "cache-control": "no-cache" },
        });
      } catch {
        return new Response("Not Found", { status: 404 });
      }
    }

    // mdstudio://app/...  →  dist/
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    const full = path.normalize(path.join(DIST, rel));
    if (!full.startsWith(DIST + path.sep) && full !== DIST) {
      return new Response("Forbidden", { status: 403 });
    }
    try {
      const data = await fsp.readFile(full);
      return new Response(data, {
        headers: {
          "content-type": mimeOf(full),
          "cache-control": path.extname(full) === ".html" ? "no-cache" : "no-cache",
        },
      });
    } catch {
      try {
        const idx = await fsp.readFile(path.join(DIST, "index.html"));
        return new Response(idx, { headers: { "content-type": "text/html; charset=utf-8" } });
      } catch {
        return new Response("dist/ 不存在，请先 npm run build", { status: 404 });
      }
    }
  });
}

/* ---------------- 文件监听 ---------------- */

let watcher = null;
let watchTimer = null;
const pendingChanges = new Set();

function startWatch(win, root) {
  stopWatch();
  const onChange = (_ev, filename) => {
    if (!filename) return;
    const abs = path.join(root, filename.toString());
    const segs = filename.toString().split(path.sep);
    if (segs.some((s) => s.startsWith(".") || s === "node_modules")) return;
    pendingChanges.add(abs);
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      const files = [...pendingChanges];
      pendingChanges.clear();
      if (win && !win.isDestroyed()) win.webContents.send("fs:changed", { root, files });
    }, 220);
  };

  try {
    watcher = fs.watch(root, { recursive: true }, onChange);
  } catch {
    // Linux 上 recursive 不被支持：退化成只监听顶层
    try {
      watcher = fs.watch(root, onChange);
    } catch (e) {
      console.error("watch failed", e);
    }
  }
}

function stopWatch() {
  if (watcher) {
    try {
      watcher.close();
    } catch {
      /* ignore */
    }
    watcher = null;
  }
  clearTimeout(watchTimer);
}

/* ---------------- IPC：文件系统 ---------------- */

function isMd(name) {
  return /\.(md|markdown|mdx|txt)$/i.test(name);
}

function registerIpc() {
  ipcMain.handle("dialog:dir", async () => {
    const r = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "选择 Markdown 文件夹",
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle("dialog:file", async () => {
    const r = await dialog.showOpenDialog({
      properties: ["openFile"],
      title: "打开 Markdown 文件",
      filters: [
        { name: "Markdown", extensions: ["md", "markdown", "mdx", "txt"] },
        { name: "全部文件", extensions: ["*"] },
      ],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle("dialog:save", async (_e, defaultName) => {
    const r = await dialog.showSaveDialog({
      title: "新建 Markdown 文档",
      defaultPath: defaultName || "未命名.md",
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "markdown"] }],
    });
    return r.canceled ? null : r.filePath;
  });

  ipcMain.handle("fs:listdir", async (_e, dir) => {
    const out = [];
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) out.push({ name: e.name, kind: "directory" });
      else if (e.isFile() && isMd(e.name)) out.push({ name: e.name, kind: "file" });
    }
    return out;
  });

  ipcMain.handle("fs:read", async (_e, p) => fsp.readFile(p, "utf8"));

  ipcMain.handle("fs:write", async (_e, p, text) => {
    await fsp.writeFile(p, text, "utf8");
    return true;
  });

  ipcMain.handle("fs:stat", async (_e, p) => {
    const st = await fsp.stat(p);
    return { size: st.size, lastModified: st.mtimeMs, isDirectory: st.isDirectory() };
  });

  ipcMain.handle("fs:exists", async (_e, p) => {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle("fs:mkdirp", async (_e, p) => {
    await fsp.mkdir(p, { recursive: true });
    return true;
  });

  ipcMain.handle("fs:create", async (_e, dir, name) => {
    const full = path.join(dir, name);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, "", { flag: "wx" }).catch(async (err) => {
      if (err.code === "EEXIST") return; // 已存在就不覆盖
      throw err;
    });
    return full;
  });

  ipcMain.handle("fs:remove", async (_e, p) => {
    await fsp.rm(p, { recursive: true, force: true });
    return true;
  });

  ipcMain.handle("fs:watch", async (e, root) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    startWatch(win, root);
    return true;
  });

  ipcMain.handle("fs:unwatch", async () => {
    stopWatch();
    return true;
  });

  ipcMain.handle("app:info", async () => ({
    version: app.getVersion(),
    platform: process.platform,
    home: app.getPath("home"),
  }));

  ipcMain.handle("shell:reveal", async (_e, p) => {
    shell.showItemInFolder(p);
    return true;
  });

  ipcMain.handle("shell:openExternal", async (_e, url) => {
    if (/^https?:/i.test(url)) await shell.openExternal(url);
    return true;
  });
}

/* ---------------- 窗口 ---------------- */

let mainWindow = null;
let pendingOpenPath = null;

function createWindow() {
  const isMac = process.platform === "darwin";

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#fbfaf8",
    titleBarStyle: isMac ? "hiddenInset" : "default",
    trafficLightPosition: isMac ? { x: 14, y: 15 } : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());

  const target = DEV_URL ? DEV_URL_FALLBACK : "mdstudio://app/";
  mainWindow.loadURL(target);

  if (DEV_URL) mainWindow.webContents.openDevTools({ mode: "detach" });

  // Finder 双击进来的文件
  mainWindow.webContents.on("did-finish-load", () => {
    if (pendingOpenPath) {
      mainWindow.webContents.send("app:openFile", pendingOpenPath);
      pendingOpenPath = null;
    }
  });

  // 外部链接走系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    stopWatch();
  });
}

/* ---------------- 菜单 ---------------- */

function buildMenu() {
  const isMac = process.platform === "darwin";
  const send = (ch) => () => mainWindow?.webContents.send(ch);

  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about", label: "关于 MD Studio" },
              { type: "separator" },
              { role: "hide", label: "隐藏" },
              { role: "hideOthers", label: "隐藏其他" },
              { type: "separator" },
              { role: "quit", label: "退出 MD Studio" },
            ],
          },
        ]
      : []),
    {
      label: "文件",
      submenu: [
        { label: "新建文档…", accelerator: "CmdOrCtrl+N", click: send("menu:newDoc") },
        { label: "打开文件…", accelerator: "CmdOrCtrl+O", click: send("menu:openFile") },
        { label: "打开文件夹…", accelerator: "Shift+CmdOrCtrl+O", click: send("menu:openFolder") },
        { type: "separator" },
        { label: "保存", accelerator: "CmdOrCtrl+S", click: send("menu:save") },
        { label: "导出 HTML…", accelerator: "Shift+CmdOrCtrl+E", click: send("menu:export") },
        { type: "separator" },
        isMac ? { role: "close", label: "关闭窗口" } : { role: "quit", label: "退出" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { label: "快速打开…", accelerator: "CmdOrCtrl+P", click: send("menu:quickOpen") },
        { label: "全文搜索…", accelerator: "Shift+CmdOrCtrl+F", click: send("menu:search") },
        { type: "separator" },
        { label: "阅读模式", accelerator: "Shift+CmdOrCtrl+R", click: send("menu:reading") },
        { label: "源码模式", accelerator: "CmdOrCtrl+E", click: send("menu:raw") },
        { label: "专注模式", accelerator: "Shift+CmdOrCtrl+D", click: send("menu:focus") },
        { label: "切换主题", accelerator: "Shift+CmdOrCtrl+L", click: send("menu:theme") },
        { type: "separator" },
        { role: "toggleDevTools", label: "开发者工具" },
        { role: "reload", label: "重新载入" },
        { role: "togglefullscreen", label: "全屏" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "zoom", label: "缩放" },
        ...(isMac ? [{ type: "separator" }, { role: "front", label: "前置全部窗口" }] : []),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------- 生命周期 ---------------- */

app.on("open-file", (event, p) => {
  event.preventDefault();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("app:openFile", p);
    mainWindow.focus();
  } else {
    pendingOpenPath = p;
  }
});

// Windows / Linux 双击文件时路径在 argv 里（macOS 走 open-file）
if (process.platform !== "darwin") {
  const mdArg = process.argv.find(
    (a) => !a.startsWith("-") && /\.(md|markdown|mdx|txt)$/i.test(a)
  );
  if (mdArg) pendingOpenPath = path.resolve(mdArg);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const mdArg = argv.find((a) => /\.(md|markdown|mdx|txt)$/i.test(a));
    if (mdArg && mainWindow) mainWindow.webContents.send("app:openFile", mdArg);
  });

  app.whenReady().then(() => {
    registerProtocol();
    registerIpc();
    buildMenu();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", stopWatch);
}
