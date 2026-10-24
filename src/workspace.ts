/** 基于 File System Access API 的工作区：扫描目录、读写文件、解析相对资源 */

import { handlePath, localFileUrl, nativeBridge } from "./native-fsa";

export const MD_EXT = /\.(md|markdown|mdx|txt)$/i;
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".svn",
  ".obsidian",
  "vendor",
  "__pycache__",
  ".next",
  "target",
]);
const MAX_INDEX_SIZE = 2 * 1024 * 1024; // 单文件超过 2MB 不进全文索引

export interface TreeNode {
  name: string;
  path: string;
  kind: "dir" | "file";
  children?: TreeNode[];
  handle: FileSystemHandle;
}

export interface FileEntry {
  path: string;
  name: string;
  dir: string;
  handle: FileSystemFileHandle;
}

export interface IndexedFile {
  path: string;
  name: string;
  text: string;
}

export class Workspace {
  tree: TreeNode[] = [];
  files: FileEntry[] = [];
  index: Map<string, IndexedFile> = new Map();
  private byPath = new Map<string, FileEntry>();
  private dirCache = new Map<string, FileSystemDirectoryHandle>();

  root: FileSystemDirectoryHandle;
  name: string;

  constructor(root: FileSystemDirectoryHandle, name: string) {
    this.root = root;
    this.name = name;
  }

  /* ---------------- 授权 ---------------- */

  static async verify(handle: FileSystemDirectoryHandle, request = false): Promise<boolean> {
    const h = handle as unknown as {
      queryPermission?: (o: { mode: string }) => Promise<PermissionState>;
      requestPermission?: (o: { mode: string }) => Promise<PermissionState>;
    };
    if (!h.queryPermission) return true;
    let state = await h.queryPermission({ mode: "readwrite" });
    if (state === "granted") return true;
    if (!request || !h.requestPermission) return false;
    state = await h.requestPermission({ mode: "readwrite" });
    return state === "granted";
  }

  /* ---------------- 扫描 ---------------- */

  /** 当前工作区是否是"只扫了一层"的浅模式 */
  shallow = false;

  async scan(onProgress?: (n: number) => void, opts?: { deep?: boolean }): Promise<void> {
    const deep = opts?.deep !== false;
    this.shallow = !deep;
    this.files = [];
    this.byPath.clear();
    this.dirCache.clear();
    this.dirCache.set("", this.root);

    const rootNode: TreeNode = { name: this.name, path: "", kind: "dir", children: [], handle: this.root };
    await this.walk(this.root, rootNode, onProgress, deep);
    sortTree(rootNode);
    this.tree = rootNode.children ?? [];
  }

  private async walk(
    dir: FileSystemDirectoryHandle,
    node: TreeNode,
    onProgress?: (n: number) => void,
    deep = true
  ): Promise<void> {
    const entries: FileSystemHandle[] = [];
    for await (const h of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
      entries.push(h);
    }
    entries.sort((a, b) => {
      const ad = a.kind === "directory" ? 0 : 1;
      const bd = b.kind === "directory" ? 0 : 1;
      return ad - bd || a.name.localeCompare(b.name, "zh");
    });

    for (const h of entries) {
      if (h.name.startsWith(".")) continue;
      const path = node.path ? `${node.path}/${h.name}` : h.name;

      if (h.kind === "directory") {
        // 浅模式只列文件，不进子目录（打开单个文件时的默认行为，
        // 避免在 ~/Documents 这种大目录里递归卡住）
        if (!deep) continue;
        if (SKIP_DIRS.has(h.name)) continue;
        const child: TreeNode = { name: h.name, path, kind: "dir", children: [], handle: h };
        node.children!.push(child);
        try {
          await this.walk(h as FileSystemDirectoryHandle, child, onProgress, deep);
        } catch {
          /* 权限或 IO 问题：跳过这个目录 */
        }
      } else if (MD_EXT.test(h.name)) {
        node.children!.push({ name: h.name, path, kind: "file", handle: h });
        this.files.push({
          path,
          name: h.name,
          dir: node.path,
          handle: h as FileSystemFileHandle,
        });
        onProgress?.(this.files.length);
      }
    }
  }

  /* ---------------- 索引（搜索用） ---------------- */

  async buildIndex(onProgress?: (done: number, total: number) => void): Promise<void> {
    this.index.clear();
    const total = this.files.length;
    let done = 0;
    for (const f of this.files) {
      try {
        const file = await f.handle.getFile();
        if (file.size <= MAX_INDEX_SIZE) {
          this.index.set(f.path, { path: f.path, name: f.name, text: await file.text() });
        }
      } catch {
        /* 读不到就跳过 */
      }
      onProgress?.(++done, total);
    }
  }

