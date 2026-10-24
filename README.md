# MD Studio

**本地 Markdown 工作台** —— 打开文件夹就能浏览、修订、管理你所有的 `.md`。
块级即时渲染（光标在哪行，哪行才浮出源码），文件留在原地，不导入、不迁移、不改格式。

![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)
![license](https://img.shields.io/badge/license-MIT-blue)
![electron](https://img.shields.io/badge/electron-45-47848F)

![总览](docs/screenshots/01-overview.png)

<table>
<tr>
<td width="50%"><img src="docs/screenshots/02-table-code.png" alt="表格与代码块"></td>
<td width="50%"><img src="docs/screenshots/04-search.png" alt="全文搜索"></td>
</tr>
<tr>
<td><img src="docs/screenshots/03-inline-reveal.png" alt="就地显形"></td>
<td><img src="docs/screenshots/05-dark.png" alt="深色主题"></td>
</tr>
</table>

---

## 为什么不是又一个 Markdown 编辑器

日常用 Markdown 的场合太多了：会议记录、技术方案、读书笔记、周报、草稿。但工具通常是割裂的——**浏览**要文件管理器，**修订**要编辑器，**管理**要另一个工具。而且大多数编辑器把源码和结果分成两栏，你的眼睛要不停地在两个坐标系之间翻译。

这个工具只做三件事，但每件都做到底：

| | 做法 |
| --- | --- |
| **浏览** | 打开文件夹就有文件树；表格是真表格、图片是真图片，不用切预览 |
| **修订** | 光标停在哪一行，哪一行才浮出源码；离开就还原成排版结果 |
| **管理** | 全文搜索、快速打开、右键重命名/删除、自动保存——全部对着本地文件夹实时落盘 |

三个和 Typora 不一样的地方：

1. **编辑器失去焦点时全量渲染** —— 打开文档不抢焦点，你看到的是干净的排版，而不是"第一行标题露着 `#`"
2. **语法符号淡色浮现** —— 不是粗暴隐藏，你始终知道自己写了什么
3. **渲染块点一下就回到源码** —— 表格、复选框、frontmatter 卡片都能直接点进去改

## 下载

到 [Releases](../../releases) 下载对应平台的安装包：

| 平台 | 文件 |
| --- | --- |
| macOS（Apple Silicon） | `MD Studio-x.y.z-arm64.dmg` |
| macOS（Intel） | `MD Studio-x.y.z.dmg` |
| Windows | `MD Studio Setup x.y.z.exe` |
| Linux | `MD Studio-x.y.z.AppImage` |

> **未签名说明**：项目没有购买代码签名证书。
> macOS 首次打开若提示"未验证的开发者"，**右键 → 打开**即可；或执行
> `xattr -dr com.apple.quarantine "/Applications/MD Studio.app"`。
> Windows 首次运行可能出现 SmartScreen 提示，点"更多信息 → 仍要运行"。

## 从源码构建

需要 Node.js ≥ 20。

```bash
git clone https://github.com/isnarutolin/md-studio.git
cd md-studio
npm install
npm run build
npm run app        # 直接以桌面客户端运行
```

打包安装包（产物在 `release/`）：

```bash
npm run dist:mac     # .dmg + .zip（arm64 & x64）
npm run dist:win     # NSIS 安装器
npm run dist:linux   # AppImage
```

也可以**只用网页版**（免安装，需要 Chrome / Edge）：

```bash
npm run build
npm run serve        # http://localhost:5273
```

## 快捷键

| 操作 | 快捷键 |
| --- | --- |
| 新建文档 / 打开文件 / 打开文件夹 | `⌘N` / `⌘O` / `⇧⌘O` |
| 快速打开（模糊搜索，支持空格分词） | `⌘P` |
| 全文搜索 | `⇧⌘F` |
| 保存 | `⌘S`（也会自动保存） |
| 阅读模式 / 源码模式 | `⇧⌘R` / `⌘E` |
| 专注模式 / 切换主题 | `⇧⌘F` / `⇧⌘L` |
| 文件树里：重命名 / 删除 / 打开 | `F2` / `⌫` / `Enter` |

## 支持的内容

标题、粗体斜体删除线、`行内代码`、==高亮==、链接、图片（含相对路径）、有序/无序/嵌套列表、任务列表（可点）、表格（对齐）、代码块（嵌套语法高亮 + 语言标签）、引用、分隔线、YAML frontmatter（渲染成属性卡）、跨文档链接跳转。

## 工作原理（简述）

```
文档文本 ──► Lezer 语法树 ──► Decoration 装饰层 ──► DOM
                  ▲
     聚焦 + 光标所在行 → 源码淡色浮现
     其余情况（未聚焦 / 阅读模式）→ 完整渲染
```

- 渲染**不改文档模型**，源码永远是唯一真相 —— 导出/进 Git 时字节级保真
- 三层装饰：块级（`StateField`，表格/frontmatter）、行内（`ViewPlugin`）、原子区间（让方向键跳过隐藏的 `**`）
- 桌面端用 Electron，但**没有重写渲染代码**：在 preload 里用 Node `fs` 垫出一套 File System Access API，业务层一行未改，同时拿到真实路径、免授权、文件监听

细节、性能实测和踩过的坑都在 [docs/DESIGN.md](docs/DESIGN.md)。

## 已知限制

1. **`[[wiki 链接]]` 与脚注未实现**（需要自定义 Lezer 解析器）；`==高亮==` 是自己加的行内语法，别的工具不认
2. **目录不支持重命名**（文件可以）
3. **单文件模式下相对图片**：桌面端会自动挂出所在目录，所以能用；**网页版**拿不到父目录（浏览器 API 限制），图片会显示占位提示
4. **没有 Git 集成 / 版本历史**
5. **未签名**，安装包体积约 100MB+（Electron 运行时）

## 路线图

- [ ] KaTeX 数学公式
- [ ] 标签与反链（frontmatter `tags` + `[[链接]]`）
- [ ] 目录重命名、拖拽移动文件
- [ ] 结果缓存到 IndexedDB（上千篇文档时免去每次重建索引）
- [ ] 换 Tauri 瘦身（~10MB，顺带更快启动）

## 贡献

欢迎 issue 和 PR。开发流程：

```bash
npm run dev        # Vite 开发服务器（5274，带热更新）
npm run typecheck  # 类型检查
npm test           # 单元测试（渲染与搜索逻辑）
npm run app:dev    # 在 Electron 里热调试
```

改动渲染引擎时请特别注意 [docs/DESIGN.md](docs/DESIGN.md) 里记录的几个 CodeMirror 陷阱。

## 许可

[MIT](LICENSE)
