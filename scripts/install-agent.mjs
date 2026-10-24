#!/usr/bin/env node
/**
 * 把本地服务器注册成 macOS 登录启动项（launchd LaunchAgent）。
 * 之后开机自动在 http://localhost:5273 提供服务，不用管终端。
 *
 *   npm run agent:install
 *   npm run agent:status
 *   npm run agent:remove
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LABEL = "com.mdstudio.server";
const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVE = join(PROJECT, "scripts", "serve.mjs");
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG_DIR = join(homedir(), "Library", "Logs");
const OUT_LOG = join(LOG_DIR, "mdstudio.out.log");
const ERR_LOG = join(LOG_DIR, "mdstudio.err.log");

const NODE = process.execPath;

function gui() {
  return `gui/${process.getuid()}`;
}

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    return (e.stdout ?? "") + (e.stderr ?? "");
  }
}

function buildPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${SERVE}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${OUT_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${ERR_LOG}</string>
</dict>
</plist>
`;
}

function install() {
  if (process.platform !== "darwin") {
    console.error("这个脚本只支持 macOS。Linux 请用 systemd --user。");
    process.exit(1);
  }
  if (!existsSync(join(PROJECT, "dist", "index.html"))) {
    console.error("dist/ 还没构建，先跑：npm run build");
    process.exit(1);
  }

  mkdirSync(dirname(PLIST), { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(PLIST, buildPlist(), "utf8");
  console.log(`写入 ${PLIST}`);

  sh("launchctl", ["bootout", gui(), PLIST]);
  const out = sh("launchctl", ["bootstrap", gui(), PLIST]);
  if (out) console.log(out);

  setTimeout(() => {
    const status = sh("launchctl", ["print", `${gui()}/${LABEL}`]);
    if (status.includes("state = running")) {
      console.log("✅ 已启动。打开 http://localhost:5273/");
      console.log("   以后开机自动运行，关掉终端也不影响。");
    } else {
      console.log("⚠️ 状态未知，检查日志：", ERR_LOG);
      console.log(status.split("\n").slice(0, 6).join("\n"));
    }
  }, 700);
}

function remove() {
  sh("launchctl", ["bootout", gui(), PLIST]);
  if (existsSync(PLIST)) rmSync(PLIST);
  console.log("已卸载登录启动项。");
}

function status() {
  if (!existsSync(PLIST)) {
    console.log("未安装。运行 npm run agent:install");
    return;
  }
  const out = sh("launchctl", ["print", `${gui()}/${LABEL}`]);
  const running = out.includes("state = running");
  console.log(`plist : ${PLIST}`);
  console.log(`state : ${running ? "running" : "not running"}`);
  console.log(`日志  : ${OUT_LOG}`);
}

const cmd = process.argv[2] ?? "status";
if (cmd === "install") install();
else if (cmd === "remove") remove();
else status();
