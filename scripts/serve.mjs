#!/usr/bin/env node
/**
 * MD Studio 本地服务器
 * 零依赖，只服务 dist/ 目录，绑定 127.0.0.1。
 *
 * 用法：
 *   node scripts/serve.mjs            # 默认 5273
 *   node scripts/serve.mjs --port 5300
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../dist", import.meta.url));
const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : Number(process.env.PORT) || 5273;
const HOST = "127.0.0.1";

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
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

/** 防止 ../ 越出 dist/ */
function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
  const full = join(ROOT, rel);
  if (!full.startsWith(ROOT + sep) && full !== ROOT) return null;
  return full;
}

async function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return send(res, 405, "Method Not Allowed");
    }

    let filePath = safePath(req.url === "/" ? "/index.html" : req.url);
    if (!filePath) return send(res, 400, "Bad Request");

    let info = await stat(filePath).catch(() => null);
    if (info?.isDirectory()) {
      filePath = join(filePath, "index.html");
      info = await stat(filePath).catch(() => null);
    }
    // SPA 兜底
    if (!info) {
      filePath = join(ROOT, "index.html");
      info = await stat(filePath).catch(() => null);
      if (!info) return send(res, 404, "dist/ 不存在，请先 npm run build");
    }

    const ext = extname(filePath).toLowerCase();
    const isHtml = ext === ".html";
    // html 不缓存（改完刷新就生效），其余资源带 hash 可以长缓存
    const cacheControl = isHtml
      ? "no-cache, must-revalidate"
      : ext === ".webmanifest" || ext === ".js"
        ? "no-cache"
        : "public, max-age=31536000, immutable";

    const data = await readFile(filePath);
    return send(res, 200, req.method === "HEAD" ? undefined : data, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": cacheControl,
      "Content-Length": data.length,
    });
  } catch (e) {
    return send(res, 500, `Internal Error: ${e.message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`MD Studio  →  http://${HOST}:${PORT}/   (serving ${ROOT})`);
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`端口 ${PORT} 已被占用`);
    process.exit(1);
  }
  throw e;
});
