/**
 * preload：只暴露一组窄接口给渲染进程（contextIsolation 开着，node 集成关着）。
 * 渲染进程里的 src/native-fsa.ts 在这之上搭出 File System Access API 的垫片。
 */

const { contextBridge, ipcRenderer } = require("electron");

const listeners = { fsChanged: [], openFile: [], menu: {} };

ipcRenderer.on("fs:changed", (_e, payload) => {
  for (const fn of listeners.fsChanged) fn(payload);
});

ipcRenderer.on("app:openFile", (_e, p) => {
  for (const fn of listeners.openFile) fn(p);
});

const MENU_CHANNELS = {
  "menu:newDoc": "newDoc",
  "menu:openFile": "openFile",
  "menu:openFolder": "openFolder",
  "menu:save": "save",
  "menu:export": "export",
  "menu:quickOpen": "quickOpen",
  "menu:search": "search",
  "menu:reading": "reading",
  "menu:raw": "raw",
  "menu:focus": "focus",
  "menu:theme": "theme",
};

for (const [channel, name] of Object.entries(MENU_CHANNELS)) {
  ipcRenderer.on(channel, () => {
    for (const fn of listeners.menu[name] ?? []) fn();
  });
}

contextBridge.exposeInMainWorld("mdNative", {
  isNative: true,
  platform: process.platform,

  // 对话框
  pickDirectory: () => ipcRenderer.invoke("dialog:dir"),
  pickFile: () => ipcRenderer.invoke("dialog:file"),
  pickSavePath: (name) => ipcRenderer.invoke("dialog:save", name),

  // 文件系统
  listDir: (dir) => ipcRenderer.invoke("fs:listdir", dir),
  read: (p) => ipcRenderer.invoke("fs:read", p),
  write: (p, text) => ipcRenderer.invoke("fs:write", p, text),
  stat: (p) => ipcRenderer.invoke("fs:stat", p),
  exists: (p) => ipcRenderer.invoke("fs:exists", p),
  mkdirp: (p) => ipcRenderer.invoke("fs:mkdirp", p),
  create: (dir, name) => ipcRenderer.invoke("fs:create", dir, name),
  remove: (p) => ipcRenderer.invoke("fs:remove", p),

  // 监听
  watch: (root) => ipcRenderer.invoke("fs:watch", root),
  unwatch: () => ipcRenderer.invoke("fs:unwatch"),
  onFsChanged: (fn) => listeners.fsChanged.push(fn),
  onOpenFile: (fn) => listeners.openFile.push(fn),

  // 菜单事件
  onMenu: (name, fn) => {
    (listeners.menu[name] ??= []).push(fn);
  },

  // 杂项
  info: () => ipcRenderer.invoke("app:info"),
  reveal: (p) => ipcRenderer.invoke("shell:reveal", p),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
});

// 让 CSS 能针对桌面端 / 具体平台做微调
window.addEventListener("DOMContentLoaded", () => {
  const root = document.documentElement;
  root.classList.add("is-electron");
  if (process.platform === "darwin") root.classList.add("is-mac");
  else if (process.platform === "win32") root.classList.add("is-win");
  else root.classList.add("is-linux");
});
