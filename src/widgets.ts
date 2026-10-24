import { WidgetType } from "@codemirror/view";
import { renderInline, parseTable, escapeHtml } from "./markdown-render";
import { peekAsset, resolveAsset, isRemoteSrc, hasAssetResolver } from "./assets";

/** YAML frontmatter → 属性卡片 */
export class FrontmatterWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly from: number
  ) {
    super();
  }

  eq(other: FrontmatterWidget) {
    return other.src === this.src;
  }

  toDOM() {
    // 注意：块级 widget 上绝不能有垂直 margin——CodeMirror 量高度时
    // 不计入 margin，会导致之后所有内容的坐标偏移（点哪行都错一行）。
    // 所以"间距"放在外层 wrapper 的 padding 上，卡片本身用 border。
    const wrap = document.createElement("div");
    wrap.className = "cm-md-blockwidget md-fm-wrap";
    wrap.dataset.pos = String(this.from);

    const lines = this.src.split("\n").filter((l) => l.trim() && !/^(---|\.\.\.)$/.test(l.trim()));
    const rows = lines
      .map((l) => /^([^:#][^:]*):\s*(.*)$/.exec(l))
      .filter(Boolean)
      .map((m) => ({ k: m![1].trim(), v: m![2].trim() }));

    const card = document.createElement("div");
    card.className = "md-frontmatter";

    const badge = document.createElement("div");
    badge.className = "md-fm-badge";
    badge.textContent = "PROPERTIES";
    card.appendChild(badge);

    if (rows.length) {
      const dl = document.createElement("div");
      dl.className = "md-fm-list";
      for (const r of rows) {
        const row = document.createElement("div");
        row.className = "md-fm-row";
        const k = document.createElement("span");
        k.className = "md-fm-key";
        k.textContent = r.k;
        const v = document.createElement("span");
        v.className = "md-fm-val";
        v.innerHTML = renderInline(r.v);
        row.append(k, v);
        dl.appendChild(row);
      }
      card.appendChild(dl);
    } else {
      const pre = document.createElement("pre");
      pre.className = "md-fm-raw";
      pre.textContent = lines.join("\n");
      card.appendChild(pre);
    }
    wrap.appendChild(card);
    return wrap;
  }

  ignoreEvent() {
    return false;
  }
}

/** 表格：替换整块源码，渲染成真正的 HTML table */
export class TableWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly from: number
  ) {
    super();
  }

  eq(other: TableWidget) {
    return other.src === this.src;
  }

  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-blockwidget cm-md-tablewrap";
    wrap.dataset.pos = String(this.from);

    const { header, rows } = parseTable(this.src);
    const table = document.createElement("table");
    table.className = "md-table";

    if (header.length) {
      const thead = table.createTHead();
      const tr = thead.insertRow();
      header.forEach((c, i) => {
        const th = document.createElement("th");
        th.innerHTML = renderInline(c.text);
        th.style.textAlign = c.align;
        th.dataset.col = String(i);
        tr.appendChild(th);
      });
    }

    const tbody = table.createTBody();
    rows.forEach((r) => {
      const tr = tbody.insertRow();
      r.forEach((c, i) => {
        const td = tr.insertCell();
        td.innerHTML = renderInline(c.text);
        td.style.textAlign = c.align;
        td.dataset.col = String(i);
      });
    });

    wrap.appendChild(table);
    return wrap;
  }

  ignoreEvent() {
    return false;
  }
}

/** 图片：把 ![alt](src) 换成真实图像 */
export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly from: number
  ) {
    super();
  }

  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt;
  }

  toDOM() {
    const fig = document.createElement("span");
    fig.className = "cm-md-inlinewidget md-figure";
    fig.dataset.pos = String(this.from);

    const img = document.createElement("img");
    img.alt = this.alt;
    img.loading = "lazy";
    img.className = "md-img";
    fig.appendChild(img);

    let caption: HTMLElement | null = null;
    if (this.alt) {
      caption = document.createElement("span");
      caption.className = "md-figcaption";
      caption.innerHTML = renderInline(this.alt);
      fig.appendChild(caption);
    }

    const fail = () => {
      fig.classList.add("md-img-broken");
      img.remove();
      if (caption) caption.remove();
      const ph = document.createElement("span");
      ph.className = "md-img-broken-label";
      const noWs = !hasAssetResolver() && !isRemoteSrc(this.src);
      ph.textContent = noWs
        ? `🖼 ${this.src} —— 相对路径需要打开所在文件夹才能显示`
        : `🖼 ${this.alt || this.src}`;
      fig.appendChild(ph);
    };

    img.onerror = fail;

    // 远程地址/ 已缓存的直接用，相对路径交给 workspace 异步解析
    const cached = peekAsset(this.src);
    if (cached) {
      img.src = cached;
    } else if (isRemoteSrc(this.src)) {
      img.src = this.src;
    } else {
      img.classList.add("md-img-loading");
      resolveAsset(this.src).then((url) => {
        if (url) {
          img.classList.remove("md-img-loading");
          img.src = url;
        } else {
          fail();
        }
      });
    }

    return fig;
  }

  ignoreEvent() {
    return false;
  }
}

/** 任务列表复选框，点击可切换 [ ] / [x] */
export class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly from: number,
    readonly to: number
  ) {
    super();
  }

  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.from === this.from;
  }

  toDOM() {
    const box = document.createElement("span");
    box.className = `md-task ${this.checked ? "is-checked" : ""}`;
    box.dataset.from = String(this.from);
    box.dataset.to = String(this.to);
    box.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.6l4 3.9 8-8.9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", String(this.checked));
    return box;
  }

  ignoreEvent() {
    return false;
  }
}

/** 列表项圆点 */
export class BulletWidget extends WidgetType {
  constructor(readonly char: string) {
    super();
  }

  eq(other: BulletWidget) {
    return other.char === this.char;
  }

  toDOM() {
    const s = document.createElement("span");
    s.className = "md-bullet";
    s.textContent = "•";
    return s;
  }

  ignoreEvent() {
    return true;
  }
}

/** 代码块语言标签（替换开头的 ```lang 行） */
export class CodeLangWidget extends WidgetType {
  constructor(
    readonly lang: string,
    readonly from: number
  ) {
    super();
  }

  eq(other: CodeLangWidget) {
    return other.lang === this.lang;
  }

  toDOM() {
    const s = document.createElement("span");
    s.className = "md-codelang";
    s.dataset.pos = String(this.from);
    s.textContent = (this.lang || "text").trim() || "text";
    return s;
  }

  ignoreEvent() {
    return false;
  }
}

/** 空 widget：用于吞掉结束围栏 ``` */
export class EmptyWidget extends WidgetType {
  toDOM() {
    const s = document.createElement("span");
    s.className = "md-empty";
    return s;
  }
  ignoreEvent() {
    return true;
  }
}

/** 分隔线 --- / *** */
export class HrWidget extends WidgetType {
  toDOM() {
    const d = document.createElement("div");
    d.className = "md-hr-widget";
    return d;
  }
  ignoreEvent() {
    return true;
  }
}

