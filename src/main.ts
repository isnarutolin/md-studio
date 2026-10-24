import "./style.css";
import { EditorState, Compartment, Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  placeholder,
  drawSelection,
  dropCursor,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";

import { mdTheme } from "./theme";
import { livePreview, focusMode, widgetClickHandler, setReading } from "./live-preview";
import { HighlightConfig } from "./highlight-syntax";
import { renderDocument } from "./markdown-render";
import {
  Workspace,
  TreeNode,
  fuzzyFiles,
  searchWorkspace,
  resolveDocLink,
  type SearchHit,
} from "./workspace";
import { setAssetResolver, setCurrentDocPath } from "./assets";
import { kvGet, kvSet, kvDel, loadSettings, patchSettings, type Settings } from "./persist";
import {
  askText,
  confirmAction,
  contextMenuFromEvent,
  showContextMenu,
  type MenuItem,
} from "./dialogs";
import {
  installNativeFsa,
  isNative,
  nativeBridge,
  handlePath,
  dirHandleFromPath,
  fileHandleFromPath,
  parentDirOf,
  fileRelativeName,
  type NativeHandleMeta,
} from "./native-fsa";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

/* ==================================================================
   状态
   ================================================================== */

let ws: Workspace | null = null;
let currentPath: string | null = null;          // 工作区内的相对路径
let currentHandle: FileSystemFileHandle | null = null;  // 任意文件句柄（含单文件）
let currentName = "未命名.md";
let dirty = false;
let settings: Settings = {};
let readingMode = false;
let rawMode = false;

const previewComp = new Compartment();
const focusComp = new Compartment();
const readOnlyComp = new Compartment();

/* ==================================================================
   文档内链接跳转
   ================================================================== */

/** 找到某个位置所在的 Link/Image 节点的 URL */
function linkTargetAt(pos: number): string | null {
  let node = syntaxTree(view.state).resolveInner(pos, -1);
  while (node && node.name !== "Link" && node.name !== "Image" && node.parent) node = node.parent;
  if (!node || (node.name !== "Link" && node.name !== "Image")) return null;
  const url = node.getChild("URL");
  return url ? view.state.sliceDoc(url.from, url.to) : null;
}

const linkClickHandler = EditorView.domEventHandlers({
  click(e, v) {
    const el = (e.target as HTMLElement | null)?.closest?.(".cm-md-link") as HTMLElement | null;
    if (!el) return false;

    // 阅读模式下直接跳；编辑模式下需要按住 Cmd/Ctrl，避免误触打断编辑
    const navigate = readingMode || e.metaKey || e.ctrlKey;
    if (!navigate) return false;

    const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null) return false;
    const href = linkTargetAt(pos);
    if (!href) return false;

    if (/^(https?:)?\/\//i.test(href)) {
      const url = href.startsWith("//") ? `https:${href}` : href;
      const bridge = nativeBridge();
      if (bridge) void bridge.openExternal(url);
      else window.open(url, "_blank", "noopener");
      return true;
    }
    if (/\.(md|markdown|mdx)$/i.test(href)) {
      const target = resolveDocLink(currentPath ?? "", href);
      if (target && ws?.entry(target)) {
        void openPath(target);
      } else {
        toast(`目标不在工作区：${decodeURI(href)}`);
      }
      return true;
    }
    return false;
  },
});

/* ==================================================================
   编辑器
   ================================================================== */

const view = new EditorView({
  parent: $("#editor"),
  state: EditorState.create({
    doc: "",
    extensions: [
      history(),
      drawSelection(),
      dropCursor(),
      EditorView.lineWrapping,
      closeBrackets(),
      highlightSelectionMatches(),
      placeholder("开始写作……"),
      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
        extensions: [HighlightConfig],
      }),
      previewComp.of(livePreview),
      focusComp.of([]),
      readOnlyComp.of([]),
      widgetClickHandler,
      linkClickHandler,
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
        { key: "Mod-p", run: () => (openPalette(), true) },
        { key: "Mod-e", run: () => (toggleRaw(), true) },
        { key: "Mod-s", run: () => (saveNow(), true) },
        { key: "Mod-Shift-r", run: () => (toggleReading(), true) },
        { key: "Mod-Shift-f", run: () => (toggleFocus(), true) },
        { key: "Mod-Shift-l", run: () => (toggleTheme(), true) },
        { key: "Mod-n", run: () => (void newDoc(), true) },
        { key: "Mod-o", run: () => (pickFile(), true) },
        { key: "Mod-Shift-o", run: () => (pickWorkspace(), true) },
        { key: "Mod-Shift-e", run: () => (switchPanel("search"), focusSearch(), true) },
        { key: "Mod-\\", run: () => (toggleSidebar(), true) },
      ]),
      mdTheme,
      EditorView.updateListener.of(onDocUpdate),
    ],
  }),
});
(window as unknown as { __v: EditorView }).__v = view;

/* ==================================================================
   文档更新：dirty 标记 / 自动保存 / 统计 / 大纲
   ================================================================== */

let saveTimer = 0;
let outlineTimer = 0;

function onDocUpdate(u: { docChanged: boolean; selectionSet: boolean; view: EditorView }) {
  if (u.docChanged) {
    setDirty(true);
    scheduleSave();
    clearTimeout(outlineTimer);
    outlineTimer = window.setTimeout(buildOutline, 200);
  }
  if (u.docChanged || u.selectionSet) updateStats();
}

function setDirty(v: boolean) {
  dirty = v;
  const dot = $("#doc-dirty");
  if (dot) dot.hidden = !v;
  if (v) setSaveState("");
}

function setSaveState(text: string, tone: "" | "busy" | "ok" | "err" = "") {
  const el = $("#save-state");
  el.textContent = text;
  el.className = `save-state ${tone}`;
}

function scheduleSave() {
  // 单文件模式也有句柄，同样要自动保存；只有"临时文档"才不排期
  if (!currentHandle) return;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveNow(), 900);
}

async function saveNow(): Promise<void> {
  if (!dirty) return;
  const text = view.state.doc.toString();
  clearTimeout(saveTimer);

  // 没有句柄（不支持 API / 拖进来的临时文件）：只能给一份副本
  if (!currentHandle) {
    download(new Blob([text], { type: "text/markdown;charset=utf-8" }), currentName);
    setDirty(false);
    setSaveState("已下载副本", "ok");
    setTimeout(() => {
      if (!dirty) setSaveState("");
    }, 2200);
    return;
  }

  setSaveState("保存中…", "busy");
  try {
    const w = await (
      currentHandle as unknown as {
        createWritable(): Promise<{ write(d: string): Promise<void>; close(): Promise<void> }>;
      }
    ).createWritable();
    await w.write(text);
    await w.close();

    // 同步工作区里的搜索索引
    if (ws && currentPath) {
      const entry = ws.index.get(currentPath);
      if (entry) entry.text = text;
    }
    try {
      const f = await currentHandle.getFile();
      $("#doc-title").dataset.mtime = String(f.lastModified);
    } catch {
      /* ignore */
    }
    setDirty(false);
    setSaveState("已保存", "ok");
    setTimeout(() => {
      if (!dirty) setSaveState("");
    }, 1600);
  } catch (e) {
    setSaveState("保存失败", "err");
    toast(`保存失败：${(e as Error).message}`);
  }
}

