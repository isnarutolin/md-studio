import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

export const mdHighlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--accent)" },
  { tag: t.url, color: "var(--accent)" },
  { tag: t.monospace, fontFamily: "var(--mono)" },
  { tag: t.quote, color: "var(--muted)" },
  { tag: t.comment, color: "var(--code-comment)", fontStyle: "italic" },
  { tag: t.keyword, color: "var(--code-keyword)" },
  { tag: t.string, color: "var(--code-string)" },
  { tag: t.number, color: "var(--code-number)" },
  { tag: t.bool, color: "var(--code-number)" },
  { tag: t.null, color: "var(--code-number)" },
  { tag: t.operator, color: "var(--code-operator)" },
  { tag: t.punctuation, color: "var(--code-punct)" },
  { tag: t.bracket, color: "var(--code-punct)" },
  { tag: t.variableName, color: "var(--code-var)" },
  { tag: t.definition(t.variableName), color: "var(--code-fn)" },
  { tag: t.function(t.variableName), color: "var(--code-fn)" },
  { tag: t.propertyName, color: "var(--code-prop)" },
  { tag: t.typeName, color: "var(--code-type)" },
  { tag: t.className, color: "var(--code-type)" },
  { tag: t.tagName, color: "var(--code-keyword)" },
  { tag: t.attributeName, color: "var(--code-prop)" },
  { tag: t.attributeValue, color: "var(--code-string)" },
  { tag: t.processingInstruction, color: "var(--code-keyword)" },
  { tag: t.meta, color: "var(--muted)" },
  { tag: t.invalid, color: "var(--danger)" },
]);

export const mdTheme: Extension = [
  EditorView.theme({
    "&": {
      height: "100%",
      fontSize: "var(--editor-font-size, 17px)",
      backgroundColor: "transparent",
      color: "var(--fg)",
    },
    ".cm-scroller": {
      fontFamily: "var(--sans)",
      lineHeight: "1.75",
      overflow: "auto",
      padding: "0 0 45vh 0",
    },
    ".cm-content": {
      caretColor: "var(--accent)",
      padding: "34px 0 0 0",
      maxWidth: "var(--measure, 760px)",
      margin: "0 auto",
      paddingInline: "8px",
    },
    ".cm-line": {
      padding: "2px 0",
      transition: "opacity .18s ease, color .18s ease",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor, .cm-dropCursor": {
      borderLeft: "2px solid var(--accent)",
      borderRadius: "1px",
    },
    ".cm-selectionBackground, ::selection": {
      backgroundColor: "var(--selection) !important",
    },
    "&.cm-focused .cm-selectionBackground": { backgroundColor: "var(--selection)" },
    ".cm-activeLine": { backgroundColor: "transparent" },
    ".cm-gutters": { display: "none" },
    ".cm-widgetBuffer": { display: "none" },
    ".cm-placeholder": { color: "var(--muted-2)" },
    ".cm-searchMatch": {
      backgroundColor: "var(--search)",
      borderRadius: "3px",
    },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--search-sel)" },
  }),
  syntaxHighlighting(mdHighlight),
];
