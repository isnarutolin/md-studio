/**
 * 在 Electron 里用 Node 文件系统垫出一套 File System Access API。
 *
 * 这么做的原因：workspace.ts / main.ts 是照着 FSA 写的（并且已经被测过），
 * 垫一层就不用改业务代码，同时还白拿三个好处：
 *   1. 没有权限授权弹窗
 *   2. 拿得到真实绝对路径（图片可以直接用 mdstudio://local/ 协议加载）
 *   3. 可以做真实文件监听
 */

interface NativeBridge {
  isNative: true;
  platform: string;
  pickDirectory(): Promise<string | null>;
  pickFile(): Promise<string | null>;
  pickSavePath(name?: string): Promise<string | null>;
  listDir(dir: string): Promise<{ name: string; kind: "file" | "directory" }[]>;
  read(p: string): Promise<string>;
  write(p: string, text: string): Promise<boolean>;
  stat(p: string): Promise<{ size: number; lastModified: number; isDirectory: boolean }>;
  exists(p: string): Promise<boolean>;
  mkdirp(p: string): Promise<boolean>;
  create(dir: string, name: string): Promise<string>;
  remove(p: string): Promise<boolean>;
  watch(root: string): Promise<boolean>;
  unwatch(): Promise<boolean>;
  onFsChanged(fn: (p: { root: string; files: string[] }) => void): void;
  onOpenFile(fn: (p: string) => void): void;
  onMenu(name: string, fn: () => void): void;
  info(): Promise<{ version: string; platform: string; home: string }>;
  reveal(p: string): Promise<boolean>;
  openExternal(url: string): Promise<boolean>;
}

declare global {
  interface Window {
    mdNative?: NativeBridge;
  }
}

/** 带真实绝对路径的句柄 */
export interface NativeHandleMeta {
  __path: string;
  __native: true;
}

export function nativeBridge(): NativeBridge | null {
  return typeof window !== "undefined" && window.mdNative?.isNative ? window.mdNative : null;
}

export function isNative(): boolean {
  return nativeBridge() !== null;
}

export function handlePath(h: unknown): string | null {
  const p = (h as NativeHandleMeta | null)?.__path;
  return typeof p === "string" ? p : null;
}

/** 绝对路径 → 可直接放进 <img src> 的 URL */
export function localFileUrl(absPath: string): string {
  return `mdstudio://local${encodeURI(absPath)}`;
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i <= 0 ? "/" : p.slice(0, i);
}

/* ---------------- 句柄实现 ---------------- */

class NativeFileHandle {
  readonly kind = "file" as const;
  readonly __native = true as const;
  readonly __path: string;

  constructor(
    readonly name: string,
    path: string,
    private bridge: NativeBridge
  ) {
    this.__path = path;
  }

  async getFile(): Promise<File> {
    const [text, st] = await Promise.all([
      this.bridge.read(this.__path),
      this.bridge.stat(this.__path),
    ]);
    return new File([text], this.name, {
      lastModified: Math.round(st.lastModified),
      type: "text/markdown",
    });
  }

  async createWritable() {
    const bridge = this.bridge;
    const p = this.__path;
    let buffer = "";
    return {
      async write(data: string) {
        buffer = data;
      },
      async close() {
        await bridge.write(p, buffer);
      },
    };
  }

  async isSameEntry(other: unknown): Promise<boolean> {
    return (other as NativeHandleMeta | null)?.__path === this.__path;
  }

  async queryPermission() {
    return "granted" as PermissionState;
  }

  async requestPermission() {
    return "granted" as PermissionState;
  }
}

class NativeDirHandle {
  readonly kind = "directory" as const;
  readonly __native = true as const;
  readonly __path: string;

  constructor(
    readonly name: string,
    path: string,
    private bridge: NativeBridge
  ) {
    this.__path = path;
  }

  async *values(): AsyncGenerator<NativeFileHandle | NativeDirHandle> {
    const entries = await this.bridge.listDir(this.__path);
    for (const e of entries) {
      const p = joinPath(this.__path, e.name);
      yield e.kind === "directory"
        ? new NativeDirHandle(e.name, p, this.bridge)
        : new NativeFileHandle(e.name, p, this.bridge);
    }
  }

