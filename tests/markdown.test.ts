import { test } from "vitest";
import assert from "node:assert/strict";
import { renderInline, parseTable, renderDocument, escapeHtml } from "../src/markdown-render";

test("escapeHtml 转义尖括号与引号", () => {
  assert.equal(escapeHtml('<a href="x">'), "&lt;a href=&quot;x&quot;&gt;");
});

test("行内：粗体 / 斜体 / 删除线 / 高亮", () => {
  assert.equal(renderInline("**b**"), "<strong>b</strong>");
  assert.equal(renderInline("*i*"), "<em>i</em>");
  assert.equal(renderInline("~~d~~"), "<del>d</del>");
  assert.match(renderInline("==h=="), /^<mark class="md-hl">h<\/mark>$/);
});

test("行内：代码里的星号不被再解析", () => {
  const html = renderInline("`a**b**c`");
  assert.match(html, /<code class="md-code">a\*\*b\*\*c<\/code>/);
  assert.doesNotMatch(html, /<strong>/);
});

test("行内：链接与图片", () => {
  assert.match(renderInline("[t](https://x.com)"), /<a class="md-link" href="https:\/\/x\.com"/);
  assert.match(renderInline("![alt](a.png)"), /<img class="md-inline-img" alt="alt" src="a\.png"/);
});

test("行内：HTML 被转义，不会注入", () => {
  const html = renderInline('<script>alert(1)</script>');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("表格：对齐方式与单元格", () => {
  const t = parseTable("| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |");
  assert.deepEqual(t.header.map((c) => c.text), ["a", "b", "c"]);
  assert.deepEqual(t.header.map((c) => c.align), ["left", "center", "right"]);
  assert.deepEqual(t.rows[0].map((c) => c.text), ["1", "2", "3"]);
});

test("表格：单元格里的竖线用代码包起来时不切分", () => {
  const t = parseTable("| a | b |\n| --- | --- |\n| `x|y` | z |");
  assert.equal(t.rows[0][0].text, "`x|y`");
  assert.equal(t.rows[0][1].text, "z");
});

test("表格：缺列补齐", () => {
  const t = parseTable("| a | b |\n| --- | --- |\n| 1 |");
  assert.deepEqual(t.rows[0].map((c) => c.text), ["1", ""]);
});

test("导出：frontmatter 不进入正文", () => {
  const html = renderDocument("---\ntitle: t\n---\n\n# H\n\n正文");
  assert.doesNotMatch(html, /title: t/);
  assert.match(html, /<h1>H<\/h1>/);
});

test("导出：代码块内容被转义且不带缩进污染", () => {
  const html = renderDocument("```js\nconst a = 1 < 2;\n```");
  assert.match(html, /<pre><code class="language-js">/);
  assert.match(html, /1 &lt; 2/);
});

test("导出：任务列表变成复选框", () => {
  const html = renderDocument("- [x] done\n- [ ] todo");
  assert.match(html, /<input type="checkbox" disabled checked>/);
  assert.match(html, /<input type="checkbox" disabled>/);
});

test("导出：引用里的标题仍被解析", () => {
  const html = renderDocument("> ## 引用标题");
  assert.match(html, /<blockquote>/);
  assert.match(html, /<h2>引用标题<\/h2>/);
});
