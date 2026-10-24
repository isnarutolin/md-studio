---
title: MD Studio 示例库
tags: [索引, 示例]
created: 2025-03-12
---

# MD Studio 示例库

这个文件夹用来走查 MD Studio 的各种渲染与操作能力。**你看到的就是渲染结果**——把光标点进某一行，那一行会浮出 Markdown 源码。

- [块级即时渲染是怎么做的](笔记/块级即时渲染.md)
- [图片与附件](笔记/图片与附件.md)
- [排版即信息架构](笔记/排版即信息架构.md)
- [2025-03-12 渲染引擎评审](会议/2025-03-12%20渲染引擎评审.md)
- [2025-03-05 周会](会议/2025-03-05%20周会.md)
- [旧版设想（已废弃）](归档/旧版设想.md)

## 走查清单

| 要看的点 | 怎么试 |
| :--- | :--- |
| 表格真渲染 | 光标点进上面这张表 → 变回竖线源码 |
| 图片相对路径 | 打开「图片与附件」 |
| 跨文档跳转 | 阅读模式下点上面的链接 |
| 任务列表 | 打开「周会」，点复选框 |
| 全文搜索 | `⌘⇧F` 搜「渲染」 |
| 快速打开 | `⌘P` 输 `图片` 或 `评审` |

> 提示：编辑器**没聚焦时全部渲染**。点一下正文才会进入"就地显形"的编辑状态。

---

## 一些行内格式

**粗体**、*斜体*、~~删除线~~、`行内代码`、==高亮==、[外链](https://typora.io)。

嵌套也没问题：**粗体里有 *斜体* 和 `代码`**，==高亮里也能塞 **粗体**==。

## 代码

```ts
function reveal(node: SyntaxNode, focused: boolean): Decoration {
  if (focused && onCursorLine(node)) {
    return Decoration.mark({ class: "cm-md-mark" }); // 淡色浮现
  }
  return Decoration.replace({ widget: new RenderedWidget(node) });
}
```

```python
def scan_tables(doc):
    """表格块用行扫描，比遍历语法树更稳"""
    out = []
    for i, line in enumerate(doc):
        if "|" in line and is_delimiter(doc[i + 1]):
            out.append((i, i + 1))
    return out
```

## 引用与分隔线

> 排版不是装饰。排版是**信息架构的可视化**。
>
> —— 某个深夜的想法

---

上面这条是分隔线（`---`）。把光标放到它上面，会看到源码。