  async entries() {
    const out: [string, NativeFileHandle | NativeDirHandle][] = [];
    for await (const h of this.values()) out.push([h.name, h]);
    return out.entries();
  }

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<NativeDirHandle> {
    const p = joinPath(this.__path, name);
    if (opts?.create) {
      await this.bridge.mkdirp(p);
    } else if (!(await this.bridge.exists(p))) {
      throw new DOMException(`目录不存在: ${name}`, "NotFoundError");
    }
    return new NativeDirHandle(name, p, this.bridge);
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<NativeFileHandle> {
    const p = joinPath(this.__path, name);
    if (opts?.create) {
      // 浏览器里 create:true 会真的建文件，垫片必须同样落盘，否则新建是空的
      await this.bridge.create(this.__path, name);
    } else if (!(await this.bridge.exists(p))) {
      throw new DOMException(`文件不存在: ${name}`, "NotFoundError");
    }
    return new NativeFileHandle(name, p, this.bridge);
  }

  async removeEntry(name: string, opts?: { recursive?: boolean }) {
    const target = joinPath(this.__path, name);
    const st = await this.bridge.stat(target).catch(() => null);
    if (st?.isDirectory && !opts?.recursive) {
      throw new DOMException("目录非空，需要 recursive", "InvalidModificationError");
    }
    await this.bridge.remove(target);
  }

  async isSameEntry(other: unknown): Promise<boolean> {
    return (other as NativeHandleMeta | null)?.__path === this.__path;
  }

  async queryPermission() {
    return "granted" as PermissionState;
  }

  async requestPermission() {
    return "granted" as PermissionState;
  }
}

/* ---------------- 从路径还原句柄 / 安装垫片 ---------------- */

export function dirHandleFromPath(absPath: string): FileSystemDirectoryHandle | null {
  const bridge = nativeBridge();
  if (!bridge) return null;
  const name = absPath.split(/[/\\]/).filter(Boolean).pop() ?? absPath;
  return new NativeDirHandle(name, absPath, bridge) as unknown as FileSystemDirectoryHandle;
}

export function fileHandleFromPath(absPath: string): FileSystemFileHandle | null {
  const bridge = nativeBridge();
  if (!bridge) return null;
  const name = absPath.split(/[/\\]/).filter(Boolean).pop() ?? absPath;
  return new NativeFileHandle(name, absPath, bridge) as unknown as FileSystemFileHandle;
}

/** 取父目录；已经是根就返回空串 */
export function parentDirOf(absPath: string): string {
  const d = dirname(absPath);
  return d === "/" && !absPath.startsWith("/") ? "" : d;
}

export function fileRelativeName(absPath: string): string {
  return absPath.split(/[/\\]/).filter(Boolean).pop() ?? absPath;
}

/**
 * 装上 showDirectoryPicker / showOpenFilePicker 的替代实现。
 * 必须在 app 启动前调用。
 */
export function installNativeFsa(): boolean {
  const bridge = nativeBridge();
  if (!bridge) return false;

  const w = window as unknown as {
    showDirectoryPicker?: (o?: unknown) => Promise<FileSystemDirectoryHandle>;
    showOpenFilePicker?: (o?: unknown) => Promise<FileSystemFileHandle[]>;
  };

  w.showDirectoryPicker = async () => {
    const dir = await bridge.pickDirectory();
    if (!dir) throw new DOMException("用户取消", "AbortError");
    const h = dirHandleFromPath(dir);
    if (!h) throw new DOMException("无法打开目录", "NotFoundError");
    return h;
  };

  w.showOpenFilePicker = async () => {
    const file = await bridge.pickFile();
    if (!file) throw new DOMException("用户取消", "AbortError");
    const h = fileHandleFromPath(file);
    if (!h) throw new DOMException("无法打开文件", "NotFoundError");
    return [h];
  };

  return true;
}
