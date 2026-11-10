window.CP = window.CP || {};
CP.app = (function () {
  "use strict";

  const DEBOUNCE_MS = 120;
  const DIALECTS = [
    { name: "unix", label: "Unix (Linux Crontab)" },
    { name: "spring", label: "Spring (@Scheduled)" },
    { name: "quartz", label: "Quartz (Java)" }
  ];
  const ZONES = ["Local", "UTC", "Asia/Shanghai", "Asia/Tokyo", "Asia/Singapore",
    "America/New_York", "America/Chicago", "Europe/London", "Europe/Berlin", "__free__"];
  const COUNTS = [10, 20, 50];
  const DST_MODES = ["skip", "shift"];
  const FALLBACK = {
    unix: {
      hintKey: "hint.unixDow", yearToggle: false,
      fields: ["field.min", "field.hour", "field.dom", "field.month", "field.dow"]
    },
    spring: {
      hintKey: "hint.springDow", yearToggle: false,
      fields: ["field.sec", "field.min", "field.hour", "field.dom", "field.month", "field.dow"]
    },
    quartz: {
      hintKey: "hint.quartzDow", yearToggle: true,
      fields: ["field.sec", "field.min", "field.hour", "field.dom", "field.month", "field.dow"]
    }
  };

  let state = {
    expr: "", dialect: "unix", tz: "Local", count: 10, dstMissing: "skip",
    tab: "timeline", describeLang: null, yearEnabled: false
  };
  let timer = null;
  let lastResult = null;
  let tzLimited = false;

  function $(id) {
    return document.getElementById(id);
  }

  function t(key, params) { return CP.i18n.t(key, params); }

  function currentDialect() {
    if (CP.cron && CP.cron.dialect && typeof CP.cron.dialect.get === "function") {
      const spec = CP.cron.dialect.get(state.dialect);
      if (spec && typeof spec.getFields === "function") {
        return {
          hintKey: spec.hintKey,
          yearToggle: spec.allows("year"),
          fields: spec.getFields().filter(function (field) { return !field.optional; })
            .map(function (field) { return field.i18nKey; })
        };
      }
    }
    return FALLBACK[state.dialect] || FALLBACK.unix;
  }

  function option(value, text) {
    const el = document.createElement("option");
    el.value = value;
    el.textContent = text;
    return el;
  }

  function dialectList() {
    if (CP.cron && CP.cron.dialect && typeof CP.cron.dialect.list === "function") {
      const names = CP.cron.dialect.list();
      if (names && names.length) {
        return names.map(function (name) {
          const d = CP.cron.dialect.get(name);
          return { name: name, label: (d && d.label) || name };
        });
      }
    }
    return DIALECTS;
  }

  function fillSelects() {
    const dialect = $("sel-dialect");
    if (dialect) {
      dialect.textContent = "";
      dialectList().forEach(function (item) { dialect.appendChild(option(item.name, item.label)); });
      dialect.value = state.dialect;
    }
    const zone = $("sel-timezone");
    if (zone) {
      zone.textContent = "";
      const zoneList = tzLimited ? ["UTC"] : ZONES;
      zoneList.forEach(function (name) {
        zone.appendChild(option(name, name === "Local" ? t("timezone.local")
          : name === "__free__" ? t("timezone.freePlaceholder") : name));
      });
      zone.value = state.tz;
    }
    const count = $("sel-count");
    if (count) {
      count.textContent = "";
      COUNTS.forEach(function (n) { count.appendChild(option(String(n), String(n))); });
      count.value = String(state.count);
    }
    const dst = $("sel-dst");
    if (dst) {
      dst.textContent = "";
      DST_MODES.forEach(function (mode) {
        dst.appendChild(option(mode, mode === "skip" ? t("dst.skip") : t("dst.shift")));
      });
      dst.value = state.dstMissing;
    }
  }

  function showBanner() {
    const banner = $("banner-no-storage");
    if (!banner) return;
    banner.hidden = true;
    const intl = $("banner-intl");
    if (intl) {
      intl.hidden = !tzLimited;
      intl.textContent = t("banner.intlMissing");
    }
  }

  function savePrefs() {
    if (!CP.store || typeof CP.store.setPrefs !== "function") return;
    const fieldCounts = {};
    CP.cron.dialect.list().forEach(function (name) {
      fieldCounts[name] = CP.cron.dialect.get(name).fieldCountMin;
    });
    CP.store.setPrefs({
      dialect: state.dialect, timezone: state.tz, count: state.count,
      dstMissing: state.dstMissing, fieldCounts: fieldCounts
    });
  }

  function applyEntry(entry) {
    if (!entry) return;
    state.expr = entry.expr;
    state.dialect = entry.dialect;
    if (entry.tz) state.tz = entry.tz;
    state.yearEnabled = String(entry.expr).trim().split(/\s+/).length > currentDialect().fields.length;
    const input = $("expr-input");
    if (input) input.value = state.expr;
    const year = $("chk-year");
    if (year) year.checked = state.yearEnabled;
    fillSelects();
    savePrefs();
    recompute();
  }

  function storeHandlers() {
    return {
      applyPreset: function (preset) {
        applyEntry(preset);
        CP.store.pushHistory({ expr: preset.expr, dialect: preset.dialect, tz: state.tz });
        CP.store.render(state, storeHandlers());
      },
      loadEntry: function (entry) { applyEntry(entry); },
      toggleFavorite: function (entry) {
        CP.store.toggleFavorite(entry);
        CP.store.render(state, storeHandlers());
      }
    };
  }

  function changeDialect(nextName) {
    const previous = CP.cron.dialect.get(state.dialect);
    const target = CP.cron.dialect.get(nextName);
    if (!previous || !target) return;
    const ast = CP.cron.parse.parse(state.expr, previous);
    const converted = ast.normalized && ast.fields.length
      ? CP.cron.convert.convert(ast, previous, nextName) : null;
    const beforeExpr = state.expr;
    const beforeDialect = state.dialect;
    state.dialect = nextName;
    state.yearEnabled = state.yearEnabled && currentDialect().yearToggle;
    if (converted && converted.ok) {
      state.expr = converted.expression;
      const input = $("expr-input");
      if (input) input.value = state.expr;
      const year = $("chk-year");
      if (year) year.checked = state.yearEnabled;
      if (converted.remapped) {
        const oldDow = ast.fields[previous.fieldIndexOf("dow")];
        const newDow = state.expr.trim().split(/\s+/)[target.fieldIndexOf("dow")];
        showToast(t("toast.dowRemapped", {
          from: oldDow ? oldDow.raw : "", to: newDow || ""
        }), t("toast.undo"), function () {
          state.dialect = beforeDialect;
          state.expr = beforeExpr;
          const select = $("sel-dialect");
          if (select) select.value = state.dialect;
          const field = $("expr-input");
          if (field) field.value = state.expr;
          savePrefs();
          recompute();
        });
      }
      if (converted.yearRemoved) showToast(t("toast.yearRemoved"));
    }
    savePrefs();
    recompute();
  }

  function showToast(text, actionLabel, action) {
    const toast = $("toast");
    if (!toast) return;
    toast.textContent = "";
    const span = document.createElement("span");
    span.textContent = text;
    toast.appendChild(span);
    if (actionLabel && typeof action === "function") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = actionLabel;
      btn.style.marginLeft = "10px";
      btn.addEventListener("click", function () {
        action();
        toast.hidden = true;
      });
      toast.appendChild(btn);
    }
    toast.hidden = false;
  }

  function renderHint() {
    const spec = currentDialect();
    const wrap = $("year-toggle-wrap");
    if (wrap) wrap.hidden = !spec.yearToggle;
    const card = $("card-year");
    if (card) card.hidden = !(spec.yearToggle && state.yearEnabled);
  }

  function focusField(issue) {
    const dialect = CP.cron && CP.cron.dialect ? CP.cron.dialect.get(state.dialect) : null;
    const spec = dialect && issue.fieldIndex >= 0 ? dialect.getFields()[issue.fieldIndex] : null;
    if (spec && CP.builder && typeof CP.builder.setActive === "function") {
      CP.builder.setActive(spec.key);
    }
    const card = spec ? $("card-" + spec.key) : null;
    if (card && card.classList) {
      card.classList.add("invalid");
      if (card.scrollIntoView) card.scrollIntoView({ block: "nearest" });
    }
    const input = $("expr-input");
    if (input && input.setSelectionRange && issue.charOffset >= 0 && issue.charLength > 0) {
      input.focus();
      input.setSelectionRange(issue.charOffset, issue.charOffset + issue.charLength);
    }
  }

  function fallbackCopy(text) {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "readonly");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
    if (document.body && typeof document.body.removeChild === "function") {
      document.body.removeChild(area);
    }
    return ok;
  }

  function copyText(text) {
    const finish = function (ok) { if (ok) showToast(t("common.copied")); };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(text).then(function () { finish(true); },
        function () { finish(fallbackCopy(text)); });
    } else {
      finish(fallbackCopy(text));
    }
  }

  function renderDescription(result) {
    const view = $("view-describe");
    if (!view) return;
    view.textContent = "";
    const sentence = result && result.description ? result.description.full : "";
    view.hidden = !sentence;
    const text = document.createElement("span");
    text.className = "summary-text";
    text.textContent = sentence;
    view.appendChild(text);
  }

  function bindActions() {
    const copyButton = $("btn-copy");
    if (copyButton) {
      copyButton.addEventListener("click", function () { copyText(state.expr); });
    }
    const resetButton = $("btn-reset");
    if (resetButton) {
      resetButton.addEventListener("click", function () {
        state.expr = "";
        const input = $("expr-input");
        if (input) input.value = "";
        recompute();
      });
    }
  }

  function renderStatus(result) {
    const bar = $("statusbar");
    const text = $("status-text");
    const list = $("error-list");
    if (list) list.textContent = "";
    const status = (result && result.status) || (String(state.expr).trim() ? "valid" : "empty");
    const issues = ((result && result.issues) || []).filter(function (issue) {
      return issue.code !== "DOW_BASE_AMBIGUOUS";
    });
    const displayStatus = status === "warning" && !issues.length ? "valid" : status;
    if (bar) {
      bar.hidden = displayStatus !== "warning" && displayStatus !== "error";
      bar.setAttribute("data-state", displayStatus);
    }
    if (text) {
      text.textContent = displayStatus === "empty" ? t("status.empty")
        : displayStatus === "error" ? t("status.error")
          : displayStatus === "warning" ? t("status.warning") : t("status.valid");
    }
    if (list) {
      issues.forEach(function (issue) {
        const li = document.createElement("li");
        li.textContent = issue.message || issue.code;
        li.setAttribute("data-severity", issue.severity || "error");
        if (typeof issue.fieldIndex === "number") li.setAttribute("data-field-index", String(issue.fieldIndex));
        li.addEventListener("click", function () { focusField(issue); });
        list.appendChild(li);
      });
    }
  }

  function renderViews(result) {
    const timeline = $("view-timeline");
    if (timeline) timeline.hidden = state.tab === "snippets";
    const snippets = $("view-snippets");
    if (snippets) snippets.hidden = state.tab !== "snippets";
    ["timeline", "snippets"].forEach(function (name) {
      const tab = $("tab-" + name);
      if (tab) tab.setAttribute("aria-selected", name === state.tab ? "true" : "false");
    });
    if (CP.builder && typeof CP.builder.renderCards === "function") CP.builder.renderCards(result, state);
    renderDescription(result);
    if (CP.timeline && typeof CP.timeline.render === "function") CP.timeline.render(result, state);
    if (CP.snippets && typeof CP.snippets.render === "function") CP.snippets.render($("view-snippets"), result, state);
    if (CP.convert && typeof CP.convert.renderCompare === "function") CP.convert.renderCompare($("compare-bar"), result, state);
  }

  function recompute() {
    lastResult = null;
    if (CP.engine && typeof CP.engine.evaluate === "function") {
      lastResult = CP.engine.evaluate(state);
    }
    renderHint();
    renderStatus(lastResult);
    renderViews(lastResult);
    if (CP.timeline && typeof CP.timeline.drawCanvas === "function") CP.timeline.drawCanvas(lastResult, state);
    showBanner();
    return lastResult;
  }

  function scheduleRecompute() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(recompute, DEBOUNCE_MS);
  }

  function bind() {
    const input = $("expr-input");
    if (input) {
      input.addEventListener("input", function () {
        state.expr = input.value;
        scheduleRecompute();
      });
    }
    const dialect = $("sel-dialect");
    if (dialect) {
      dialect.addEventListener("change", function () {
        changeDialect(dialect.value);
      });
    }
    const zone = $("sel-timezone");
    if (zone) {
      zone.addEventListener("change", function () {
        const free = $("tz-free");
        state.tz = zone.value === "__free__" ? ((free && free.value) || "Local") : zone.value;
        if (free) free.hidden = zone.value !== "__free__";
        savePrefs();
        recompute();
      });
    }
    const free = $("tz-free");
    if (free) {
      free.addEventListener("input", function () {
        state.tz = free.value;
        scheduleRecompute();
      });
    }
    const count = $("sel-count");
    if (count) {
      count.addEventListener("change", function () {
        state.count = Number(count.value) || 10;
        savePrefs();
        recompute();
      });
    }
    const dst = $("sel-dst");
    if (dst) {
      dst.addEventListener("change", function () {
        state.dstMissing = dst.value;
        savePrefs();
        recompute();
      });
    }
    ["describe", "timeline", "snippets"].forEach(function (name) {
      const tab = $("tab-" + name);
      if (tab) {
        tab.addEventListener("click", function () {
          state.tab = name;
          renderViews(lastResult);
        });
      }
    });
    const year = $("chk-year");
    if (year) {
      year.addEventListener("change", function () {
        state.yearEnabled = !!year.checked;
        recompute();
      });
    }
  }

  function applyLocale() {
    CP.i18n.setLocale(CP.bridge.env().locale);
    state.describeLang = CP.i18n.locale();
    CP.i18n.applyDom(document);
    fillSelects();
    const zone = $("sel-timezone");
    if (zone) zone.value = ZONES.indexOf(state.tz) >= 0 ? state.tz : "__free__";
    const free = $("tz-free");
    if (free) free.hidden = ZONES.indexOf(state.tz) >= 0;
    recompute();
    if (CP.store && typeof CP.store.render === "function") CP.store.render(state, storeHandlers());
  }

  async function init() {
    await CP.bridge.init();
    if (CP.store && typeof CP.store.load === "function") {
      await CP.store.load();
      const saved = CP.store.prefs();
      if (saved.dialect && CP.cron.dialect.get(saved.dialect)) state.dialect = saved.dialect;
      if (saved.timezone) state.tz = saved.timezone;
      if (saved.count) state.count = Number(saved.count) || 10;
      if (saved.dstMissing) state.dstMissing = saved.dstMissing;
    }
    if (!CP.bridge.supportsTimezones()) {
      tzLimited = true;
      state.tz = "UTC";
    }
    bind();
    bindActions();
    CP.bridge.onEnv(function () { applyLocale(); });
    applyLocale();
  }

  return {
    init: init,
    recompute: recompute,
    scheduleRecompute: scheduleRecompute,
    showToast: showToast,
    state: state,
    $: $
  };
})();

CP.app.init();