  /* ---------------- 读写 ---------------- */

  entry(path: string): FileEntry | undefined {
    return this.byPath.get(path) ?? this.files.find((f) => f.path === path);
  }

  async read(path: string): Promise<string> {
    const e = this.requireEntry(path);
    const file = await e.handle.getFile();
    return await file.text();
  }

  async stat(path: string): Promise<{ size: number; lastModified: number }> {
    const file = await this.requireEntry(path).handle.getFile();
    return { size: file.size, lastModified: file.lastModified };
  }

  async write(path: string, text: string): Promise<void> {
    const e = this.requireEntry(path);
    const w = await (e.handle as unknown as {
      createWritable(): Promise<{ write(d: string): Promise<void>; close(): Promise<void> }>;
    }).createWritable();
    await w.write(text);
    await w.close();
    const idx = this.index.get(path);
    if (idx) idx.text = text;
  }

  async createFile(dirPath: string, name: string): Promise<FileEntry> {
    const dir = await this.dirHandle(dirPath, true);
    const handle = await dir.getFileHandle(name, { create: true });
    const path = dirPath ? `${dirPath}/${name}` : name;
    const entry: FileEntry = { path, name, dir: dirPath, handle };
    this.files.push(entry);
    this.byPath.set(path, entry);
    this.index.set(path, { path, name, text: "" });
    return entry;
  }

  async createDir(dirPath: string, name: string): Promise<string> {
    const parent = await this.dirHandle(dirPath, true);
    await parent.getDirectoryHandle(name, { create: true });
    const path = dirPath ? `${dirPath}/${name}` : name;
    this.dirCache.delete(path);
    return path;
  }

