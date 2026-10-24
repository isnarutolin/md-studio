#!/usr/bin/env node
/**
 * 从 public/icons/icon-512.png 重新生成各平台图标。
 *
 * 只在需要改图标时跑一次；产物（.icns / .ico / build/icons/）已提交进仓库，
 * 所以 CI 和普通构建都不需要这个脚本。
 *
 * 依赖 macOS 自带的 sips（PNG 缩放）与 iconutil（打包 .icns）。
 *   npm run icons
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, "public", "icons", "icon-512.png");
const BUILD = join(ROOT, "build");

if (process.platform !== "darwin") {
  console.error("这个脚本用到 macOS 的 sips / iconutil。");
  console.error("图标产物已提交，非 macOS 平台无需运行。");
  process.exit(1);
}
if (!existsSync(SRC)) {
  console.error(`找不到源图：${SRC}`);
  process.exit(1);
}

const sips = (size, out) => {
  execFileSync("sips", ["-z", String(size), String(size), SRC, "--out", out], {
    stdio: "ignore",
  });
};

mkdirSync(BUILD, { recursive: true });

/* 1. macOS .icns */
const iconset = join(BUILD, "MDStudio.iconset");
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });
for (const base of [16, 32, 64, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const px = base * scale;
    if (px > 1024) continue;
    sips(px, join(iconset, `icon_${base}x${base}${scale === 2 ? "@2x" : ""}.png`));
  }
}
execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(BUILD, "MDStudio.icns")]);
console.log("✓ build/MDStudio.icns");

/* 2. Windows .ico —— ICO 容器里直接塞 PNG（Vista 以后都支持） */
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = icoSizes.map((s) => {
  const tmp = join(BUILD, `ico-${s}.png`);
  sips(s, tmp);
  return { size: s, data: readFileSync(tmp) };
});

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(pngs.length, 4);

const entries = [];
let offset = 6 + pngs.length * 16;
for (const { size, data } of pngs) {
  const e = Buffer.alloc(16);
  e.writeUInt8(size >= 256 ? 0 : size, 0); // width
  e.writeUInt8(size >= 256 ? 0 : size, 1); // height
  e.writeUInt8(0, 2); // palette
  e.writeUInt8(0, 3); // reserved
  e.writeUInt16LE(1, 4); // color planes
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  entries.push(e);
  offset += data.length;
}
writeFileSync(join(BUILD, "MDStudio.ico"), Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]));
for (const { size } of pngs) rmSync(join(BUILD, `ico-${size}.png`), { force: true });
console.log("✓ build/MDStudio.ico");

/* 3. Linux 图标目录 */
const linuxDir = join(BUILD, "icons");
rmSync(linuxDir, { recursive: true, force: true });
mkdirSync(linuxDir, { recursive: true });
for (const s of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  sips(s, join(linuxDir, `${s}x${s}.png`));
}
console.log(`✓ build/icons/ (${9} 个尺寸)`);
