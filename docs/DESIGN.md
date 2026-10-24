# 设计说明与实现细节

这份文档记录渲染引擎的设计取舍、性能实测，以及开发过程中踩过的坑。
改渲染相关代码前建议先读一遍——里面大部分条目都是"看起来没问题、实际会坏"的类型。

## 一、为什么是 CodeMirror + Decoration

Markdown 编辑器有两派做法：

| 方案 | 文档模型 | 问题 |
| --- | --- | --- |
| 富文本（ProseMirror / Lexical / Milkdown） | 存成 AST，导出时重新序列化 | 用户手写的格式细节**必然丢失**：空行、对齐、`*` 还是 `-`、缩进宽度 |
| **语法树 + 装饰层（本项目）** | 就是纯文本，渲染只是一层 Decoration | 需要自己处理大量布局细节 |

文件要进 Git、要被别的工具打开，字节级保真不可让步。所以这里选了第二条路：
**源码是唯一真相，渲染只是"看起来像结果"**。

## 二、三层装饰

| 层 | 提供方式 | 内容 | 为什么放这里 |
| --- | --- | --- | --- |
| 块级 | `StateField` | 表格、frontmatter 卡片 | CodeMirror 规定 block decoration 不能由 ViewPlugin 提供 |
| 行内 | `ViewPlugin` | 标题、强调、链接、图片、列表、代码块 | 只依赖 viewport，性能好 |
| 原子区间 | `ViewPlugin` | 被隐藏的语法符号 | 让方向键跳过不可见的 `**` |

### 显形规则

```
编辑器聚焦 && 光标所在行  → 源码淡色浮现
未聚焦 || 阅读模式        → 完整渲染
```

"未聚焦就全量渲染"是产品层面的关键决定：打开文档时不抢焦点，用户看到的是干净的排版。
焦点状态通过 `EditorView.focusChangeEffect` 写进一个 `StateField`，这样块级和行内两条路径
能拿到一致的判断依据（`StateField` 里读不到 view）。

## 三、性能实测（Chromium，单位：每次按键）

| 场景 | 规模 | 耗时 |
| --- | --- | --- |
| 示例文档 | 100 行 | < 1 ms |
| 纯段落 | 2000 行 / 81 KB | 3.1 ms |
| 1000 个表格 | 6000 行 / 52 KB | 2.0 ms |
| 500 表格 + 500 代码块 | 8500 行 / 166 KB | 5.1 ms |
| 打开文件夹 + 渲染文件树 | 201 篇 / 12 目录 | 0.13 s |
| 全文索引 201 篇 | 215 KB | 0.15 s |

关键优化：

1. **不下钻代码块子树** —— `FencedCode` 内部是嵌套语言（JS/TS）的语法树，一个代码块几百个节点。
   遍历它每次按键多花 **8.8 ms**。语法高亮由 CodeMirror 的 language 模块独立负责，跳过即可。
2. **块装饰增量维护** —— 文字改动如果没碰到含 `|` 的行、也不在前 60 行内，就 `deco.map(changes)` 平移，不全量重扫。
3. **光标移动去重** —— 用 `revealKey`（选区行号 + 阅读/聚焦状态）比对，没变就复用上一次的装饰。

## 四、踩过的坑

按遇到顺序排列，每条都真实坏过。

### 1. `Block decorations may not be specified via plugins`

判断依据是 `typeof d == "function"`：ViewPlugin 提供的装饰本质是 `view => set`，被视为
"依赖 view"，会破坏测量顺序。表格这类块级 widget 必须走 `StateField`（静态值）。

### 2. 块级 widget 上不能用垂直 margin

CodeMirror 量块高度时**不计入 margin**，但 DOM 布局会算。一个 `margin-bottom: 26px` 就让
CM 的行坐标整体偏 26px，表现是**点哪一行光标都落到下一行**。间距只能用外层 wrapper 的 `padding`。

顺带还导致"点链接跳到下一个链接的地址"——因为用 `posAtCoords` 算位置，映射整体偏移了一行。

### 3. 块级 widget 的替换区间要连行尾换行一起覆盖

否则块高度同样算小，症状同上。

### 4. 遍历代码块子树浪费 8.8ms

见上文性能优化一。

### 5. 嵌套标记会产生重叠的 replace 区间

`***粗斜***` 之类会产生重叠区间，`Decoration.set` 会抛异常。需要对 `hidden` 区间排序去重。

