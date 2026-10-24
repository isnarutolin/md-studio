import { syntaxTree } from "@codemirror/language";
import { ChangeSet, EditorState, Extension, Range, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import {
  BulletWidget,
  CheckboxWidget,
  CodeLangWidget,
  EmptyWidget,
  FrontmatterWidget,
  HrWidget,
  ImageWidget,
  TableWidget,
} from "./widgets";

/* ==================================================================
   MD Studio · 块级即时渲染引擎

   设计要点：
   1. 光标所在行 → 显示源码，语法符号淡色浮现
   2. 其余行     → 渲染成最终形态（粗体真粗、表格真表格、图片真图片）
   3. 表格是 block decoration，按 CodeMirror 规则必须由 StateField
      提供（ViewPlugin 供的装饰被视为 view 相关，不允许改动块级布局）。
   ================================================================== */

const MARK_CLASS = "cm-md-mark";
const TABLE_SCAN_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;

/* 阅读模式：不因光标而显形，全部渲染 */
export const setReading = StateEffect.define<boolean>();

export const readingField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setReading)) return e.value;
    return value;
  },
});

function readFlag(state: EditorState): boolean {
  return state.field(readingField, false) ?? false;
}

function isReading(state: EditorState): boolean {
  return state.field(readingField, false) ?? false;
}

/** 扫描文档里的表格块（避免依赖语法树，性能稳定） */
export interface TableBlock {
  from: number;
  to: number;
  firstLine: number;
  lastLine: number;
}

export function scanTables(state: EditorState): TableBlock[] {
  const doc = state.doc;
  const out: TableBlock[] = [];
  let i = 1;
  while (i < doc.lines) {
    const head = doc.line(i);
    const next = doc.line(i + 1);
    if (head.text.includes("|") && TABLE_SCAN_RE.test(next.text)) {
      let last = i + 1;
      while (last + 1 <= doc.lines) {
        const l = doc.line(last + 1);
        if (!l.text.trim() || !l.text.includes("|")) break;
        last++;
      }
      out.push({
        from: head.from,
        to: doc.line(last).to,
        firstLine: i,
        lastLine: last,
      });
      i = last + 1;
      continue;
    }
    i++;
  }
  return out;
}

/* 聚焦状态：未聚焦 => 全量渲染，不做“就地显形” */
const setFocused = StateEffect.define<boolean>();

const focusField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFocused)) return e.value;
    return value;
  },
});

function isFocused(state: EditorState): boolean {
  return state.field(focusField, false) ?? false;
}

function revealedLines(state: EditorState): Set<number> {
  const set = new Set<number>();
  if (isReading(state) || !isFocused(state)) return set;
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let i = a; i <= b; i++) set.add(i);
  }
  return set;
}

/** 开头 YAML frontmatter 的范围 */
export function scanFrontmatter(state: EditorState): { from: number; to: number; firstLine: number; lastLine: number } | null {
  const doc = state.doc;
  if (doc.lines < 2) return null;
  if (doc.line(1).text.trim() !== "---") return null;
  for (let i = 2; i <= Math.min(doc.lines, 60); i++) {
    const t = doc.line(i).text.trim();
    if (t === "---" || t === "...") {
      return { from: doc.line(1).from, to: doc.line(i).to, firstLine: 1, lastLine: i };
    }
  }
  return null;
}

/* ------------------------------------------------------------------
   1) 块级装饰（StateField）：表格 → <table>，frontmatter → 属性卡片
   ------------------------------------------------------------------ */

interface BlockValue {
  decos: DecorationSet;
  key: string;
}

