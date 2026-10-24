/**
 * 轻量 Markdown 行内/块级渲染器。
 * 只用于 widget 的"只读预览"（表格、图片、复选框等），
 * 不做完整 CommonMark 解析——编辑区本身由 Lezer 负责结构。
 */

const PH_OPEN = "\u0000";
const PH_CLOSE = "\u0001";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 行内标记 → HTML。先摘出代码块，避免二次处理。 */
export function renderInline(raw: string): string {
  const stash: string[] = [];
  const keep = (html: string) => {
    stash.push(html);
    return `${PH_OPEN}${stash.length - 1}${PH_CLOSE}`;
  };

  let s = raw;

  // 1. 行内代码优先
  s = s.replace(/(`+)([\s\S]*?)\1/g, (_m, _ticks, code) =>
    keep(`<code class="md-code">${escapeHtml(code.trim())}</code>`)
  );

  // 2. 图片
  s = s.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g, (_m, alt, src) =>
    keep(
      `<img class="md-inline-img" alt="${escapeHtml(alt)}" src="${escapeHtml(src)}" loading="lazy">`
    )
  );

  // 3. 链接（含纯文本 autolink）
  s = s.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g, (_m, text, href) =>
    keep(
      `<a class="md-link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(
        text
      )}</a>`
    )
  );

  // 4. 剩下的纯文本做转义后再上标记
  s = escapeHtml(s);

  s = s
    .replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/==([^=]+)==/g, '<mark class="md-hl">$1</mark>')
    .replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, '<a class="md-link" href="$1" target="_blank">$1</a>');

  // 5. 还原占位符
  s = s.replace(new RegExp(`${PH_OPEN}(\\d+)${PH_CLOSE}`, "g"), (_m, i) => stash[Number(i)] ?? "");
  return s;
}

export interface Cell {
  text: string;
  align: "left" | "center" | "right";
}

/** 把 markdown 表格源码解析成行列结构 */
export function parseTable(src: string): { header: Cell[]; rows: Cell[][]; aligns: Cell["align"][] } {
  const lines = src
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { header: [], rows: [], aligns: [] };

  const splitRow = (line: string): string[] => {
    let t = line.trim();
    if (t.startsWith("|")) t = t.slice(1);
    if (t.endsWith("|")) t = t.slice(0, -1);
    const out: string[] = [];
    let buf = "";
    let inCode = false;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (ch === "\\") {
        buf += ch + (t[i + 1] ?? "");
        i++;
        continue;
      }
      if (ch === "`") inCode = !inCode;
      if (ch === "|" && !inCode) {
        out.push(buf.trim());
        buf = "";
        continue;
      }
      buf += ch;
    }
    out.push(buf.trim());
    return out;
  };

  const isDelim = (line: string) => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line);

  const headerRaw = splitRow(lines[0]);
  let aligns: Cell["align"][] = headerRaw.map(() => "left");
  let bodyStart = 1;

  if (lines.length > 1 && isDelim(lines[1])) {
    aligns = splitRow(lines[1]).map((c) => {
      const left = c.startsWith(":");
      const right = c.endsWith(":");
      if (left && right) return "center";
      if (right) return "right";
      return "left";
    });
    bodyStart = 2;
  }

  const mk = (text: string, i: number): Cell => ({ text, align: aligns[i] ?? "left" });

  const header = headerRaw.map(mk);
  const rows = lines.slice(bodyStart).map((l) => {
    const cells = splitRow(l);
    return headerRaw.map((_, i) => mk(cells[i] ?? "", i));
  });

  return { header, rows, aligns };
}

/* ------------------------------------------------------------------ */
/* 块级渲染：用于导出 HTML（编辑区本身由 Lezer 负责结构）               */
/* ------------------------------------------------------------------ */

export function renderDocument(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  // 剥离 frontmatter
  if (lines[0]?.trim() === "---") {
    for (let j = 1; j < lines.length; j++) {
      if (lines[j].trim() === "---") {
        i = j + 1;
        break;
      }
    }
  }

  const isTableStart = (a?: string, b?: string) =>
    !!a && !!b && a.includes("|") && /^\s*\|?\s*:?-{1,}/.test(b) && b.includes("-");

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // frontmatter 之后的第二个 --- 视为 hr，第一个已是 frontmatter
    // 代码块
    const fence = /^(\s*)(`{3,}|~{3,})\s*([\w+-]*)/.exec(line);
    if (fence) {
      const mark = fence[2];
      const lang = fence[3] || "";
      i++;
      const buf: string[] = [];
      while (i < lines.length && !new RegExp(`^\\s*${mark[0]}{3,}\\s*$`).test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      out.push(
        `<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ""}>${escapeHtml(
          buf.join("\n")
        )}</code></pre>`
      );
      continue;
    }

    // 分隔线
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push(`<h${h[1].length}>${renderInline(h[2].trim())}</h${h[1].length}>`);
      i++;
      continue;
    }

    // 表格
    if (isTableStart(line, lines[i + 1])) {
      const buf = [line];
      i++;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        buf.push(lines[i]);
        i++;
      }
      const { header, rows } = parseTable(buf.join("\n"));
      const th = header
        .map((c) => `<th style="text-align:${c.align}">${renderInline(c.text)}</th>`)
        .join("");
      const tb = rows
        .map(
          (r) =>
            `<tr>${r
              .map((c) => `<td style="text-align:${c.align}">${renderInline(c.text)}</td>`)
              .join("")}</tr>`
        )
        .join("");
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`);
      continue;
    }

    // 引用
    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${renderDocumentBlocks(buf)}</blockquote>`);
      continue;
    }

    // 列表
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
        // 收集列表项续行
        while (i < lines.length && lines[i].trim() && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          buf[buf.length - 1] += "\n" + lines[i];
          i++;
        }
      }
      out.push(renderList(buf));
      continue;
    }

    // 段落
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) &&
      !/^\s*(`{3,}|~{3,})/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${renderInline(buf.join(" "))}</p>`);
  }

  return out.join("\n");
}

function renderDocumentBlocks(lines: string[]): string {
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const h = /^(#{1,6})\s+(.*)$/.exec(l);
      if (h) return `<h${h[1].length}>${renderInline(h[2])}</h${h[1].length}>`;
      const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(l);
      if (li) return `<li>${renderInline(li[2])}</li>`;
      return `<p>${renderInline(l)}</p>`;
    })
    .join("");
}

function renderList(lines: string[]): string {
  const ordered = /^\s*\d+[.)]\s+/.test(lines[0]);
  const items: string[] = [];
  for (const raw of lines) {
    const m = /^\s*(?:[-*+]|\d+[.)])\s+([\s\S]*)$/.exec(raw);
    if (!m) continue;
    let content = m[1];
    let prefix = "";
    const task = /^\[([ xX])\]\s+([\s\S]*)$/.exec(content);
    if (task) {
      prefix = `<input type="checkbox" disabled${task[1].toLowerCase() === "x" ? " checked" : ""}>`;
      content = task[2];
    }
    const parts = content.split("\n");
    const inner = parts.map((p, idx) => (idx === 0 ? renderInline(p) : `<br>${renderInline(p)}`));
    items.push(`<li>${prefix}${inner.join("")}</li>`);
  }
  const tag = ordered ? "ol" : "ul";
  return `<${tag}>${items.join("")}</${tag}>`;
}