  /** 删除文件或目录（目录递归删除） */
  async remove(path: string): Promise<void> {
    const e = this.entry(path);
    if (e) {
      const dir = await this.dirHandle(e.dir, false);
      await dir.removeEntry(e.name);
      this.files = this.files.filter((f) => f.path !== path);
      this.byPath.delete(path);
      this.index.delete(path);
      return;
    }

    // 目录
    const slash = path.lastIndexOf("/");
    const parentPath = slash < 0 ? "" : path.slice(0, slash);
    const name = slash < 0 ? path : path.slice(slash + 1);
    const dir = await this.dirHandle(parentPath, false);
    await dir.removeEntry(name, { recursive: true });
    this.files = this.files.filter((f) => !f.path.startsWith(`${path}/`));
    this.index.delete(path);
    // 清掉所有以它为前缀的目录缓存
    for (const key of [...this.dirCache.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.dirCache.delete(key);
    }
  }

  /** 目录句柄（path 为空表示根） */
  async dirHandle(path: string, create = false): Promise<FileSystemDirectoryHandle> {
    const cached = this.dirCache.get(path);
    if (cached) return cached;
    const parts = path ? path.split("/").filter(Boolean) : [];
    let cur = this.root;
    let acc = "";
    for (const p of parts) {
      cur = await cur.getDirectoryHandle(p, { create });
      acc = acc ? `${acc}/${p}` : p;
      this.dirCache.set(acc, cur);
    }
    return cur;
  }

  /**
   * 解析文档里的相对资源路径（图片等）。
   * 支持 ./a.png、../img/a.png、/abs/a.png。
   *
   * 桌面端拿到的是真实绝对路径，直接用 mdstudio://local 协议交给 Chromium 加载，
   * 不必把图片读进内存再转 blob。
   */
  async resolveAsset(src: string, docPath: string): Promise<string | null> {
    const clean = src.split(/[?#]/)[0];
    const baseDir = docPath.includes("/") ? docPath.slice(0, docPath.lastIndexOf("/")) : "";
    const rel = normalizePath(clean.startsWith("/") ? clean.slice(1) : `${baseDir}/${clean}`);
    if (rel === null) return null;

    const rootAbs = handlePath(this.root);
    if (rootAbs) {
      const bridge = nativeBridge();
      if (!bridge) return null;
      const abs = `${rootAbs}/${rel}`.replace(/\/+/g, "/");
      const ok = await bridge.exists(abs).catch(() => false);
      return ok ? localFileUrl(abs) : null;
    }

    const slash = rel.lastIndexOf("/");
    const dirPath = slash < 0 ? "" : rel.slice(0, slash);
    const fileName = slash < 0 ? rel : rel.slice(slash + 1);

    try {
      const dir = await this.dirHandle(dirPath, false);
      const fh = await dir.getFileHandle(fileName);
      const file = await fh.getFile();
      return URL.createObjectURL(file);
    } catch {
      return null;
    }
  }

  private requireEntry(path: string): FileEntry {
    const e = this.entry(path);
    if (!e) throw new Error(`文件不在工作区里: ${path}`);
    return e;
  }
}

/** 处理 .. 和 .，越界返回 null */
export function normalizePath(p: string): string | null {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

function sortTree(node: TreeNode) {
  if (!node.children) return;
  node.children.sort((a, b) => {
    const ad = a.kind === "dir" ? 0 : 1;
    const bd = b.kind === "dir" ? 0 : 1;
    return ad - bd || a.name.localeCompare(b.name, "zh");
  });
  for (const c of node.children) sortTree(c);
}

/* ---------------- 全文搜索 ---------------- */

export interface SearchHit {
  path: string;
  name: string;
  line: number;
  snippet: string;
  score: number;
}

export function searchWorkspace(ws: Workspace, query: string, limit = 80): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [];

  for (const f of ws.index.values()) {
    const lower = f.text.toLowerCase();
    const nameHit = f.name.toLowerCase().includes(q);
    let from = 0;
    let count = 0;
    while (count < 4) {
      const at = lower.indexOf(q, from);
      if (at < 0) break;
      const lineStart = f.text.lastIndexOf("\n", at) + 1;
      const lineEnd = f.text.indexOf("\n", at);
      const lineNo = countLines(f.text, lineStart);
      const lineText = f.text.slice(lineStart, lineEnd < 0 ? f.text.length : lineEnd);
      hits.push({
        path: f.path,
        name: f.name,
        line: lineNo,
        snippet: buildSnippet(lineText, at - lineStart, q.length),
        score: (nameHit ? 100 : 0) - lineNo / 1000 - count,
      });
      from = at + q.length;
      count++;
      if (hits.length > limit * 8) break;
    }
    if (nameHit && count === 0) {
      hits.push({ path: f.path, name: f.name, line: 1, snippet: "", score: 90 });
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

function countLines(text: string, upTo: number): number {
  let n = 1;
  for (let i = 0; i < upTo && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function buildSnippet(line: string, col: number, len: number): string {
  const pad = 34;
  const start = Math.max(0, col - pad);
  const end = Math.min(line.length, col + len + pad);
  const pre = line.slice(start, col);
  const mid = line.slice(col, col + len);
  const post = line.slice(col + len, end);
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `${start > 0 ? "…" : ""}${esc(pre)}<mark>${esc(mid)}</mark>${esc(post)}${
    end < line.length ? "…" : ""
  }`;
}

/* ---------------- 模糊匹配（快速打开） ---------------- */

export interface FuzzyHit {
  path: string;
  name: string;
  score: number;
}

export function fuzzyFiles(files: FileEntry[], query: string, limit = 40): FuzzyHit[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) {
    return files.slice(0, limit).map((f) => ({ path: f.path, name: f.name, score: 0 }));
  }

  const out: FuzzyHit[] = [];
  for (const f of files) {
    const path = f.path.toLowerCase();
    const base = f.name.toLowerCase();
    let total = 0;
    let ok = true;

    for (const term of terms) {
      // 文件名命中优先，没命中再退回整条路径
      let s = fuzzyScore(base, term);
      if (s > 0) {
        s += 40;
      } else {
        s = fuzzyScore(path, term);
        if (s <= 0) {
          ok = false;
          break;
        }
      }
      total += s;
    }
    if (!ok) continue;
    out.push({ path: f.path, name: f.name, score: total - path.length * 0.02 });
  }

  out.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return out.slice(0, limit);
}

/**
 * 子序列打分：
 * - 连续匹配大幅加分（"2025" 要压过 "2024x5"）
 * - 词首 / 分隔符后匹配加分
 * - 越短的路径越靠前
 */
function fuzzyScore(text: string, q: string): number {
  let ti = 0;
  let prevEnd = -1;
  let streak = 0;
  let score = 0;

  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    while (ti < text.length) {
      if (text[ti] === ch) {
        found = ti;
        break;
      }
      ti++;
    }
    if (found < 0) return 0;

    // 只有紧挨着上一个匹配才算"连续"
    streak = found === prevEnd ? streak + 1 : 0;
    const boundary = found === 0 || /[\/\-_. ]/.test(text[found - 1]);
    score += 1 + streak * 3 + (boundary ? 2 : 0);

    prevEnd = found + 1;
    ti = found + 1;
  }

  return score;
}

/** 把文档里的相对链接解析成工作区内的路径 */
export function resolveDocLink(docPath: string, href: string): string | null {
  const clean = href.split("#")[0].split("?")[0].trim();
  if (!clean) return null;
  if (clean.startsWith("/")) return normalizePath(decodeURI(clean.slice(1)));
  const baseDir = docPath.includes("/") ? docPath.slice(0, docPath.lastIndexOf("/")) : "";
  return normalizePath(decodeURI(baseDir ? `${baseDir}/${clean}` : clean));
}
