CP.store = (function () {
  "use strict";

  const KEYS = { favorites: "favorites", history: "history", prefs: "prefs" };
  const LIMITS = { favorites: 100, history: 50 };
  const MAX_VALUE_BYTES = 240 * 1024;

  const memory = { favorites: [], history: [], prefs: {} };

  const PRESETS = [
    { id: "minute", dialect: "unix", expr: "* * * * *", emoji: "⏱" },
    { id: "hourly", dialect: "unix", expr: "0 * * * *", emoji: "🕐" },
    { id: "midnight", dialect: "unix", expr: "0 0 * * *", emoji: "🌙" },
    { id: "eight", dialect: "unix", expr: "0 8 * * *", emoji: "☀" },
    { id: "mondayNine", dialect: "unix", expr: "0 9 * * 1", emoji: "📅" },
    { id: "monthlyFirst", dialect: "unix", expr: "0 0 1 * *", emoji: "🗓" },
    { id: "workdaysNine", dialect: "unix", expr: "0 9-18 * * 1-5", emoji: "💼" },
    { id: "quarterHour", dialect: "unix", expr: "*/15 * * * *", emoji: "⚡" }
  ];

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function same(a, b) {
    return a && b && a.expr === b.expr && a.dialect === b.dialect;
  }

  function trim(list, limit) {
    const result = list.slice(0, limit);
    while (JSON.stringify(result).length * 2 > MAX_VALUE_BYTES && result.length > 1) result.pop();
    return result;
  }

  async function load() {
    for (const key of Object.keys(KEYS)) {
      try {
        const value = await CP.bridge.get(KEYS[key]);
        if (Array.isArray(value) && key !== "prefs") memory[key] = value;
        else if (value && typeof value === "object" && key === "prefs") memory[key] = value;
      } catch (_) {
        // 宿主拒绝读写时保持内存态
      }
    }
    return clone(memory);
  }

  function persist(key) {
    try {
      return CP.bridge.set(KEYS[key], clone(memory[key]));
    } catch (_) {
      return Promise.resolve();
    }
  }

  function favorites() { return clone(memory.favorites); }
  function history() { return clone(memory.history); }
  function prefs() { return clone(memory.prefs); }

  function isFavorite(entry) {
    return memory.favorites.some(function (item) { return same(item, entry); });
  }

  function addFavorite(entry) {
    if (!entry || !entry.expr || isFavorite(entry)) return persist("favorites");
    memory.favorites = trim([Object.assign({ tz: "UTC" }, entry)].concat(memory.favorites), LIMITS.favorites);
    return persist("favorites");
  }

  function removeFavorite(entry) {
    memory.favorites = memory.favorites.filter(function (item) { return !same(item, entry); });
    return persist("favorites");
  }

  function toggleFavorite(entry) {
    return isFavorite(entry) ? removeFavorite(entry) : addFavorite(entry);
  }

  function pushHistory(entry) {
    if (!entry || !entry.expr) return persist("history");
    const rest = memory.history.filter(function (item) { return !same(item, entry); });
    memory.history = trim([Object.assign({ tz: "UTC" }, entry)].concat(rest), LIMITS.history);
    return persist("history");
  }

  function setPrefs(partial) {
    memory.prefs = Object.assign({}, memory.prefs, partial || {});
    return persist("prefs");
  }

  function clearHistory() {
    memory.history = [];
    return persist("history");
  }

  function chip(text, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.textContent = text;
    if (handler) button.addEventListener("click", handler);
    return button;
  }

  function presetChip(preset, active, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "preset-chip";
    button.setAttribute("aria-pressed", active ? "true" : "false");
    const top = document.createElement("span");
    top.className = "preset-top";
    const emoji = document.createElement("span");
    emoji.className = "preset-emoji";
    emoji.setAttribute("aria-hidden", "true");
    emoji.textContent = preset.emoji;
    const label = document.createElement("span");
    label.className = "preset-label";
    label.textContent = CP.i18n.t("preset." + preset.id);
    top.appendChild(emoji);
    top.appendChild(label);
    const code = document.createElement("code");
    code.className = "preset-cron";
    code.textContent = preset.expr;
    button.appendChild(top);
    button.appendChild(code);
    if (handler) button.addEventListener("click", handler);
    return button;
  }

  function entryButton(entry, label, handler) {
    return chip(label + " · " + entry.expr, function () { handler(entry); });
  }

  function cronCode(expr) {
    const code = document.createElement("code");
    code.className = "preset-cron";
    code.textContent = expr || "";
    return code;
  }

  function favoriteEntryChip(entry, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "preset-chip";
    button.setAttribute("aria-pressed", "false");
    const top = document.createElement("span");
    top.className = "preset-top";
    const label = document.createElement("span");
    label.className = "preset-label";
    label.textContent = entry.dialect;
    top.appendChild(label);
    button.appendChild(top);
    button.appendChild(cronCode(entry.expr));
    if (handler) button.addEventListener("click", handler);
    return button;
  }

  function renderList(el, entries, emptyKey, handler) {
    if (!el) return;
    el.textContent = "";
    if (!entries.length) {
      const empty = document.createElement("span");
      empty.className = "timeline-note";
      empty.textContent = CP.i18n.t(emptyKey);
      el.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      el.appendChild(entryButton(entry, entry.dialect, handler));
    }
  }

  function render(state, handlers) {
    const callbacks = handlers || {};
    const presetArea = CP.app.$("preset-area");
    if (presetArea) {
      presetArea.textContent = "";
      for (const preset of PRESETS) {
        const active = preset.expr === state.expr && preset.dialect === state.dialect;
        presetArea.appendChild(presetChip(preset, active, function () {
          if (callbacks.applyPreset) callbacks.applyPreset(preset);
        }));
      }
    }
    const favoriteArea = CP.app.$("favorites-area");
    if (favoriteArea) {
      const current = { expr: state.expr, dialect: state.dialect, tz: state.tz };
      favoriteArea.textContent = "";
      const saved = isFavorite(current);
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "preset-chip";
      toggle.setAttribute("aria-pressed", saved ? "true" : "false");
      const top = document.createElement("span");
      top.className = "preset-top";
      const star = document.createElement("span");
      star.className = "preset-emoji";
      star.setAttribute("aria-hidden", "true");
      star.textContent = saved ? "★" : "☆";
      const label = document.createElement("span");
      label.className = "preset-label";
      label.textContent = CP.i18n.t(saved ? "common.remove" : "common.save");
      top.appendChild(star);
      top.appendChild(label);
      toggle.appendChild(top);
      toggle.appendChild(cronCode(current.expr));
      toggle.addEventListener("click", function () {
        if (callbacks.toggleFavorite) callbacks.toggleFavorite(current);
      });
      favoriteArea.appendChild(toggle);
      for (const entry of memory.favorites) {
        favoriteArea.appendChild(favoriteEntryChip(entry, callbacks.loadEntry || function () {}));
      }
    }
    renderList(CP.app.$("history-area"), memory.history, "history.empty",
      callbacks.loadEntry || function () {});
  }

  return {
    load: load, render: render, presets: PRESETS,
    favorites: favorites, history: history, prefs: prefs,
    addFavorite: addFavorite, removeFavorite: removeFavorite,
    toggleFavorite: toggleFavorite, isFavorite: isFavorite,
    pushHistory: pushHistory, clearHistory: clearHistory, setPrefs: setPrefs
  };
})();
