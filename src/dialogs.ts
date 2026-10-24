/**
 * 轻量 UI 组件：应用内输入框 / 确认框 / 右键菜单。
 *
 * 为什么不用 window.prompt —— Electron 里没有 prompt()，只有 alert/confirm。
 * 顺带也解决了 prompt 无法定制样式、无法校验的问题。
 */

/* ---------------- 遮罩层管理 ---------------- */

let maskEl: HTMLElement | null = null;

function mask(): HTMLElement {
  if (!maskEl) {
    maskEl = document.createElement("div");
    maskEl.className = "modal-mask";
    maskEl.hidden = true;
    document.body.appendChild(maskEl);
  }
  return maskEl;
}

/* ---------------- 文本输入 ---------------- */

export interface AskOptions {
  title: string;
  label?: string;
  value?: string;
  placeholder?: string;
  confirmText?: string;
  /** 返回错误字符串则阻止提交 */
  validate?: (v: string) => string | null;
}

export function askText(opts: AskOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const m = mask();
    m.innerHTML = "";
    m.hidden = false;

    const box = document.createElement("div");
    box.className = "modal";

    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = opts.title;
    box.appendChild(title);

    if (opts.label) {
      const label = document.createElement("div");
      label.className = "modal-label";
      label.textContent = opts.label;
      box.appendChild(label);
    }

    const input = document.createElement("input");
    input.className = "modal-input";
    input.type = "text";
    input.value = opts.value ?? "";
    input.placeholder = opts.placeholder ?? "";
    input.spellcheck = false;
    input.autocomplete = "off";
    box.appendChild(input);

    const err = document.createElement("div");
    err.className = "modal-error";
    box.appendChild(err);

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const cancel = document.createElement("button");
    cancel.className = "btn-ghost";
    cancel.textContent = "取消";
    const ok = document.createElement("button");
    ok.className = "btn-primary";
    ok.textContent = opts.confirmText ?? "确定";
    actions.append(cancel, ok);
    box.appendChild(actions);

    m.appendChild(box);

    const close = (result: string | null) => {
      m.hidden = true;
      m.innerHTML = "";
      document.removeEventListener("keydown", onKey, true);
      resolve(result);
    };

    const submit = () => {
      const v = input.value.trim();
      if (!v) {
        err.textContent = "不能为空";
        input.focus();
        return;
      }
      const problem = opts.validate?.(v) ?? null;
      if (problem) {
        err.textContent = problem;
        input.focus();
        return;
      }
      close(v);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(null);
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        submit();
      }
    };

    document.addEventListener("keydown", onKey, true);
    cancel.onclick = () => close(null);
    ok.onclick = submit;
    m.onclick = (e) => {
      if (e.target === m) close(null);
    };

    input.focus();
    // 选中主文件名（不含扩展名），方便直接改名
    const dot = input.value.lastIndexOf(".");
    if (dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  });
}

/* ---------------- 确认框 ---------------- */

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmText?: string;
  danger?: boolean;
}

export function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const m = mask();
    m.innerHTML = "";
    m.hidden = false;

    const box = document.createElement("div");
    box.className = "modal";

    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = opts.title;
    box.appendChild(title);

    if (opts.message) {
      const msg = document.createElement("div");
      msg.className = "modal-message";
      msg.textContent = opts.message;
      box.appendChild(msg);
    }

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const cancel = document.createElement("button");
    cancel.className = "btn-ghost";
    cancel.textContent = "取消";
    const ok = document.createElement("button");
    ok.className = opts.danger ? "btn-danger" : "btn-primary";
    ok.textContent = opts.confirmText ?? "确定";
    actions.append(cancel, ok);
    box.appendChild(actions);
    m.appendChild(box);

    const close = (v: boolean) => {
      m.hidden = true;
      m.innerHTML = "";
      document.removeEventListener("keydown", onKey, true);
      resolve(v);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      }
    };

    document.addEventListener("keydown", onKey, true);
    cancel.onclick = () => close(false);
    ok.onclick = () => close(true);
    m.onclick = (e) => {
      if (e.target === m) close(false);
    };
    ok.focus();
  });
}

/* ---------------- 右键菜单 ---------------- */

export interface MenuItem {
  label?: string;
  shortcut?: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

let ctxEl: HTMLElement | null = null;

function closeMenu() {
  if (ctxEl) {
    ctxEl.remove();
    ctxEl = null;
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", closeMenu);
    window.removeEventListener("blur", closeMenu);
  }
}

function onOutside(e: MouseEvent) {
  if (ctxEl && !ctxEl.contains(e.target as Node)) closeMenu();
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeMenu();
  }
}

export function showContextMenu(x: number, y: number, items: MenuItem[]) {
  closeMenu();

  const el = document.createElement("div");
  el.className = "ctx-menu";
  el.hidden = true;

  for (const it of items) {
    if (it.separator) {
      const sep = document.createElement("div");
      sep.className = "ctx-sep";
      el.appendChild(sep);
      continue;
    }
    const row = document.createElement("div");
    row.className = "ctx-item" + (it.danger ? " danger" : "") + (it.disabled ? " disabled" : "");
    const label = document.createElement("span");
    label.textContent = it.label ?? "";
    row.appendChild(label);
    if (it.shortcut) {
      const sc = document.createElement("span");
      sc.className = "ctx-shortcut";
      sc.textContent = it.shortcut;
      row.appendChild(sc);
    }
    if (!it.disabled) {
      row.onclick = () => {
        closeMenu();
        it.onClick?.();
      };
    }
    el.appendChild(row);
  }

  document.body.appendChild(el);
  ctxEl = el;
  el.hidden = false;

  // 贴边修正
  const r = el.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - r.width - 8);
  const py = Math.min(y, window.innerHeight - r.height - 8);
  el.style.left = `${Math.max(8, px)}px`;
  el.style.top = `${Math.max(8, py)}px`;

  document.addEventListener("mousedown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", closeMenu);
  window.addEventListener("blur", closeMenu);
}

/** 把右键事件转成菜单坐标 */
export function contextMenuFromEvent(e: MouseEvent, items: MenuItem[]) {
  e.preventDefault();
  e.stopPropagation();
  showContextMenu(e.clientX, e.clientY, items);
}