### 6. 行装饰必须合并

同一行既要 `cm-h2` 又要 `cm-quote` 时，要聚合成**一个** `Decoration.line`（class 用空格拼接），否则冲突。

### 7. 模糊搜索的"连续匹配"不能跨间隔累加

否则搜 `2025` 会把 `笔记/2024/doc-045.md` 排在 `笔记/2025/...` 前面。
只有紧挨着的匹配才算连续。

### 8. `window.prompt` 在 Electron 里不存在

重命名/删除最初用 `prompt` 实现，浏览器里正常，打包成客户端后一点就**静默失败**
（Electron 只提供 `alert` / `confirm`）。改成应用内输入框 + 右键菜单。

### 9. 垫片的 `getFileHandle(name, {create:true})` 必须真的建文件

浏览器里它会落盘，Node 垫片如果只返回句柄，"新建文档"看起来成功、磁盘上什么都没有。

### 10. 重绘文件树会丢焦点

给树行绑 `onkeydown` 后，打开文件触发 `renderTree()` 重建节点，F2/Delete 收不到事件。
改成全局键盘处理 + 重绘后恢复选中态。

### 11. `if (!el?.hasAttribute("hidden")) return` 的坑

弹窗元素是惰性创建的，从未弹过时 `querySelector` 返回 `null`，`!undefined` 为真，
导致全局快捷键**永远**提前返回。要显式判 `null`。

### 12. `⌘O` 和 Finder 双击走的是不同代码路径

给其中一个加了功能后，另一个没加——而测试恰好只测了前者。**测试要从"用户点哪里"倒推，
而不是从"我改了什么"顺推。**

### 13. `lastWorkspace` 指向已删除的目录

启动时恢复出一个"空壳工作区"：名字还在、树是空的。现在启动会先确认目录存在。

### 14. `requestSingleInstanceLock()` 让第二个实例静默退出

已安装版在跑时，`electron .` 会立即 `exit(0)`，看起来像启动失败。测试前必须先退掉安装版。

## 五、桌面端实现

```
渲染进程（workspace.ts / main.ts）   ← 业务代码一行未改
      ↓ 调用 File System Access API
src/native-fsa.ts    ← 用 Node fs 垫出 FSA 形状的句柄
      ↓ IPC
electron/main.cjs    ← 对话框 / fs / fs.watch / 自定义协议
```

三个关键决定：

1. **垫 FSA 而不是重写文件层** —— 业务代码是照 FSA 写的、已被测试覆盖，垫一层全复用。
2. **自定义协议 `mdstudio://app/`** —— 不能用 `file://`（ES module 会被 CORS 拦）；
   固定 origin 才能让 IndexedDB 记住上次工作区。
3. **`mdstudio://local/<绝对路径>` 直接服务磁盘文件** —— 图片不读进内存转 blob，
   交给 Chromium 自己缓存。**只放行媒体扩展名**，否则等于给渲染层开了"读任意本地文件"的口子。

窗口安全配置：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，
preload 只通过 `contextBridge` 暴露一组窄接口。

## 六、测试

```bash
npm test           # 渲染、表格解析、导出、搜索排序、路径解析
npm run typecheck
```

单元测试覆盖纯函数部分（`markdown-render`、`workspace` 的搜索与路径逻辑），
UI 与渲染引擎的手工走查清单见 README。

## 七、目录

```
src/
├── main.ts              装配、文件读写、树/搜索/面板、快捷键
├── live-preview.ts      渲染引擎：三层装饰
├── workspace.ts         工作区：扫描、读写、索引、搜索、模糊匹配
├── widgets.ts           表格、图片、复选框、语言标签、frontmatter 卡片
├── markdown-render.ts   行内渲染 + 表格解析 + 导出 HTML
├── highlight-syntax.ts  `==高亮==` 的 Lezer 行内解析器
├── native-fsa.ts        桌面端：用 Node fs 垫出 FSA 形状的句柄
├── dialogs.ts           应用内输入框 / 确认框 / 右键菜单
├── assets.ts            相对路径资源解析（带缓存）
├── persist.ts           IndexedDB：目录句柄与偏好设置
├── theme.ts             CodeMirror 主题与语法配色
└── style.css            排版与视觉

electron/                主进程与 preload
scripts/                 静态服务器、图标生成、登录启动项
tests/                   单元测试
```
