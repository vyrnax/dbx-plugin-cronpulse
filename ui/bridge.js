window.CP = window.CP || {};
CP.bridge = (function () {
  "use strict";

  let host = null;
  let envState = { locale: "zh-CN", theme: null, capabilities: {} };
  const listeners = [];
  const memory = new Map();
  let warned = false;

  function emit() {
    for (let i = 0; i < listeners.length; i += 1) {
      try { listeners[i](envState); } catch (_) { /* 单个订阅者失败不影响其余订阅者 */ }
    }
  }

  function applyTheme(theme) {
    const root = document.documentElement;
    if (!root) return;
    const appearance = theme && theme.appearance;
    if (appearance) root.setAttribute("data-appearance", appearance);
    const tokens = theme && theme.tokens;
    if (tokens && typeof tokens === "object") {
      Object.keys(tokens).forEach(function (name) {
        if (name.indexOf("--color-") === 0 || name.indexOf("--radius-") === 0 || name.indexOf("--font-") === 0) {
          root.style.setProperty(name, String(tokens[name]));
        }
      });
    }
    const editor = theme && theme.editor;
    if (editor && typeof editor === "object") {
      const size = Number(editor.fontSize);
      if (Number.isFinite(size) && size > 0) {
        root.style.setProperty("--cp-editor-size", size + "px");
      }
      if (typeof editor.fontFamily === "string" && editor.fontFamily) {
        root.style.setProperty("--cp-mono", editor.fontFamily);
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
    supportsTimezones: supportsTimezones
  };
})();