const blockField = StateField.define<BlockValue>({
  create: (state) => {
    const key = revealKey(state);
    return { decos: buildBlockDecos(state), key };
  },
  update(value, tr) {
    const readingChanged = readFlag(tr.startState) !== readFlag(tr.state);
    const focusChanged = isFocused(tr.startState) !== isFocused(tr.state);

    // 1) 纯光标移动：只有“被激活的行”变了才需要重建
    if (!tr.docChanged && !readingChanged && !focusChanged) {
      const key = revealKey(tr.state);
      if (key === value.key) return value;
      return { decos: buildBlockDecos(tr.state), key };
    }

    // 2) 文字变动但不涉及表格/frontmatter 结构：平移现有装饰即可（O(changes)）
    if (tr.docChanged && !readingChanged && !focusChanged && !touchesBlockSyntax(tr)) {
      const key = revealKey(tr.state);
      return { decos: value.decos.map(tr.changes), key };
    }

    // 3) 其余情况全量重建
    const key = revealKey(tr.state);
    return { decos: buildBlockDecos(tr.state), key };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});

function revealKey(state: EditorState): string {
  if (isReading(state)) return "R";
  if (!isFocused(state)) return "NF";
  let key = "";
  for (const r of state.selection.ranges) {
    key += `${state.doc.lineAt(r.from).number}-${state.doc.lineAt(r.to).number};`;
  }
  return key;
}

/** 改动是否可能影响“表格 / frontmatter”的结构（保守判断） */
function touchesBlockSyntax(tr: { changes: ChangeSet; state: EditorState; startState: EditorState }) {
  const newDoc = tr.state.doc;
  let affected = false;

  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    if (affected) return;
    const a = newDoc.lineAt(Math.min(fromB, newDoc.length)).number;
    const b = newDoc.lineAt(Math.min(toB, newDoc.length)).number;
    // 看改动行以及上下相邻一行有没有 '|'（表格或分隔行）
    for (let i = Math.max(1, a - 1); i <= Math.min(newDoc.lines, b + 1); i++) {
      if (newDoc.line(i).text.includes("|")) {
        affected = true;
        return;
      }
    }
  });

  // frontmatter 只可能出现在开头，改动落在前 60 行内就重建（很便宜）
  if (!affected) {
    tr.changes.iterChangedRanges((_fromA, _toA, fromB) => {
      if (newDoc.lineAt(Math.min(fromB, newDoc.length)).number <= 60) affected = true;
    });
  }
  return affected;
}

function buildBlockDecos(state: EditorState): DecorationSet {
  const doc = state.doc;
  const revealed = revealedLines(state);
  const decos: Range<Decoration>[] = [];

  const isRevealed = (firstLine: number, lastLine: number) => {
    for (let i = firstLine; i <= lastLine; i++) if (revealed.has(i)) return true;
    return false;
  };

  /**
   * 块级 widget 的替换区间必须覆盖完整行**连同行尾换行**，
   * 否则 CodeMirror 算出来的块高度会偏小，导致之后所有内容的
   * 坐标整体偏移——表现就是"点哪一行光标都落到下一行"。
   */
  const lineRangeEnd = (lastLine: number) =>
    lastLine < doc.lines ? doc.line(lastLine + 1).from : doc.line(lastLine).to;

  const fm = scanFrontmatter(state);
  if (fm && !isRevealed(fm.firstLine, fm.lastLine)) {
    decos.push(
      Decoration.replace({
        widget: new FrontmatterWidget(state.sliceDoc(fm.from, fm.to), fm.from),
        block: true,
      }).range(fm.from, lineRangeEnd(fm.lastLine))
    );
  }

  for (const t of scanTables(state)) {
    if (isRevealed(t.firstLine, t.lastLine)) continue;
    decos.push(
      Decoration.replace({
        widget: new TableWidget(state.sliceDoc(t.from, t.to), t.from),
        block: true,
      }).range(t.from, lineRangeEnd(t.lastLine))
    );
  }
  return Decoration.set(decos, true);
}

/* ------------------------------------------------------------------
   2) 行内装饰：标题 / 强调 / 链接 / 列表 / 代码块 / 图片 …
   ------------------------------------------------------------------ */

interface Built {
  inline: DecorationSet;
  lines: DecorationSet;
  atomic: DecorationSet;
}

