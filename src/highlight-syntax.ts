import type { MarkdownConfig, InlineContext } from "@lezer/markdown";

const EQ = 61; // "="
const SPACE = 32;
const NL = 10;

/**
 * 给 Markdown 加 `==高亮==` 语法。
 * CommonMark/GFM 都没有这个标记，需要自己注册一个行内解析器。
 */
export const HighlightConfig: MarkdownConfig = {
  defineNodes: [{ name: "Highlight" }, { name: "HighlightMark" }],
  parseInline: [
    {
      name: "Highlight",
      after: "Emphasis",
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== EQ || cx.char(pos + 1) !== EQ) return -1;
        // 开头的 == 后面不能是空白
        const first = cx.char(pos + 2);
        if (first === SPACE || first === NL || first === -1) return -1;

        let close = -1;
        for (let i = pos + 3; i < cx.end - 1; i++) {
          const c = cx.char(i);
          if (c === NL) return -1;
          if (c === EQ && cx.char(i + 1) === EQ && cx.char(i - 1) !== SPACE) {
            close = i;
            break;
          }
        }
        if (close < 0) return -1;

        return cx.addElement(
          cx.elt("Highlight", pos, close + 2, [
            cx.elt("HighlightMark", pos, pos + 2),
            ...cx.parser.parseInline(cx.slice(pos + 2, close), pos + 2),
            cx.elt("HighlightMark", close, close + 2),
          ])
        );
      },
    },
  ],
};
