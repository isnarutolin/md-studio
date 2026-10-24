/** 图片等相对路径资源的解析：把 workspace 里的文件转成 blob URL */

export type Resolver = (src: string) => Promise<string | null>;

let resolver: Resolver | null = null;
const cache = new Map<string, string>();

/** 当前文档路径，用于解析 ./ 和 ../ */
let docPath = "";

export function setAssetResolver(r: Resolver | null) {
  revokeAll();
  resolver = r;
}

export function hasAssetResolver(): boolean {
  return resolver !== null;
}

export function setCurrentDocPath(p: string) {
  docPath = p;
}

export function currentDocPath(): string {
  return docPath;
}

export function isRemoteSrc(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//");
}

function revokeAll() {
  for (const url of cache.values()) {
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }
  cache.clear();
}

/** 同步拿到已有的 URL（有缓存时立刻返回，避免图片闪烁） */
export function peekAsset(src: string): string | null {
  if (!src) return null;
  if (isRemoteSrc(src)) return src;
  return cache.get(key(src)) ?? null;
}

function key(src: string) {
  return `${docPath}|${src}`;
}

/**
 * 解析并缓存。远程地址/ data URI 直接返回；
 * 相对路径交给 workspace 的 root handle 去找。
 */
export async function resolveAsset(src: string): Promise<string | null> {
  if (!src) return null;
  if (isRemoteSrc(src)) return src;

  const k = key(src);
  const hit = cache.get(k);
  if (hit) return hit;
  if (!resolver) return null;

  const url = await resolver(src);
  if (url) cache.set(k, url);
  return url;
}

export function clearAssetCache() {
  revokeAll();
}