function updateStats() {
  const text = view.state.doc.toString();
  const cjk = (text.match(/[\u4e00-\u9fa5\u3040-\u30ff]/g) || []).length;
  const words = (text.replace(/[\u4e00-\u9fa5\u3040-\u30ff]/g, " ").match(/[A-Za-z0-9_'’-]+/g) || [])
    .length;
  const mins = Math.max(1, Math.round(cjk / 400 + words / 220));
  $("#stat").textContent = `${cjk + words} 字 · ${mins} 分钟`;
}

/* ==================================================================
   ⼤纲
   ================================================================== */

interface Head {
  level: number;
  text: string;
  pos: number;
}
let heads: Head[] = [];

function buildOutline() {
  const doc = view.state.doc;
  heads = [];
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const m = /^(#{1,6})\s+(.*)$/.exec(line.text);
    if (m) heads.push({ level: m[1].length, text: m[2].trim(), pos: line.from });
  }
  const outlineEl = $("#outline");
  outlineEl.innerHTML = "";
  if (!heads.length) {
    outlineEl.innerHTML = `<div class="outline-empty">（暂无标题）</div>`;
    return;
  }
  for (const h of heads) {
    const a = document.createElement("a");
    a.className = "outline-item";
    a.dataset.l = String(h.level);
    a.textContent = h.text.replace(/[*_`~=]/g, "");
    a.onclick = () => {
      view.dispatch({
        selection: { anchor: h.pos },
        effects: EditorView.scrollIntoView(h.pos, { y: "start", yMargin: 70 }),
      });
      view.focus();
      syncOutlineActive();
    };
    outlineEl.appendChild(a);
  }
  syncOutlineActive();
}

function syncOutlineActive() {
  const cur = view.state.selection.main.head;
  let active = -1;
  for (let i = 0; i < heads.length; i++) if (heads[i].pos <= cur) active = i;
  const items = $("#outline").querySelectorAll<HTMLElement>(".outline-item");
  items.forEach((el, i) => el.classList.toggle("active", i === active));
}

/* ==================================================================
   打开 / 切换文档
   ================================================================== */

async function openPath(path: string, line?: number) {
  if (!ws) return;
  if (dirty) await saveNow();

  let text: string;
  try {
    text = await ws.read(path);
  } catch (e) {
    toast(`打开失败：${(e as Error).message}`);
    return;
  }
  await applyDocument(text, { path });
  if (line && line > 1) {
    const target = view.state.doc.line(Math.min(line, view.state.doc.lines));
    view.dispatch({
      selection: { anchor: target.from },
      effects: EditorView.scrollIntoView(target.from, { y: "center" }),
    });
  }
}

interface DocSource {
  /** 工作区内的相对路径；单文件模式为 null */
  path?: string | null;
  /** 真实文件句柄；没有则表示临时文档 */
  handle?: FileSystemFileHandle | null;
  name?: string;
}

/** 把文本装进编辑器，并更新标题/路径/资源上下文 */
async function applyDocument(text: string, src: DocSource = {}) {
  currentPath = src.path ?? null;
  currentHandle = src.handle ?? (currentPath ? (ws?.entry(currentPath)?.handle ?? null) : null);
  currentName = src.name ?? (currentPath ? currentPath.split("/").pop()! : "未命名.md");

  setCurrentDocPath(currentPath ?? "");

  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: 0 },
    scrollIntoView: true,
  });

  $("#doc-title").textContent = currentName;
  $("#doc-title").dataset.name = currentName;
  document.title = `${currentName} · MD Studio`;

  const showDoc = currentPath !== null || currentHandle !== null || text.length > 0;
  $("#welcome").hidden = showDoc && (currentPath !== null || currentHandle !== null);
  $("#doc-head").hidden = !showDoc;

  updateDocMode();

  if (currentHandle) {
    try {
      const f = await currentHandle.getFile();
      $("#doc-title").dataset.mtime = String(f.lastModified);
    } catch {
      /* ignore */
    }
  }
  if (currentPath && ws) void kvSet(`lastFile:${ws.name}`, currentPath);

  setDirty(false);
  setSaveState("");
  buildOutline();
  updateStats();
  renderTree();
  renderRecent();
  view.dispatch({ effects: setReading.of(readingMode) });
}

/** 头部那行小字：告诉用户现在存不存得回去 */
function updateDocMode() {
  const el = $("#doc-path");
  if (ws && currentPath) {
    el.textContent = currentPath;
    el.classList.remove("warn");
  } else if (currentHandle) {
    el.textContent = `单文件 · 直接保存到原位置`;
    el.classList.remove("warn");
  } else {
    el.textContent = `临时文档 · ⌘S 保存副本`;
    el.classList.add("warn");
  }
}

/* ==================================================================
   工作区
   ================================================================== */

async function pickWorkspace(request = true) {
  const w = window as unknown as {
    showDirectoryPicker?: (o?: unknown) => Promise<FileSystemDirectoryHandle>;
  };
  if (!w.showDirectoryPicker) {
    toast("当前浏览器不支持文件夹访问，请用 Chrome / Edge");
    return;
  }
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await w.showDirectoryPicker({ mode: "readwrite", id: "mdstudio" });
  } catch {
    return;
  }
  await mountWorkspace(handle, request);
}

interface MountOptions {
  /** 挂载完成后打开这个工作区内的相对路径 */
  thenOpen?: string;
  /** 是否递归扫描子目录（默认 true） */
  deep?: boolean;
}

async function mountWorkspace(
  handle: FileSystemDirectoryHandle,
  request: boolean,
  opts: MountOptions = {}
) {
  const ok = await Workspace.verify(handle, request);
  if (!ok) {
    toast("没有该文件夹的写入权限");
    return;
  }
  const wsObj = new Workspace(handle, handle.name);
  $("#ws-name").textContent = handle.name;
  $("#btn-workspace").classList.remove("need-grant");
  $("#btn-workspace").onclick = () => void pickWorkspace();
  $("#welcome-recent").innerHTML = "";
  setAssetResolver((src) => wsObj.resolveAsset(src, currentPath ?? ""));
  ws = wsObj;
  renderRecent();

  setSaveState("扫描中…", "busy");
  await ws.scan(undefined, { deep: opts.deep !== false });
  $("#tree-count").textContent = `${ws.files.length}`;
  renderTree();
  setSaveState("");

  const rootAbs = handlePath(handle);
  if (rootAbs) {
    const bridge = nativeBridge();
    if (bridge) void bridge.watch(rootAbs);
  }

  await kvSet("lastWorkspace", toSavedDir(handle));
  await patchSettings({ lastWorkspaceName: handle.name });

  // 全文索引（后台进行，不阻塞）
  setSaveState("建索引…", "busy");
  void ws.buildIndex((done, total) => {
    if (done === total) setSaveState("");
    else setSaveState(`索引 ${done}/${total}`, "busy");
  });

  if (opts.thenOpen) {
    const target = ws.entry(opts.thenOpen);
    if (target) {
      await openPath(target.path);
      return;
    }
  }

  if (ws.files.length) {
    const last = (await kvGet<string>(`lastFile:${handle.name}`)) ?? null;
    const rootFiles = ws.files.filter((f) => !f.dir);
    const preferred =
      ws.files.find((f) => f.path === last) ??
      rootFiles.find((f) => /^(readme|index)\.(md|markdown)$/i.test(f.name)) ??
      rootFiles[0] ??
      ws.files[0];
    await openPath(preferred.path);
  } else {
    $("#welcome").hidden = false;
  }
}

/* ==================================================================
   句柄的持久化表示
   浏览器：句柄本身可被结构化克隆，直接存 IndexedDB
   桌面端：句柄是垫片对象，存真实路径，重启后按路径还原
   ================================================================== */

type SavedDir = { native: true; path: string; name: string } | FileSystemDirectoryHandle;
type SavedFile = { native: true; path: string; name: string } | FileSystemFileHandle;

function toSavedDir(h: FileSystemDirectoryHandle): SavedDir {
  const p = handlePath(h);
  return p ? { native: true, path: p, name: h.name } : h;
}

function toSavedFile(h: FileSystemFileHandle, name: string): SavedFile {
  const p = handlePath(h);
  return p ? { native: true, path: p, name } : h;
}

function fromSavedDir(v: SavedDir | undefined): FileSystemDirectoryHandle | null {
  if (!v) return null;
  if ((v as { native?: boolean }).native) return dirHandleFromPath((v as { path: string }).path);
  return v as FileSystemDirectoryHandle;
}

function fromSavedFile(v: SavedFile | undefined): FileSystemFileHandle | null {
  if (!v) return null;
  if ((v as { native?: boolean }).native) return fileHandleFromPath((v as { path: string }).path);
  return v as FileSystemFileHandle;
}

/* ==================================================================
   打开单个文件（不需要文件夹，也能原地保存）
   ================================================================== */

function showOpenFilePickerFn():
  | ((o?: unknown) => Promise<FileSystemFileHandle[]>)
  | undefined {
  return (
    window as unknown as {
      showOpenFilePicker?: (o?: unknown) => Promise<FileSystemFileHandle[]>;
    }
  ).showOpenFilePicker;
}

async function pickFile() {
  if (dirty) await saveNow();

  const picker = showOpenFilePickerFn();
  if (!picker) {
    // Safari / Firefox：只能退化成只读预览
    toast("当前浏览器不支持直接打开文件，请用 Chrome / Edge");
    $<HTMLInputElement>("#file-input").click();
    return;
  }

  let handle: FileSystemFileHandle;
  try {
    [handle] = await picker({
      types: [
        {
          description: "Markdown",
          accept: { "text/markdown": [".md", ".markdown", ".mdx"], "text/plain": [".txt"] },
        },
      ],
      multiple: false,
      id: "mdstudio-file",
    });
  } catch {
    return; // 用户取消
  }

  await openPickedFile(handle);
}

/** 处理"已经选中的文件句柄" —— 从对话框、拖拽、Finder 都汇聚到这里 */
async function openPickedFile(handle: FileSystemFileHandle) {
  // 桌面端：走 openSingleFile，它会把文件所在目录挂到左栏
  const absPath = handlePath(handle);
  if (absPath) {
    await openSingleFile(absPath);
    return;
  }

  const file = await handle.getFile();

  // 浏览器端：如果文件正好在当前工作区里，按工作区模式打开（相对图片能解析）
  // 注意 isSameEntry 是异步的，不能直接当布尔用
  let rel: { path: string } | null = null;
  if (ws) {
    const sameName = ws.files.filter((f) => f.name === file.name);
    for (const cand of sameName) {
      try {
        if (await cand.handle.isSameEntry(handle)) {
          rel = cand;
          break;
        }
      } catch {
        /* ignore */
      }
    }
  }
  await applyDocument(await file.text(), { handle, name: file.name, path: rel?.path ?? null });
  rememberRecent(handle, file.name);
}

/* ---------------- 最近打开的文件 ---------------- */

interface RecentItem {
  /** 运行时句柄 */
  handle: FileSystemFileHandle;
  name: string;
  at: number;
}

interface StoredRecent {
  ref: SavedFile;
  name: string;
  at: number;
}

const RECENT_KEY = "recentFiles";
const RECENT_MAX = 8;
let recents: RecentItem[] = [];

async function loadRecents() {
  const list = (await kvGet<RecentItem[]>(RECENT_KEY)) ?? [];
  recents = list.filter((r) => r && r.handle);
  renderRecent();
}

function rememberRecent(handle: FileSystemFileHandle, name: string) {
  recents = [{ handle, name, at: Date.now() }, ...recents.filter((r) => r.name !== name)].slice(
    0,
    RECENT_MAX
  );
  void kvSet(
    RECENT_KEY,
    recents.map<StoredRecent>((r) => ({ ref: toSavedFile(r.handle, r.name), name: r.name, at: r.at }))
  );
  renderRecent();
}

async function openRecent(item: RecentItem) {
  const h = item.handle as unknown as {
    queryPermission?: (o: { mode: string }) => Promise<PermissionState>;
    requestPermission?: (o: { mode: string }) => Promise<PermissionState>;
  };
  try {
    if (h.queryPermission) {
      let st = await h.queryPermission({ mode: "readwrite" });
      if (st !== "granted" && h.requestPermission) {
        st = await h.requestPermission({ mode: "readwrite" });
      }
      if (st !== "granted") {
        toast("没有该文件的写入权限");
        return;
      }
    }
    const file = await item.handle.getFile();
    if (dirty) await saveNow();
    await applyDocument(await file.text(), { handle: item.handle, name: item.name });
    rememberRecent(item.handle, item.name);
  } catch (e) {
    toast(`打开失败：${(e as Error).message}`);
  }
}

function renderRecent() {
  const wrap = $("#recent-wrap");
  const host = $("#recent");
  const welcomeHost = $("#welcome-recent");
  if (!wrap || !host) return;

  // 顶部工作区名：单文件模式下给个提示
  if (!ws) {
    $("#ws-name").textContent = currentHandle ? `单文件：${currentName}` : "未打开工作区";
  }

  if (!recents.length) {
    wrap.hidden = true;
    if (welcomeHost) welcomeHost.innerHTML = "";
    return;
  }

  // 侧栏列表只在没有工作区时显示
  wrap.hidden = ws !== null;
  host.innerHTML = "";
  for (const r of recents.slice(0, 6)) {
    const row = document.createElement("div");
    row.className = "recent-item" + (r.name === currentName && currentHandle ? " active" : "");
    row.innerHTML = `<span class="recent-icon">▤</span><span class="recent-name">${escapeHtml(
      r.name.replace(/\.(md|markdown|mdx|txt)$/i, "")
    )}</span><span class="recent-ext">.${(r.name.split(".").pop() ?? "").toLowerCase()}</span>`;
    row.onclick = () => void openRecent(r);
    host.appendChild(row);
  }

  // 欢迎页：最后 3 个
  if (welcomeHost) {
    welcomeHost.innerHTML = `<div class="welcome-recent-head">最近打开</div>`;
    const list = document.createElement("div");
    list.className = "welcome-recent-list";
    for (const r of recents.slice(0, 3)) {
      const b = document.createElement("button");
      b.className = "welcome-btn ghost tiny";
      b.textContent = r.name;
      b.onclick = () => void openRecent(r);
      list.appendChild(b);
    }
    welcomeHost.appendChild(list);
  }
}

/** 按绝对路径打开一个文件（工作区外的单文件） */
async function openSingleFile(absPath: string) {
  const h = fileHandleFromPath(absPath);
  if (!h) return;
  if (dirty) await saveNow();

  const parentDir = parentDirOf(absPath);
  const rootAbs = ws ? handlePath(ws.root) : null;
  const insideCurrent = rootAbs ? absPath.startsWith(`${rootAbs}/`) : false;

  // 桌面端：打开一个"不在当前工作区里"的文件时，顺手把它所在的目录挂到左栏，
  // 这样才有同目录的文件列表可看（只扫一层，避免大目录递归卡住）。
  if (parentDir && (!ws || !insideCurrent)) {
    const dirHandle = dirHandleFromPath(parentDir);
    if (dirHandle) {
      const rel = absPath.slice(parentDir.length + 1);
      try {
        await mountWorkspace(dirHandle, true, { thenOpen: rel, deep: false });
        rememberRecent(h, fileRelativeName(absPath));
        return;
      } catch (e) {
        // 目录读不了（权限/路径异常）就退化成单文件模式，但要让用户知道
        toast(`无法列出所在目录：${(e as Error).message}`);
      }
    }
  }

  const f = await h.getFile();
  let rel: string | null = null;
  if (rootAbs && insideCurrent) {
    rel = absPath.slice(rootAbs.length + 1);
    if (!ws!.entry(rel)) rel = null;
  }
  await applyDocument(await f.text(), { handle: h, name: f.name, path: rel });
  rememberRecent(h, f.name);
}

/* ==================================================================
   文件树
   ================================================================== */

const collapsed = new Set<string>();

function renderTree() {
  const host = $("#tree");
  const empty = $("#tree-empty");
  host.innerHTML = "";
  const footer = $("#tree-footer");
  if (!ws) {
    empty.hidden = false;
    footer.hidden = true;
    // 单文件模式：说明为什么没有文件树
    const note = empty.querySelector<HTMLElement>(".side-empty-note");
    if (note) {
      note.textContent = currentHandle
        ? "当前是单文件模式，看不到所在目录"
        : "";
      note.hidden = !currentHandle;
    }
    return;
  }
  empty.hidden = true;

  // 浅扫描提示：只列了当前这一层
  if (ws.shallow) {
    footer.hidden = false;
    $("#tree-footer-text").textContent = `仅列出「${ws.name}」当前一层`;
  } else {
    footer.hidden = true;
  }

  if (!ws.tree.length) {
    host.innerHTML = `<div class="tree-empty">这个文件夹里没有 Markdown 文件</div>`;
    return;
  }
  host.appendChild(renderNodes(ws.tree, 0));

  // 重绘会销毁节点，把选中态还原回去
  if (treeFocus) {
    const sel = host.querySelector<HTMLElement>(`.tree-row[data-path="${cssEscape(treeFocus.path)}"]`);
    if (sel) {
      sel.classList.add("selected");
      if (treeFocus.kind === "file") sel.dataset.path = treeFocus.path;
    }
  }
}

/** 目录行也需要 data-path 才能被选中定位 */
function cssEscape(v: string): string {
  return v.replace(/["\\]/g, "\\$&");
}

function renderNodes(nodes: TreeNode[], depth: number): HTMLElement {
  const frag = document.createElement("div");
  frag.className = "tree-level";
  for (const n of nodes) {
    if (n.kind === "dir") {
      const row = document.createElement("div");
      row.className = "tree-row tree-dir";
      row.dataset.path = n.path;
      row.style.paddingLeft = `${8 + depth * 13}px`;
      const isCollapsed = collapsed.has(n.path);
      const cnt = countFiles(n);
      row.innerHTML = `<span class="tree-arrow">${isCollapsed ? "▸" : "▾"}</span><span class="tree-label">${escapeHtml(
        n.name
      )}</span>${cnt ? `<span class="tree-badge">${cnt}</span>` : ""}`;
      row.onclick = () => {
        if (collapsed.has(n.path)) collapsed.delete(n.path);
        else collapsed.add(n.path);
        renderTree();
      };
      row.tabIndex = 0;
      row.oncontextmenu = (e) => {
        focusTreeRow(row, n.path, n.name, "dir");
        contextMenuFromEvent(e, dirMenuItems(n.path, n.name));
      };
      frag.appendChild(row);
      if (!isCollapsed && n.children?.length) {
        frag.appendChild(renderNodes(n.children, depth + 1));
      }
    } else {
      const row = document.createElement("div");
      row.className = "tree-row tree-file" + (n.path === currentPath ? " active" : "");
      row.style.paddingLeft = `${8 + depth * 13}px`;
      row.dataset.path = n.path;
      row.innerHTML = `<span class="tree-dot"></span><span class="tree-label">${escapeHtml(
        stripExt(n.name)
      )}</span>`;
      row.tabIndex = 0;
      row.onclick = () => {
        focusTreeRow(row, n.path, n.name, "file");
        void openPath(n.path);
      };
      row.oncontextmenu = (e) => {
        focusTreeRow(row, n.path, n.name, "file");
        contextMenuFromEvent(e, fileMenuItems(n.path, n.name));
      };
      row.ondblclick = () => void renameFile(n.path, n.name);
      frag.appendChild(row);
    }
  }
  return frag;
}

let treeFocus: { path: string; name: string; kind: "file" | "dir" } | null = null;

function focusTreeRow(row: HTMLElement, path: string, name: string, kind: "file" | "dir") {
  treeFocus = { path, name, kind };
  document.querySelectorAll(".tree-row.selected").forEach((el) => el.classList.remove("selected"));
  row.classList.add("selected");
  row.focus({ preventScroll: true });
}

function countFiles(node: TreeNode): number {
  if (node.kind === "file") return 1;
  return (node.children ?? []).reduce((s, c) => s + countFiles(c), 0);
}

function stripExt(name: string) {
  return name.replace(/\.(md|markdown|mdx|txt)$/i, "");
}

async function rescan() {
  if (!ws) return;
  const keep = currentPath;
  await ws.scan();
  $("#tree-count").textContent = `${ws.files.length}`;
  renderTree();
  void ws.buildIndex(() => {});
  if (keep) {
    const still = ws.files.find((f) => f.path === keep);
    if (!still) {
      currentPath = null;
      $("#welcome").hidden = false;
    }
  }
}

/* ---------------- 文件 / 目录操作 ---------------- */

function parentOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function fileMenuItems(path: string, name: string): MenuItem[] {
  const bridge = nativeBridge();
  const items: MenuItem[] = [
    { label: "打开", onClick: () => void openPath(path) },
    { separator: true },
    {
      label: "重命名…",
      shortcut: "F2",
      onClick: () => void renameFile(path, name),
    },
    {
      label: "删除",
      shortcut: "⌫",
      danger: true,
      onClick: () => void deleteFile(path, name),
    },
  ];
  if (bridge) {
    items.push({ separator: true });
    items.push({
      label: "在 Finder 中显示",
      onClick: () => {
        const rootAbs = handlePath(ws?.root);
        if (rootAbs) void bridge.reveal(`${rootAbs}/${path}`);
      },
    });
  }
  return items;
}

function dirMenuItems(path: string, name: string): MenuItem[] {
  const bridge = nativeBridge();
  const items: MenuItem[] = [
    { label: "在此新建文档…", onClick: () => void newFile(path) },
    { label: "在此新建文件夹…", onClick: () => void newFolder(path) },
    { separator: true },
    {
      label: "删除文件夹",
      danger: true,
      onClick: () => void deleteDir(path, name),
    },
  ];
  if (bridge) {
    items.push({ separator: true });
    items.push({
      label: "在 Finder 中显示",
      onClick: () => {
        const rootAbs = handlePath(ws?.root);
        if (rootAbs) void bridge.reveal(`${rootAbs}/${path}`);
      },
    });
  }
  return items;
}

/** 顶部「＋」的菜单：新建 / 打开 */
function addMenuItems(): MenuItem[] {
  const items: MenuItem[] = [
    { label: "新建 Markdown 文档…", shortcut: "⌘N", onClick: () => void newDoc() },
  ];
  if (ws) items.push({ label: "新建文件夹…", onClick: () => void newFolder("") });
  items.push({ separator: true });
  items.push({ label: "打开文件…", shortcut: "⌘O", onClick: () => void pickFile() });
  items.push({ label: "打开文件夹…", shortcut: "⇧⌘O", onClick: () => void pickWorkspace() });
  return items;
}

/**
 * 新建文档：有工作区就在工作区里建；
 * 没有工作区就用系统保存对话框（桌面端），浏览器端提示先开文件夹。
 */
async function newDoc() {
  if (ws) {
    await newFile("");
    return;
  }
  const bridge = nativeBridge();
  if (!bridge) {
    toast("先打开一个文件夹（⌘⇧O），或在桌面客户端里使用");
    return;
  }
  try {
    const target = await bridge.pickSavePath("未命名.md");
    if (!target) return;
    await bridge.write(target, "");
    await openSingleFile(target);
  } catch (e) {
    toast(`创建失败：${(e as Error).message}`);
  }
}

/** 校验新建/改名的文件名 */
function validateName(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "名称不能为空";
  if (/["*<>?\\|:]/.test(v)) return '不能包含 " * < > ? \\ | : 这些字符';
  if (v === "." || v === "..") return "名称不合法";
  if (v.split("/").some((seg) => seg === "..")) return "不能包含 ..";
  return null;
}

function withMdExt(name: string): string {
  return /\.(md|markdown|mdx|txt)$/i.test(name) ? name : `${name}.md`;
}

async function newFile(dirPath = "") {
  if (!ws) {
    toast("先打开一个文件夹");
    return;
  }
  const name = await askText({
    title: "新建 Markdown 文档",
    label: dirPath ? `位置：${dirPath}/` : "位置：工作区根目录",
    value: "未命名.md",
    placeholder: "文件名，可带子目录如 notes/todo.md",
    confirmText: "创建",
    validate: validateName,
  });
  if (!name) return;

  const clean = withMdExt(name);
  const dir = clean.includes("/")
    ? [dirPath, clean.slice(0, clean.lastIndexOf("/"))].filter(Boolean).join("/")
    : dirPath;
  const base = clean.split("/").pop()!;

  try {
    const entry = await ws.createFile(dir, base);
    if (dir) collapsed.delete(dir);
    await rescan();
    await openPath(entry.path);
    toast("已创建");
  } catch (e) {
    toast(`创建失败：${(e as Error).message}`);
  }
}

async function newFolder(dirPath = "") {
  if (!ws) {
    toast("先打开一个文件夹");
    return;
  }
  const name = await askText({
    title: "新建文件夹",
    label: dirPath ? `位置：${dirPath}/` : "位置：工作区根目录",
    value: "",
    placeholder: "文件夹名",
    confirmText: "创建",
    validate: validateName,
  });
  if (!name) return;
  try {
    await ws.createDir(dirPath, name);
    if (dirPath) collapsed.delete(dirPath);
    await rescan();
    toast("已创建文件夹");
  } catch (e) {
    toast(`创建失败：${(e as Error).message}`);
  }
}

async function renameFile(path: string, name: string) {
  if (!ws) return;
  const next = await askText({
    title: "重命名",
    label: parentOf(path) ? `位置：${parentOf(path)}/` : "位置：工作区根目录",
    value: name,
    confirmText: "重命名",
    validate: validateName,
  });
  if (!next || next === name) return;

  try {
    const dir = parentOf(path);
    // 桌面端直接 fs.rename 更快；这里统一用"读→写→删"保证两种后端都能用
    const text = await ws.read(path);
    const newName = withMdExt(next);
    const entry = await ws.createFile(dir, newName);
    await ws.write(entry.path, text);
    await ws.remove(path);
    if (currentPath === path) {
      currentPath = entry.path;
    }
    await rescan();
    if (currentPath === entry.path) await openPath(entry.path);
    toast("已重命名");
  } catch (e) {
    toast(`重命名失败：${(e as Error).message}`);
  }
}

async function deleteFile(path: string, name: string) {
  if (!ws) return;
  const ok = await confirmAction({
    title: `删除「${name}」？`,
    message: "文件会从磁盘移除，不进废纸篓，无法撤销。",
    confirmText: "删除",
    danger: true,
  });
  if (!ok) return;

  try {
    const wasCurrent = currentPath === path;
    await ws.remove(path);
    await rescan();
    if (wasCurrent) {
      currentPath = null;
      currentHandle = null;
      await applyDocument("", {});
      $("#welcome").hidden = false;
      $("#doc-head").hidden = true;
    }
    toast("已删除");
  } catch (e) {
    toast(`删除失败：${(e as Error).message}`);
  }
}

async function deleteDir(path: string, name: string) {
  if (!ws) return;
  const inside = ws.files.filter((f) => f.path.startsWith(`${path}/`)).length;
  const ok = await confirmAction({
    title: `删除文件夹「${name}」？`,
    message: inside
      ? `里面还有 ${inside} 个 Markdown 文件，会一起从磁盘移除，无法撤销。`
      : "文件夹会从磁盘移除，无法撤销。",
    confirmText: "删除",
    danger: true,
  });
  if (!ok) return;

  try {
    const wasInside = currentPath?.startsWith(`${path}/`);
    await ws.remove(path);
    await rescan();
    if (wasInside) {
      currentPath = null;
      currentHandle = null;
      await applyDocument("", {});
      $("#welcome").hidden = false;
      $("#doc-head").hidden = true;
    }
    toast("已删除文件夹");
  } catch (e) {
    toast(`删除失败：${(e as Error).message}`);
  }
}

/* ==================================================================
   搜索面板
   ================================================================== */

let searchTimer = 0;

function focusSearch() {
  switchPanel("search");
  const input = $<HTMLInputElement>("#search-input");
  input.focus();
  input.select();
}

function wireSearch() {
  const input = $<HTMLInputElement>("#search-input");
  input.oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(runSearch, 180);
  };
  input.onkeydown = (e) => {
    if (e.key === "Escape") {
      input.value = "";
      runSearch();
      view.focus();
    }
  };
}

function runSearch() {
  const q = $<HTMLInputElement>("#search-input").value;
  const meta = $("#search-meta");
  const list = $("#search-results");
  list.innerHTML = "";
  if (!ws) {
    meta.textContent = "先打开一个文件夹";
    return;
  }
  if (!q.trim()) {
    meta.textContent = "";
    return;
  }
  const hits = searchWorkspace(ws, q);
  meta.textContent = `${hits.length} 处结果${ws.index.size ? "" : "（索引构建中…）"}`;
  if (!hits.length) {
    list.innerHTML = `<div class="tree-empty">没有匹配</div>`;
    return;
  }
  for (const h of hits) void renderHit(h, list);
}

async function renderHit(h: SearchHit, host: HTMLElement) {
  const row = document.createElement("div");
  row.className = "hit";
  row.innerHTML = `
    <div class="hit-title"><span class="hit-name">${escapeHtml(stripExt(h.name))}</span>
      <span class="hit-line">${h.line}</span></div>
    <div class="hit-path">${escapeHtml(dirOf(h.path))}</div>
    ${h.snippet ? `<div class="hit-snippet">${h.snippet}</div>` : ""}`;
  row.onclick = () => void openPath(h.path, h.line);
  host.appendChild(row);
}

function dirOf(path: string) {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

/* ==================================================================
   快速打开面板
   ================================================================== */

let paletteIndex = 0;
let paletteHits: { path: string; name: string; score: number }[] = [];

function openPalette() {
  if (!ws) {
    toast("先打开一个文件夹");
    return;
  }
  $("#palette-mask").hidden = false;
  const input = $<HTMLInputElement>("#palette-input");
  input.value = "";
  input.focus();
  renderPalette("");
}

function closePalette() {
  $("#palette-mask").hidden = true;
}

function renderPalette(q: string) {
  if (!ws) return;
  paletteHits = fuzzyFiles(ws.files, q);
  paletteIndex = 0;
  const list = $("#palette-list");
  list.innerHTML = "";
  if (!paletteHits.length) {
    list.innerHTML = `<div class="palette-empty">没有匹配的文件</div>`;
    return;
  }
  paletteHits.forEach((h, i) => {
    const row = document.createElement("div");
    row.className = "palette-item" + (i === 0 ? " active" : "");
    row.innerHTML = `<span class="pi-name">${escapeHtml(stripExt(h.name))}</span>
      <span class="pi-path">${escapeHtml(dirOf(h.path))}</span>`;
    row.onclick = () => {
      closePalette();
      void openPath(h.path);
    };
    list.appendChild(row);
  });
}

function movePalette(delta: number) {
  const items = $("#palette-list").querySelectorAll<HTMLElement>(".palette-item");
  if (!items.length) return;
  paletteIndex = (paletteIndex + delta + items.length) % items.length;
  items.forEach((el, i) => el.classList.toggle("active", i === paletteIndex));
  items[paletteIndex].scrollIntoView({ block: "nearest" });
}

function wirePalette() {
  const input = $<HTMLInputElement>("#palette-input");
  input.oninput = () => renderPalette(input.value);
  input.onkeydown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      movePalette(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      movePalette(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = paletteHits[paletteIndex];
      if (hit) {
        closePalette();
        void openPath(hit.path);
      }
    } else if (e.key === "Escape") {
      closePalette();
      view.focus();
    }
  };
  $("#palette-mask").onclick = (e) => {
    if (e.target === e.currentTarget) closePalette();
  };
}

/* ==================================================================
   侧栏 tab
   ================================================================== */

function switchPanel(name: "files" | "search" | "outline") {
  document.querySelectorAll(".side-tab").forEach((t) => {
    t.classList.toggle("active", (t as HTMLElement).dataset.panel === name);
  });
  document.querySelectorAll(".side-panel").forEach((p) => {
    p.classList.toggle("hidden", (p as HTMLElement).dataset.panel !== name);
  });
  $("#sidebar").classList.remove("collapsed");
  document.querySelector(".workspace")!.classList.remove("no-sidebar");
  if (name === "outline") buildOutline();
}

/* ==================================================================
   开关
   ================================================================== */

function toggleRaw() {
  rawMode = !rawMode;
  view.dispatch({ effects: previewComp.reconfigure(rawMode ? [] : livePreview) });
  $("#btn-raw").classList.toggle("on", rawMode);
  void patchSettings({ rawMode });
}

function toggleReading() {
  readingMode = !readingMode;
  view.dispatch({ effects: setReading.of(readingMode) });
  view.dispatch({ effects: readOnlyComp.reconfigure(readingMode ? EditorState.readOnly.of(true) : []) });
  view.dom.classList.toggle("cm-reading", readingMode);
  $("#btn-read").classList.toggle("on", readingMode);
  void patchSettings({ readingMode });
}

function toggleFocus() {
  const on = !$("#btn-focus").classList.contains("on");
  view.dispatch({ effects: focusComp.reconfigure(on ? focusMode : []) });
  $("#btn-focus").classList.toggle("on", on);
}

function toggleTheme() {
  const root = document.documentElement;
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  void patchSettings({ theme: next });
}

function toggleSidebar() {
  document.querySelector(".workspace")!.classList.toggle("no-sidebar");
}

/* ==================================================================
   导出 HTML
   ================================================================== */

function exportHtml() {
  const body = renderDocument(view.state.doc.toString());
  const title = heads[0]?.text?.replace(/[*_`~=]/g, "") || $("#doc-title").textContent || "文档";
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${EXPORT_CSS}</style></head>
<body><article class="markdown-body">${body}</article></body></html>`;
  download(new Blob([html], { type: "text/html;charset=utf-8" }), `${stripExt(title)}.html`);
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const EXPORT_CSS = `
:root{--fg:#22201d;--muted:#8b857c;--line:#e6e2db;--accent:#b3541e;--code:#f4f2ee;}
*{box-sizing:border-box}
body{margin:0;background:#fbfaf8;color:var(--fg);
 font:17px/1.78 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;
 -webkit-font-smoothing:antialiased}
.markdown-body{max-width:760px;margin:0 auto;padding:72px 24px 160px}
h1,h2,h3,h4,h5,h6{font-weight:700;letter-spacing:-.014em;line-height:1.3;margin:1.6em 0 .55em}
h1{font-size:1.92em;margin-top:.6em}h2{font-size:1.5em}
h3{font-size:1.24em}h4{font-size:1.08em}
h5{font-size:1em;color:#4a4642}h6{font-size:.92em;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
p{margin:0 0 1.05em}
a{color:var(--accent);text-decoration:underline;text-underline-offset:2.5px}
strong{font-weight:700}del{color:var(--muted)}
code{font-family:"SF Mono",ui-monospace,Menlo,monospace;font-size:.87em;
 background:#efebe4;border:1px solid var(--line);border-radius:5px;padding:.12em .36em;color:var(--accent)}
pre{background:var(--code);border:1px solid var(--line);border-radius:10px;padding:16px 18px;overflow:auto;margin:0 0 1.2em}
pre code{background:none;border:none;padding:0;color:inherit;font-size:.845em;line-height:1.62}
blockquote{margin:0 0 1.1em;padding:2px 0 2px 18px;border-left:3px solid #d8c3b3;color:#4a4642}
table{width:100%;border-collapse:separate;border-spacing:0;font-size:.88em;
 border:1px solid var(--line);border-radius:10px;overflow:hidden;margin:0 0 1.3em}
th{background:#f3f1ed;text-align:left;padding:9px 14px;border-bottom:1px solid var(--line);font-weight:650}
td{padding:8px 14px;border-bottom:1px solid #efece6}
tr:last-child td{border-bottom:none}
img{max-width:100%;border-radius:10px;box-shadow:0 1px 2px rgba(30,24,18,.04),0 8px 24px rgba(30,24,18,.06)}
hr{border:none;height:1px;background:var(--line);margin:2em 0}
ul,ol{padding-left:1.5em;margin:0 0 1.1em}
li{margin:.25em 0}
input[type=checkbox]{margin-right:.5em}
mark{background:linear-gradient(transparent 55%,rgba(179,84,30,.16) 55%);color:inherit}
`;

/* ==================================================================
   工具
   ================================================================== */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function toast(msg: string) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 250);
  }, 1800);
}

/* ==================================================================
   事件绑定
   ================================================================== */

function wireUI() {
  $("#btn-sidebar").onclick = toggleSidebar;
  $("#btn-read").onclick = toggleReading;
  $("#btn-focus").onclick = toggleFocus;
  $("#btn-raw").onclick = toggleRaw;
  $("#btn-theme").onclick = toggleTheme;
  $("#btn-export").onclick = exportHtml;
  $("#btn-workspace").onclick = () => void pickWorkspace();
  $("#btn-open-dir").onclick = () => void pickWorkspace();
  $("#welcome-open").onclick = () => void pickWorkspace();
  $("#welcome-open-file").onclick = () => void pickFile();
  $("#btn-open-file").onclick = () => void pickFile();
  $("#btn-open-file-top").onclick = (e) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    showContextMenu(r.left, r.bottom + 4, addMenuItems());
  };
  $("#btn-quickopen").onclick = openPalette;
  $("#btn-newfile").onclick = () => void newFile();
  $("#btn-newfolder").onclick = () => void newFolder();
  $("#btn-deepen").onclick = () => {
    if (!ws) return;
    void mountWorkspace(ws.root, true, { thenOpen: currentPath ?? undefined, deep: true });
  };
  $("#btn-refresh").onclick = () => void rescan();

  document.querySelectorAll(".side-tab").forEach((t) => {
    (t as HTMLElement).onclick = () => switchPanel((t as HTMLElement).dataset.panel as never);
  });

  wireSearch();
  wirePalette();

  // 文件树键盘操作：F2 重命名 / Delete 删除 / Enter 打开
  window.addEventListener("keydown", (e) => {
    if (!treeFocus) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest(".cm-editor") || t?.closest("input, textarea, [contenteditable]")) return;
    const maskEl = document.querySelector(".modal-mask");
    if (maskEl && !maskEl.hasAttribute("hidden")) return; // 弹窗开着时不响应
    if (e.metaKey || e.ctrlKey) return;

    if (e.key === "F2") {
      e.preventDefault();
      if (treeFocus.kind === "file") void renameFile(treeFocus.path, treeFocus.name);
      else toast("文件夹重命名暂未支持");
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      if (treeFocus.kind === "file") void deleteFile(treeFocus.path, treeFocus.name);
      else void deleteDir(treeFocus.path, treeFocus.name);
    } else if (e.key === "Enter" && treeFocus.kind === "file") {
      e.preventDefault();
      void openPath(treeFocus.path);
    }
  });

  window.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) {
      if (e.key === "Escape" && !$("#palette-mask").hidden) closePalette();
      return;
    }
    if (view.dom.contains(e.target as Node)) return; // 编辑器内交给 CM keymap
    const k = e.key.toLowerCase();
    const shift = e.shiftKey;
    if (k === "p" && !shift) { e.preventDefault(); openPalette(); }
    else if (k === "s" && !shift) { e.preventDefault(); void saveNow(); }
    else if (k === "r" && shift) { e.preventDefault(); toggleReading(); }
    else if (k === "f" && shift) { e.preventDefault(); toggleFocus(); }
    else if (k === "e" && shift) { e.preventDefault(); switchPanel("search"); focusSearch(); }
    else if (k === "e" && !shift) { e.preventDefault(); toggleRaw(); }
    else if (k === "l" && shift) { e.preventDefault(); toggleTheme(); }
    else if (k === "o" && shift) { e.preventDefault(); void pickWorkspace(); }
    else if (k === "n") { e.preventDefault(); void newDoc(); }
    else if (k === "o") { e.preventDefault(); void pickFile(); }
    else if (k === "\\") { e.preventDefault(); toggleSidebar(); }
  });

  // 拖拽打开（临时文件，不进工作区）
  let depth = 0;
  window.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    depth++;
    $("#drop-mask").classList.add("show");
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) $("#drop-mask").classList.remove("show");
  });
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    depth = 0;
    $("#drop-mask").classList.remove("show");
    const item = e.dataTransfer?.items?.[0];
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;

    // Chrome 支持从拖拽里拿到真实文件句柄 —— 拿到就能原地保存
    let handle: FileSystemFileHandle | null = null;
    try {
      const h = await (
        item as unknown as { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }
      )?.getAsFileSystemHandle?.();
      if (h && h.kind === "file") handle = h as FileSystemFileHandle;
    } catch {
      /* 拿不到就当临时文档 */
    }
    const absPath = handle ? handlePath(handle) : null;
    if (absPath) {
      await openSingleFile(absPath);
    } else {
      await applyDocument(await f.text(), { handle, name: f.name });
      if (handle) rememberRecent(handle, f.name);
    }
  });

  // 不支持 showOpenFilePicker 的浏览器走 <input type=file>（只读预览）
  $<HTMLInputElement>("#file-input").onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    await applyDocument(await f.text(), { name: f.name });
    (e.target as HTMLInputElement).value = "";
  };

  // 离开前保存
  window.addEventListener("beforeunload", (e) => {
    if (!dirty) return;
    if (ws && currentPath) void saveNow();
    e.preventDefault();
    e.returnValue = "";
  });

  // 切回来时检查外部改动
  window.addEventListener("focus", () => void checkExternalChange());
}

async function checkExternalChange() {
  if (!currentHandle || dirty) return;
  try {
    const f = await currentHandle.getFile();
    const mine = Number($("#doc-title").dataset.mtime ?? 0);
    if (mine && f.lastModified > mine + 500) {
      $("#doc-title").dataset.mtime = String(f.lastModified);
      const text = await f.text();
      if (text !== view.state.doc.toString()) {
        await applyDocument(text, {
          path: currentPath,
          handle: currentHandle,
          name: currentName,
        });
        toast("检测到外部修改，已重新载入");
      }
    }
  } catch {
    /* ignore */
  }
}

/* ==================================================================
   PWA：Service Worker + 被当作 .md 默认打开方式时的入口
   ================================================================== */

function wirePWA() {
  // 桌面客户端不需要 SW（资源走 mdstudio:// 协议）
  if (isNative()) return;
  // 注册 service worker（PWA 可安装的前提）
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      /* 离线兜底失败不影响使用 */
    });
  }

  // 安装为应用后，双击 .md 会走这里
  const lq = (window as unknown as {
    launchQueue?: { setConsumer: (fn: (p: { files?: FileSystemHandle[] }) => void) => void };
  }).launchQueue;
  if (lq) {
    lq.setConsumer(async (params) => {
      const files = params.files ?? [];
      const first = files.find((f) => f.kind === "file") as FileSystemFileHandle | undefined;
      if (!first) return;
      try {
        const f = await first.getFile();
        await applyDocument(await f.text(), { handle: first, name: f.name });
        rememberRecent(first, f.name);
      } catch (e) {
        toast(`打开失败：${(e as Error).message}`);
      }
    });
  }
}

/* ==================================================================
   桌面客户端接线：文件监听 / 菜单 / Finder 打开
   ================================================================== */

let rescanTimer = 0;

function wireDesktop() {
  const bridge = nativeBridge();
  if (!bridge) return;
  document.documentElement.classList.add("is-electron");

  // 外部改动：当前文件直接重载，其它文件触发一次轻量 rescan
  bridge.onFsChanged(async ({ root, files }) => {
    if (!ws) return;
    const rootAbs = handlePath(ws.root);
    if (!rootAbs || root !== rootAbs) return;

    const normalized = files.map((f) => f.replace(/\\/g, "/"));
    const currentAbs = currentPath ? `${rootAbs}/${currentPath}`.replace(/\\/g, "/") : null;

    const touchedCurrent = currentAbs && normalized.some((f) => f === currentAbs);
    const touchedTree = normalized.some((f) => /\.(md|markdown|mdx|txt)$/i.test(f));

    if (touchedCurrent && !dirty) {
      await checkExternalChange();
    } else if (touchedCurrent && dirty) {
      setSaveState("外部已改动", "err");
    }

    if (touchedTree) {
      clearTimeout(rescanTimer);
      rescanTimer = window.setTimeout(() => void rescan(), 350);
    }
  });

  // Finder 里双击 .md
  bridge.onOpenFile((absPath) => void openSingleFile(absPath));

  // 原生菜单
  bridge.onMenu("newDoc", () => void newDoc());
  bridge.onMenu("openFile", () => void pickFile());
  bridge.onMenu("openFolder", () => void pickWorkspace());
  bridge.onMenu("save", () => void saveNow());
  bridge.onMenu("export", () => exportHtml());
  bridge.onMenu("quickOpen", () => openPalette());
  bridge.onMenu("search", () => {
    switchPanel("search");
    focusSearch();
  });
  bridge.onMenu("reading", () => toggleReading());
  bridge.onMenu("raw", () => toggleRaw());
  bridge.onMenu("focus", () => toggleFocus());
  bridge.onMenu("theme", () => toggleTheme());
}

/* ==================================================================
   启动
   ================================================================== */

async function boot() {
  settings = await loadSettings();
  if (settings.rawMode) toggleRaw();
  if (settings.readingMode) toggleReading();
  if (settings.theme) document.documentElement.dataset.theme = settings.theme;
  else if (window.matchMedia("(prefers-color-scheme: dark)").matches)
    document.documentElement.dataset.theme = "dark";

  installNativeFsa();
  wireUI();
  wireDesktop();
  wirePWA();
  renderTree();
  updateStats();
  await loadRecents();

  // 尝试恢复上次工作区
  const savedDir = await kvGet<SavedDir>("lastWorkspace");
  const last = fromSavedDir(savedDir);
  if (last) {
    // 目录可能已经被删/改名了：先确认还在，否则别留个空壳工作区
    const abs = handlePath(last);
    const bridge = nativeBridge();
    if (abs && bridge && !(await bridge.exists(abs).catch(() => false))) {
      await kvDel("lastWorkspace");
      $("#ws-name").textContent = "未打开工作区";
    } else if (await Workspace.verify(last, false)) {
      await mountWorkspace(last, false);
      return;
    } else {
      // 需要重新授权（浏览器才有的情况）：给个入口
      const dir = last;
      $("#ws-name").textContent = `继续上次工作区：${dir.name}`;
      $("#btn-workspace").classList.add("need-grant");
      $("#btn-workspace").onclick = async () => {
        if (await Workspace.verify(dir, true)) await mountWorkspace(dir, false);
      };
      $("#welcome-recent").innerHTML = `<button class="welcome-btn ghost" id="reopen">继续打开「${escapeHtml(
        dir.name
      )}」</button>`;
      $("#reopen").onclick = async () => {
        if (await Workspace.verify(dir, true)) await mountWorkspace(dir, false);
      };
      return;
    }
  }

  // 上次开的如果是单文件，尝试恢复（需要重新授权时让用户点一下）
  if (recents.length) {
    $("#welcome").hidden = false;
    const last = recents[0];
    const h = last.handle as unknown as {
      queryPermission?: (o: { mode: string }) => Promise<PermissionState>;
    };
    try {
      if (!h.queryPermission || (await h.queryPermission({ mode: "readwrite" })) === "granted") {
        const file = await last.handle.getFile();
        await applyDocument(await file.text(), { handle: last.handle, name: last.name });
        return;
      }
    } catch {
      /* fallthrough */
    }
  }

  // 首次使用：空文档 + 欢迎页
  await applyDocument("", {});
  $("#welcome").hidden = false;
}

void boot();

// 供自动化测试
(window as unknown as Record<string, unknown>).__app = {
  get ws() {
    return ws;
  },
  get path() {
    return currentPath;
  },
  openPath,
  applyDocument,
  mountWorkspace,
  newFile,
  rescan,
  toggleReading,
  toggleRaw,
  saveNow,
  openPalette,
  runSearch,
  pickFile,
  pickWorkspace,
  isNative,
  /** 按绝对路径挂载工作区（测试 / 未来的 --path 参数） */
  mountPath: async (absPath: string) => {
    const h = dirHandleFromPath(absPath);
    if (!h) return false;
    await mountWorkspace(h, true);
    return true;
  },
  /** 按绝对路径打开单个文件 */
  openFilePath: openSingleFile,
  pickFileAt: (p: string) => {
    const h = fileHandleFromPath(p);
    return h ? openPickedFile(h) : Promise.resolve();
  },
  get recents() {
    return recents;
  },
  /** 调试：把语法树与视口状态暴露出来 */
  debugState: () => {
    const st = view.state;
    const tree = syntaxTree(st);
    return {
      docLen: st.doc.length,
      docLines: st.doc.lines,
      viewport: { from: view.viewport.from, to: view.viewport.to },
      tree: { len: tree.length, name: tree.type.name },
      treeHead: tree.toString().slice(0, 120),
      hasFocus: view.hasFocus,
      editorH: view.dom.clientHeight,
      contentH: view.contentDOM.clientHeight,
    };
  },
  linkAt: (x: number, y: number) => {
    const pos = view.posAtCoords({ x, y });
    if (pos == null) return null;
    const chain: string[] = [];
    let cur: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(view.state).resolveInner(pos, -1);
    while (cur) {
      chain.push(`${cur.name}[${cur.from},${cur.to}]`);
      cur = cur.parent as never;
    }
    const slice = (a: number, b: number) => JSON.stringify(view.state.sliceDoc(a, b));
    return { pos, chain: chain.slice(0, 6), href: linkTargetAt(pos), text: slice(pos - 6, pos + 6) };
  },
  createFile: async (dir: string, name: string) => {
    const e = await ws!.createFile(dir, name);
    await rescan();
    return e.path;
  },
};