function buildInline(view: EditorView): Built {
  const state = view.state;
  const doc = state.doc;
  // 编辑器没聚焦时不做"就地显形"——打开文档 / 点到侧栏，得到的是干净的渲染结果
  const revealed = revealedLines(state);

  const inline: Range<Decoration>[] = [];
  const hidden: { from: number; to: number }[] = [];
  const lineClasses = new Map<number, Set<string>>();

  const addLineClass = (pos: number, cls: string) => {
    const lineStart = doc.lineAt(pos).from;
    let s = lineClasses.get(lineStart);
    if (!s) lineClasses.set(lineStart, (s = new Set()));
    s.add(cls);
  };

  const markOrHide = (from: number, to: number, isRevealed: boolean) => {
    if (from >= to) return;
    if (isRevealed) {
      inline.push(Decoration.mark({ class: MARK_CLASS }).range(from, to));
    } else {
      inline.push(Decoration.replace({}).range(from, to));
      hidden.push({ from, to });
    }
  };

  const styleRange = (from: number, to: number, cls: string) => {
    if (from >= to) return;
    inline.push(Decoration.mark({ class: cls }).range(from, to));
  };

  const fm = scanFrontmatter(state);

  const nodeRevealed = (from: number, to: number) => {
    const a = doc.lineAt(from).number;
    const b = doc.lineAt(to).number;
    for (let i = a; i <= b; i++) if (revealed.has(i)) return true;
    return false;
  };

  /* ---- 任务列表：先按行扫出 [ ] 位置（比语法树稳） ---- */
  const taskLines = new Set<number>();
  {
    const first = doc.lineAt(view.viewport.from).number;
    const last = doc.lineAt(view.viewport.to).number;
    const re = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]/;
    for (let i = first; i <= last; i++) {
      const line = doc.line(i);
      const m = re.exec(line.text);
      if (!m) continue;
      taskLines.add(i);
      const idx = line.text.indexOf("[", m.index);
      const from = line.from + idx;
      const to = from + 3;
      if (revealed.has(i)) {
        inline.push(Decoration.mark({ class: MARK_CLASS }).range(from, to));
      } else {
        inline.push(
          Decoration.replace({
            widget: new CheckboxWidget(m[1].toLowerCase() === "x", from, to),
          }).range(from, to)
        );
        hidden.push({ from, to });
      }
    }
  }

  /* ---- 遍历语法树 ---- */
  syntaxTree(state).iterate({
    from: view.viewport.from,
    to: view.viewport.to,
    enter: (node) => {
      const name = node.name;
      const revealedHere = nodeRevealed(node.from, node.to);

      // frontmatter 内部：整块由 blockField 接管，这里不叠加装饰
      if (fm && node.from >= fm.from && node.to <= fm.to) {
        if (revealedHere) {
          for (let i = fm.firstLine; i <= fm.lastLine; i++) {
            addLineClass(doc.line(i).from, "cm-frontmatter-src");
          }
        }
        return false;
      }

      // 标题
      const hm = /^ATXHeading([1-6])$/.exec(name);
      if (hm) {
        addLineClass(node.from, `cm-h${hm[1]}`);
        for (const c of node.node.getChildren("HeaderMark")) {
          markOrHide(c.from, c.to, revealedHere);
          // "# " 里紧跟的空格一起吃掉，避免渲染后左侧多一个空格
          if (state.sliceDoc(c.to, c.to + 1) === " ") markOrHide(c.to, c.to + 1, revealedHere);
        }
        return false;
      }
      if (name === "SetextHeading1" || name === "SetextHeading2") {
        addLineClass(node.from, name.endsWith("1") ? "cm-h1" : "cm-h2");
        for (const c of node.node.getChildren("HeaderMark")) {
          const line = doc.lineAt(c.from);
          if (!revealedHere) {
            inline.push(
              Decoration.replace({ widget: new EmptyWidget() }).range(line.from, line.to)
            );
            hidden.push({ from: line.from, to: line.to });
          }
        }
        return false;
      }

      switch (name) {
        case "StrongEmphasis":
        case "Emphasis":
        case "Strikethrough": {
          const markName = name === "Strikethrough" ? "StrikethroughMark" : "EmphasisMark";
          const marks = node.node.getChildren(markName);
          for (const c of marks) markOrHide(c.from, c.to, revealedHere);
          if (marks.length >= 2) {
            styleRange(
              marks[0].to,
              marks[marks.length - 1].from,
              name === "StrongEmphasis" ? "cm-md-strong" : name === "Emphasis" ? "cm-md-em" : "cm-md-strike"
            );
          }
          // 继续下钻：支持 **粗 *斜* 体** 这类嵌套
          return;
        }

        case "Highlight": {
          const marks = node.node.getChildren("HighlightMark");
          for (const c of marks) markOrHide(c.from, c.to, revealedHere);
          if (marks.length >= 2) {
            styleRange(marks[0].to, marks[marks.length - 1].from, "cm-md-hl");
          }
          return;
        }

        case "InlineCode": {
          const marks = node.node.getChildren("CodeMark");
          for (const c of marks) markOrHide(c.from, c.to, revealedHere);
          if (marks.length >= 2) {
            styleRange(marks[0].to, marks[marks.length - 1].from, "cm-md-inlinecode");
          }
          return false;
        }

        case "Image": {
          const url = node.node.getChild("URL");
          const src = url ? state.sliceDoc(url.from, url.to) : "";
          const altMatch = /^!\[([^\]]*)\]/.exec(state.sliceDoc(node.from, node.to));
          const alt = altMatch ? altMatch[1] : "";
          if (!revealedHere && src) {
            inline.push(
              Decoration.replace({ widget: new ImageWidget(src, alt, node.from) }).range(
                node.from,
                node.to
              )
            );
            hidden.push({ from: node.from, to: node.to });
          } else {
            for (const c of node.node.getChildren("LinkMark"))
              markOrHide(c.from, c.to, revealedHere);
            if (url) markOrHide(url.from, url.to, revealedHere);
          }
          return false;
        }

        case "Link": {
          if (node.node.parent?.name === "Image") return false;
          const marks = node.node.getChildren("LinkMark");
          const url = node.node.getChild("URL");
          const title = node.node.getChild("LinkTitle");
          for (const c of marks) markOrHide(c.from, c.to, revealedHere);
          if (url) markOrHide(url.from, url.to, revealedHere);
          if (title) markOrHide(title.from, title.to, revealedHere);
          if (marks.length >= 2) styleRange(marks[0].to, marks[1].from, "cm-md-link");
          return;
        }

        case "QuoteMark": {
          const line = doc.lineAt(node.from);
          markOrHide(node.from, node.to, revealedHere);
          if (node.to < line.to && state.sliceDoc(node.to, node.to + 1) === " ") {
            markOrHide(node.to, node.to + 1, revealedHere);
          }
          return false;
        }

        case "Blockquote": {
          let depth = 1;
          for (let p = node.node.parent; p; p = p.parent) {
            if (p.name === "Blockquote") depth++;
          }
          const a = doc.lineAt(node.from).number;
          const b = doc.lineAt(node.to).number;
          for (let i = a; i <= b; i++) {
            addLineClass(doc.line(i).from, `cm-quote cm-quote-${Math.min(depth, 3)}`);
          }
          return;
        }

        case "ListMark": {
          const line = doc.lineAt(node.from);
          const isTask = taskLines.has(line.number);

          if (isTask) {
            // 任务项：吞掉 "- "，只留复选框
            inline.push(Decoration.replace({ widget: new EmptyWidget() }).range(node.from, node.to));
            hidden.push({ from: node.from, to: node.to });
            if (node.to < line.to && state.sliceDoc(node.to, node.to + 1) === " ") {
              inline.push(Decoration.replace({}).range(node.to, node.to + 1));
              hidden.push({ from: node.to, to: node.to + 1 });
            }
            return false;
          }

          // 无序列表的 mark 是 -,*,+；有序是 1. / 1)。父节点是 ListItem，
          // 所以用 mark 文本判断比看父节点可靠。
          const markText = state.sliceDoc(node.from, node.to).trim();
          const isBullet = /^[-*+]$/.test(markText);

          if (isBullet) {
            if (revealedHere) {
              inline.push(Decoration.mark({ class: MARK_CLASS }).range(node.from, node.to));
            } else {
              inline.push(
                Decoration.replace({
                  widget: new BulletWidget(state.sliceDoc(node.from, node.to)),
                }).range(node.from, node.to)
              );
              hidden.push({ from: node.from, to: node.to });
            }
          } else {
            styleRange(node.from, node.to, "cm-md-listnum");
          }
          return false;
        }

        case "FencedCode": {
          const a = doc.lineAt(node.from).number;
          const b = doc.lineAt(node.to).number;
          for (let i = a; i <= b; i++) {
            addLineClass(
              doc.line(i).from,
              `cm-codeblock${i === a ? " cm-codeblock-first" : ""}${i === b ? " cm-codeblock-last" : ""}`
            );
          }
          if (revealedHere) return;
          const marks = node.node.getChildren("CodeMark");
          const info = node.node.getChild("CodeInfo");
          if (marks[0]) {
            inline.push(
              Decoration.replace({
                widget: new CodeLangWidget(
                  info ? state.sliceDoc(info.from, info.to) : "",
                  node.from
                ),
              }).range(marks[0].from, marks[0].to)
            );
            hidden.push({ from: marks[0].from, to: marks[0].to });
          }
          if (info) {
            inline.push(Decoration.replace({}).range(info.from, info.to));
            hidden.push({ from: info.from, to: info.to });
          }
          const last = marks[marks.length - 1];
          if (last && last.from !== marks[0]?.from) {
            inline.push(Decoration.replace({ widget: new EmptyWidget() }).range(last.from, last.to));
            hidden.push({ from: last.from, to: last.to });
          }
          // 不下钻：代码块内部是嵌套语言（JS/TS…）的子树，几百个节点，
          // 对它做遍历会在每次按键时白花几毫秒。语法高亮由 language 模块独立负责。
          return false;
        }

        case "HorizontalRule": {
          const line = doc.lineAt(node.from);
          if (!revealedHere) {
            inline.push(Decoration.replace({ widget: new HrWidget() }).range(line.from, line.to));
            hidden.push({ from: line.from, to: line.to });
          } else {
            addLineClass(line.from, "cm-hr-revealed");
          }
          return false;
        }

        case "Table": {
          // 表格的块级渲染由 tableField 负责；这里只处理"源码态"的行样式
          if (revealedHere) {
            const a = doc.lineAt(node.from).number;
            const b = doc.lineAt(node.to).number;
            for (let i = a; i <= b; i++) addLineClass(doc.line(i).from, "cm-md-srcblock");
          }
          return false;
        }

        default:
          return;
      }
    },
  });

  /* ---- 去掉重叠的隐藏区间（嵌套标记的极端情况） ---- */
  hidden.sort((x, y) => x.from - y.from || y.to - x.to);
  const atomic: Range<Decoration>[] = [];
  let lastEnd = -1;
  for (const h of hidden) {
    if (h.from < lastEnd) continue;
    atomic.push(Decoration.replace({}).range(h.from, h.to));
    lastEnd = h.to;
  }

  /* ---- 行装饰：每行合并成一个 class 字符串，避免重复 line deco ---- */
  const lineDecos: Range<Decoration>[] = [];
  for (const [pos, classes] of lineClasses) {
    lineDecos.push(Decoration.line({ class: [...classes].filter(Boolean).join(" ") }).range(pos));
  }
  lineDecos.sort((a, b) => a.from - b.from);

  return {
    inline: Decoration.set(inline, true),
    lines: Decoration.set(lineDecos, true),
    atomic: Decoration.set(atomic, true),
  };
}

