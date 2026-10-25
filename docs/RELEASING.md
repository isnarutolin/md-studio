# 发版流程

给维护者自己看的。踩过的坑都在最后。

## 一、发一版

```bash
# 1. 确认主干是绿的
npm run typecheck && npm test && npm run build

# 2. 改版本号（三处要一致：package.json、CHANGELOG、tag）
npm version 0.2.0 --no-git-tag-version

# 3. 更新 CHANGELOG.md，把「未发布」的小节落成正式版本

# 4. 提交并打 tag
git add -A && git commit -m "chore: 0.2.0"
git tag -a v0.2.0 -m "v0.2.0"
git push origin main && git push origin v0.2.0
```

推 tag 会触发 `.github/workflows/release.yml`：

1. 在 macOS / Windows / Linux 三个 runner 上并行打包
2. 上传产物 artifact
3. `publish` job 汇总，创建 **Draft Release**

约 5～10 分钟。跑完去 **Releases** 页面：

- 检查 6 个产物是否都在（mac 的 dmg+zip 各两种架构、win 的 exe、linux 的 AppImage）
- 把 `CHANGELOG.md` 里对应版本的正文粘进 Release 说明
- 至少下载一个包真机验一遍
- 点 **Publish release**

## 二、发布后自检

```bash
# 产物类型对不对（不用整个下载，只取头部魔数）
for f in MD.Studio.Setup.0.2.0.exe MD.Studio-0.2.0.AppImage; do
  curl -sL -r 0-3 "https://github.com/isnarutolin/md-workspace/releases/download/v0.2.0/$f" | xxd -p
done
# PE = 4d5a...   ELF = 7f454c46

# 网页版是否活着
curl -s -o /dev/null -w '%{http_code}\n' https://isnarutolin.github.io/md-workspace/
```

macOS 的 dmg 建议真机走一遍完整流程：

```bash
curl -sL -o /tmp/t.dmg "<dmg 地址>"
hdiutil attach -nobrowse /tmp/t.dmg
cp -R "/Volumes/MD Studio 0.2.0-arm64/MD Studio.app" /tmp/
"/tmp/MD Studio.app/Contents/MacOS/MD Studio" --remote-debugging-port=9230
# 另开一个终端：curl -s http://127.0.0.1:9230/json/version
```

## 三、踩过的坑

### 1. 锁文件必须用公网 registry 生成

如果本机 `~/.npmrc` 指向公司内网源，`npm install` 生成的 `package-lock.json`
里所有 `resolved` URL 都会是内网地址 —— **外部用户和 GitHub Actions 全都装不上**，
而且 npm 只会报一句误导性的 `Exit handler never called!`。

仓库里已经放了 `.npmrc`（`registry=https://registry.npmjs.org/`），优先级高于用户全局配置，
所以日常开发不受影响。但**换机器/换网络后第一次 `npm install` 前**建议先确认：

```bash
grep -c artifactory package-lock.json   # 应该是 0
```

万一又混进去了，重置姿势：

```bash
rm -rf node_modules package-lock.json
npm install --package-lock-only   # 会走仓库级 .npmrc 的公网源
npm ci
```

### 2. Node 版本

`electron@45` 要 Node ≥ 22.12，`vitest@5` 要 ^22.12。`.nvmrc` 里钉的是 22.12，
三个 workflow 也都是 Node 22。用 Node 20 会出现"依赖装不完整 → tsc 找不到 vite 类型"。

### 3. `--ignore-scripts`

CI 里 `npm ci` 一律加 `--ignore-scripts`：项目不依赖任何 postinstall 产物
（esbuild 平台二进制走 optionalDependencies，electron 二进制由 electron-builder 自己下载），
同时也避免执行第三方依赖的任意安装脚本。

### 4. 未签名

没有代码签名证书，`electron-builder` 会跳过签名（CI 里设了
`CSC_IDENTITY_AUTO_DISCOVERY: false`）。macOS 用户首次打开要右键→打开，
README 里已经写清楚。要消除这个提示需要 Apple Developer（$99/年）。

### 5. 单实例锁会干扰本地调试

`app.requestSingleInstanceLock()` 生效时，如果 `/Applications` 里那份正在跑，
`npm run app` 会**静默 exit(0)**，看起来像启动失败。调试前先退掉安装版：

```bash
pkill -f "/Applications/MD Studio.app"
```

### 6. Apple Silicon 上别用 Rosetta 测 x64 包

`release/mac/` 是 x64（Rosetta），`release/mac-arm64/` 是原生。在 M 系列机器上跑 x64 包
会出现行内装饰不渲染（语法树为空），但原生包正常。要验 x64 请在真 Intel 机器上验。

### 7. Pages 需要在仓库设置里先启用

`Settings → Pages → Source` 选 **GitHub Actions**，否则 `configure-pages` 步骤会失败。
启用后 push 到 main 会自动部署，也可以在 Actions 页面用 **Run workflow** 手动触发。
