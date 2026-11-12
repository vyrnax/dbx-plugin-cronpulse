window.CP = window.CP || {};
CP.bridge = (function () {
  "use strict";

  let host = null;
  let envState = { locale: "zh-CN", theme: null, capabilities: {} };
  const listeners = [];
  const memory = new Map();
  let warned = false;
  const injectedTokens = [];

  function emit() {
    for (let i = 0; i < listeners.length; i += 1) {
      try { listeners[i](envState); } catch (_) { /* 单个订阅者失败不影响其余订阅者 */ }
    }
  }

  /* 判断宿主底色是深是浅：覆盖 #hex / rgb() / hsl() / oklch() 常见写法。
     颜色权威是宿主注入的 --color-* token，theme.appearance 只作兜底 ——
     切换主题的一瞬间两者可能不同步，此时以实测亮度为准。 */
  function toneOf(color) {
    const text = String(color || "").trim().toLowerCase();
    if (!text) return null;
    let m = /^#([0-9a-f]{3,8})\b/.exec(text);
    if (m) {
      let hex = m[1];
      if (hex.length === 3 || hex.length === 4) {
        hex = hex.split("").map(function (c) { return c + c; }).join("");
      }
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      if (!isFinite(r) || !isFinite(g) || !isFinite(b)) return null;
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.55 ? "light" : "dark";
    }
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(text);
    if (m) {
      const lum = (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255;
      return lum > 0.55 ? "light" : "dark";
    }
    m = /^oklch\(\s*([\d.]+)(%?)/.exec(text);
    if (m) {
      const l = Number(m[1]) / (m[2] ? 100 : 1);
      return isFinite(l) && l > 0.6 ? "light" : "dark";
    }
    /* hsl 的亮度是第三个分量，逗号与空格两种写法都要吃下 */
    m = /^hsla?\(\s*[\d.]+(?:deg)?[\s,]+[\d.]+%[\s,]+([\d.]+)%/.exec(text);
    if (m) return Number(m[1]) > 55 ? "light" : "dark";
    return null;
  }

  function applyColorScheme(root, theme) {
    const tokens = (theme && theme.tokens) || null;
    let tone = toneOf((tokens && (tokens["--color-background"] || tokens["--color-card"])) || "");
    if (!tone) {
      try {
        tone = toneOf(typeof getComputedStyle === "function"
          ? getComputedStyle(root).getPropertyValue("--color-background") : "");
      } catch (_) {
        tone = null;
      }
    }
    if (!tone) tone = theme && theme.appearance === "dark" ? "dark" : "light";
    if (root.style && typeof root.style.setProperty === "function") {
      root.style.setProperty("color-scheme", tone);
      injectedTokens.push("color-scheme");
    }
    return tone;
  }

  function applyTheme(theme) {
    const root = document.documentElement;
    if (!root) return;
    const style = root.style;
    if (style && typeof style.removeProperty === "function") {
      for (const name of injectedTokens) style.removeProperty(name);
    }
    injectedTokens.length = 0;
    const appearance = theme && theme.appearance;
    if (appearance) root.setAttribute("data-appearance", appearance);
    else if (typeof root.removeAttribute === "function") root.removeAttribute("data-appearance");
    const tokens = theme && theme.tokens;
    if (tokens && typeof tokens === "object") {
      Object.keys(tokens).forEach(function (name) {
        if (name.indexOf("--color-") === 0 || name.indexOf("--radius-") === 0 || name.indexOf("--font-") === 0) {
          root.style.setProperty(name, String(tokens[name]));
          injectedTokens.push(name);
        }
      });
    }
    /* 原生控件（下拉弹层、滚动条）的明暗以实测底色为准：必须在 token 注入之后判断，
       否则 getComputedStyle 兜底读到的是上一套主题的底色。 */
    applyColorScheme(root, theme);

    const editor = theme && theme.editor;
    if (editor && typeof editor === "object") {
      const size = Number(editor.fontSize);
      if (Number.isFinite(size) && size > 0) {
        root.style.setProperty("--cp-editor-size", size + "px");
        injectedTokens.push("--cp-editor-size");
      }
      if (typeof editor.fontFamily === "string" && editor.fontFamily) {
        root.style.setProperty("--cp-mono", editor.fontFamily);
        injectedTokens.push("--cp-mono");
      }
    }
  }

  function readEnv() {
    if (!host) return;
    envState.locale = host.locale || "zh-CN";
    envState.theme = host.theme || null;
    envState.capabilities = host.capabilities || {};
    applyTheme(envState.theme);
  }

  async function init() {
    host = window.dbxPlugin || null;
    if (host && host.ready) {
      try {
        await host.ready;
      } catch (_) {
        host = null;
      }
    }
    readEnv();
    window.addEventListener("dbx-plugin-env", function (event) {
      const payload = event && event.detail;
      if (payload && payload.theme) envState.theme = payload.theme;
      if (payload && payload.locale) envState.locale = payload.locale;
      if (payload && payload.capabilities) envState.capabilities = payload.capabilities;
      applyTheme(envState.theme);
      emit();
    });
    return envState;
  }

  function onEnv(fn) {
    if (typeof fn === "function") listeners.push(fn);
  }

  function env() { return envState; }

  function hasStorage() {
    return !!(host && host.capabilities && host.capabilities.storage && host.storage);
  }

  function storageAvailable() { return hasStorage(); }

  function markUnavailable() {
    if (warned) return true;
    warned = true;
    return warned;
  }

  function storageWarned() { return warned; }

  async function get(key) {
    if (!hasStorage()) {
      markUnavailable();
      return memory.has(key) ? memory.get(key) : null;
    }
    try {
      return await host.storage.get(key);
    } catch (_) {
      markUnavailable();
      return memory.has(key) ? memory.get(key) : null;
    }
  }

  async function set(key, value) {
    memory.set(key, value);
    if (!hasStorage()) {
      markUnavailable();
      return false;
    }
    try {
      await host.storage.set(key, value);
      return true;
    } catch (_) {
      markUnavailable();
      return false;
    }
  }

  async function remove(key) {
    memory.delete(key);
    if (!hasStorage()) return false;
    try {
      await host.storage.delete(key);
      return true;
    } catch (_) {
      return false;
    }
  }

  function supportsTimezones() {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai" }).format(new Date(0));
      return true;
    } catch (_) {
      return false;
    }
  }

  return {
    init: init,
    onEnv: onEnv,
    env: env,
    get: get,
    set: set,
    remove: remove,
    hasStorage: hasStorage,
    storageAvailable: storageAvailable,
    markUnavailable: markUnavailable,
    storageWarned: storageWarned,
    supportsTimezones: supportsTimezones,
    toneOf: toneOf
  };
})();