const inlinePlugin = ViewPlugin.fromClass(
  class {
    built: Built;
    constructor(view: EditorView) {
      this.built = buildInline(view);
    }
    update(u: ViewUpdate) {
      const readingChanged = readFlag(u.startState) !== readFlag(u.state);
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || readingChanged) {
        this.built = buildInline(u.view);
      }
    }
  },
  {
    provide: (plugin) => [
      EditorView.decorations.of((view) => view.plugin(plugin)?.built.inline ?? Decoration.none),
      EditorView.decorations.of((view) => view.plugin(plugin)?.built.lines ?? Decoration.none),
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.built.atomic ?? Decoration.none),
    ],
  }
);

export const livePreview: Extension = [
  readingField,
  focusField,
  EditorView.focusChangeEffect.of((_state, focusing) => setFocused.of(focusing)),
  blockField,
  inlinePlugin,
];

/* ------------------------------------------------------------------
   3) 专注模式
   ------------------------------------------------------------------ */

function buildFocus(view: EditorView): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const active = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = doc.lineAt(r.from).number;
    const b = doc.lineAt(r.to).number;
    for (let i = Math.max(1, a - 1); i <= Math.min(doc.lines, b + 1); i++) active.add(i);
  }
  const decos: Range<Decoration>[] = [];
  const first = doc.lineAt(view.viewport.from).number;
  const last = doc.lineAt(view.viewport.to).number;
  for (let i = first; i <= last; i++) {
    if (active.has(i)) continue;
    const line = doc.line(i);
    if (!line.text.trim()) continue;
    decos.push(Decoration.line({ class: "cm-focus-dim" }).range(line.from));
  }
  return Decoration.set(decos, true);
}

export const focusMode: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildFocus(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = buildFocus(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

/* ------------------------------------------------------------------
   4) 点击渲染块 → 光标回到源码
   ------------------------------------------------------------------ */

export const widgetClickHandler: Extension = EditorView.domEventHandlers({
  mousedown(e, view) {
    const el = (e.target as HTMLElement | null)?.closest?.(
      ".cm-md-blockwidget, .md-codelang, .md-task, .md-figure, .md-hr-widget"
    ) as HTMLElement | null;
    if (!el) return false;

    // 复选框：直接切换
    if (el.classList.contains("md-task")) {
      e.preventDefault();
      const from = Number(el.dataset.from);
      const to = Number(el.dataset.to);
      if (!Number.isFinite(from)) return false;
      const cur = view.state.sliceDoc(from, to);
      view.dispatch({ changes: { from, to, insert: /x/i.test(cur) ? "[ ]" : "[x]" } });
      return true;
    }

    let pos = Number(el.dataset.pos);
    if (!Number.isFinite(pos)) {
      try {
        pos = view.posAtDOM(el);
      } catch {
        return false;
      }
    }
    if (!Number.isFinite(pos)) return false;
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    view.focus();
    return true;
  },
});
