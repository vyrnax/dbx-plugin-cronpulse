window.CP = window.CP || {};
CP.builder = (function () {
  "use strict";

  const ADVANCED = [
    { feature: "last", syntax: "L", key: "dom" },
    { feature: "lMinus", syntax: "L-3", key: "dom" },
    { feature: "lw", syntax: "LW", key: "dom" },
    { feature: "w", syntax: "15W", key: "dom" },
    { feature: "last", syntax: "6L", key: "dow" },
    { feature: "nth", syntax: "6#3", key: "dow" }
  ];

  const WIDE_LIMIT = 100;
  const EXPAND_LIMIT = 240;
  const ALL_KEYS = ["sec", "min", "hour", "dom", "month", "dow", "year"];

  let activeKey = null;
  let lastResult = null;
  let lastState = null;
  let pendingFocus = null;

  function t(key, params) { return CP.i18n.t(key, params); }

  // 星期字段的可编辑数字域随方言基准变化（Quartz 为 1-7），不能沿用共享的 field.min；
  // 其余字段（含 dom/month/sec/min/hour/year）保持声明区间。
  function numericBounds(field, dialect) {
    return field.key === "dow" ? dialect.dowRange() : { min: field.min, max: field.max };
  }

  function longName(key) { return t("field.long." + key); }
  function unitName(key) { return t("field.unit." + key); }

  function appendInline(controls, key, unit, slots) {
    const parts = t(key, { unit: unit }).split(/(\{a\}|\{b\})/);
    for (const part of parts) {
      if (part === "{a}" && slots.a) controls.appendChild(slots.a);
      else if (part === "{b}" && slots.b) controls.appendChild(slots.b);
      else if (part) controls.appendChild(document.createTextNode(part));
    }
  }

  function tokensOf(state) {
    const text = String(state.expr || "").trim();
    // 宏整体（如 @daily / @weekly）必须先展开再按字段修改：
    // 否则宏名会占据首 token，修改第 2 个及以后字段时拼出 "@weekly * 5 * * *" 这类垃圾。
    // @reboot 无时刻语义（展开值为 null），保持原样交给校验器给出专属警告。
    if (text.charAt(0) === "@") {
      const dialect = CP.cron.dialect.get(state.dialect);
      const expanded = dialect && dialect.macroTable()[text.toLowerCase()];
      if (expanded) return expanded.split(/\s+/).filter(Boolean);
    }
    return text.split(/\s+/).filter(Boolean);
  }

  function update(state, key, value) {
    const dialect = CP.cron.dialect.get(state.dialect);
    if (!dialect) return;
    const index = dialect.fieldIndexOf(key);
    if (index < 0) return;
    const tokens = tokensOf(state);
    const fields = dialect.getFields();
    const required = fields.filter(function (field) { return !field.optional; }).length;
    const count = state.yearEnabled && dialect.allows("year") ? fields.length : required;
    const wanted = Math.max(count, index + 1);
    while (tokens.length < wanted) tokens.push("*");
    tokens[index] = value || "*";
    state.expr = tokens.join(" ");
    const input = CP.app.$("expr-input");
    if (input) input.value = state.expr;
    CP.app.recompute();
  }

  function makeButton(label, handler, title, disabled) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.textContent = label;
    if (title) button.title = title;
    button.disabled = !!disabled;
    if (handler) button.addEventListener("click", handler);
    return button;
  }

  function makeSelect(options, current, ariaKey) {
    const select = document.createElement("select");
    if (ariaKey) select.setAttribute("aria-label", t(ariaKey));
    for (const item of options) {
      const el = document.createElement("option");
      el.value = item.value;
      el.textContent = item.text;
      select.appendChild(el);
    }
    select.value = current;
    return select;
  }

  function numericOptions(from, to) {
    const options = [];
    for (let v = from; v <= to; v += 1) options.push({ value: String(v), text: String(v) });
    return options;
  }

  function toCanonical(value, dialect) {
    return CP.cron.dialect.toCanonical(value, dialect.dowBase());
  }

  function fromCanonical(canonical, dialect) {
    return CP.cron.dialect.fromCanonical(canonical, dialect.dowBase(), false);
  }

  function nameToValue(text, field, dialect) {
    if (!dialect.allows("names")) return null;
    const upper = String(text).slice(0, 3).toUpperCase();
    if (field.key === "month") {
      const index = dialect.monthNames().indexOf(upper);
      return index >= 0 ? index + 1 : null;
    }
    if (field.key === "dow") {
      const index = dialect.dowNames().indexOf(upper);
      return index >= 0 ? index : null;
    }
    return null;
  }

  function partValue(text, field, dialect) {
    if (/^\d{1,4}$/.test(text)) {
      const n = Number(text);
      if (n < field.min || n > field.max) return null;
      if (field.key === "dow") return toCanonical(n, dialect);
      return n;
    }
    return nameToValue(text, field, dialect);
  }

  function expandPart(part, field, dialect) {
    const text = String(part || "").trim();
    if (!text || text === "*" || text === "?") return null;
    const range = /^([A-Za-z]{3}|\d{1,4})-([A-Za-z]{3}|\d{1,4})$/.exec(text);
    if (range) {
      const from = partValue(range[1], field, dialect);
      const to = partValue(range[2], field, dialect);
      if (from === null || to === null || to < from || to - from > EXPAND_LIMIT) return null;
      const out = [];
      for (let v = from; v <= to; v += 1) out.push(v);
      return out;
    }
    const single = partValue(text, field, dialect);
    return single === null ? null : [single];
  }

  function expandValues(token, field, dialect) {
    const text = String(token || "").trim();
    if (!text || text === "*" || text === "?" || text.indexOf("/") >= 0) return null;
    const out = [];
    for (const part of text.split(",")) {
      const values = expandPart(part, field, dialect);
      if (!values) return null;
      for (const v of values) out.push(v);
      if (out.length > EXPAND_LIMIT) return null;
    }
    return out;
  }

  function compactValues(values, field) {
    const unique = Array.from(new Set(values)).sort(function (a, b) { return a - b; });
    const parts = [];
    let runStart = null;
    let runPrev = null;
    const flush = function () {
      if (runStart === null) return;
      if (runPrev - runStart >= 2) parts.push(runStart + "-" + runPrev);
      else {
        for (let v = runStart; v <= runPrev; v += 1) parts.push(String(v));
      }
      runStart = null;
      runPrev = null;
    };
    for (const v of unique) {
      if (runStart === null) { runStart = v; runPrev = v; continue; }
      if (v === runPrev + 1) runPrev = v;
      else { flush(); runStart = v; runPrev = v; }
    }
    flush();
    return parts.join(",");
  }

  function toggleSpecific(state, field, dialect, value) {
    const tokens = tokensOf(state);
    const current = tokens[dialect.fieldIndexOf(field.key)] || "";
    const values = expandValues(current, field, dialect) || [];
    const pos = values.indexOf(value);
    if (pos >= 0) values.splice(pos, 1);
    else values.push(value);
    const unique = Array.from(new Set(values)).sort(function (a, b) { return a - b; });
    let token;
    if (!unique.length) token = "*";
    else if (field.key === "dow" && unique.length === 7) token = "*";
    else if (field.key === "dow") {
      token = compactValues(unique.map(function (v) { return fromCanonical(v, dialect); }), field);
    } else token = compactValues(unique, field);
    update(state, field.key, token);
  }

  function detectMode(token, field, dialect) {
    const text = String(token == null ? "" : token).trim();
    if (text === "*" || text === "") return "every";
    if (text === "?") return "none";
    if (field.key === "dom") {
      if (text === "L" && dialect.allows("last")) return "lastDom";
      if (text === "LW" && dialect.allows("lw")) return "lastWeekday";
      if (/^L-\d{1,2}$/.test(text) && dialect.allows("lMinus")) return "daysBeforeEnd";
      if (/^\d{1,2}W$/.test(text) && dialect.allows("w")) return "nearestWeekday";
    }
    if (field.key === "dow") {
      if (/^\dL$/.test(text) && dialect.allows("last")) return "lastDow";
      if (/^\d#[1-5]$/.test(text) && dialect.allows("nth")) return "nthDow";
    }
    if (/^(\*|\d{1,4})(?:-(\d{1,4}))?\/(\d{1,4})$/.test(text)) return "step";
    if (/^([A-Za-z]{3}|\d{1,4})-([A-Za-z]{3}|\d{1,4})$/.test(text)) return "range";
    if (field.max - field.min <= WIDE_LIMIT && expandValues(text, field, dialect)) return "specific";
    return "raw";
  }

  function seedToken(mode, field, dialect) {
    const bounds = numericBounds(field, dialect);
    switch (mode) {
      case "every": return "*";
      case "none": return "?";
      case "step": return bounds.min + "/1";
      case "range": return bounds.min + "-" + bounds.max;
      case "specific": return String(field.key === "dow" ? fromCanonical(0, dialect) : field.min);
      case "lastDom": return "L";
      case "lastWeekday": return "LW";
      case "daysBeforeEnd": return "L-3";
      case "nearestWeekday": return field.min + "W";
      case "lastDow": return fromCanonical(0, dialect) + "L";
      case "nthDow": return fromCanonical(0, dialect) + "#1";
      default: return null;
    }
  }

  function buildGrid(controls, enabled, state, field, dialect, token) {
    const grid = document.createElement("div");
    grid.className = "value-grid";
    const selected = new Set(expandValues(token, field, dialect) || []);
    const cells = [];
    if (field.key === "dow") {
      grid.classList.add("cols-7");
      for (let c = 0; c <= 6; c += 1) {
        cells.push({ v: c, label: dialect.dowNames()[c],
          sub: fromCanonical(c, dialect) + " " + t("desc.weekday." + c) });
      }
    } else if (field.key === "month") {
      grid.classList.add("cols-6");
      for (let m = field.min; m <= field.max; m += 1) {
        cells.push({ v: m, label: String(m), sub: dialect.monthNames()[m - 1] });
      }
    } else {
      grid.classList.add("cols-10");
      for (let v = field.min; v <= field.max; v += 1) {
        cells.push({ v: v, label: String(v), sub: "" });
      }
    }
    for (const cell of cells) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "vg-cell";
      button.appendChild(document.createTextNode(cell.label));
      if (cell.sub) {
        const sub = document.createElement("span");
        sub.className = "vg-sub";
        sub.textContent = cell.sub;
        button.appendChild(sub);
      }
      if (selected.has(cell.v)) button.classList.add("selected");
      button.disabled = !enabled;
      button.addEventListener("click", function () {
        toggleSpecific(state, field, dialect, cell.v);
      });
      grid.appendChild(button);
    }
    controls.appendChild(grid);
  }

  function renderFocus(result, state) {
    const host = CP.app.$("focus-editor");
    const dialect = CP.cron.dialect.get(state.dialect);
    if (!host || !dialect) return;
    const fields = dialect.getFields();
    let field = null;
    for (const item of fields) {
      if (item.key === activeKey) { field = item; break; }
    }
    if (!field || (field.optional && !(state.yearEnabled && dialect.allows("year")))) {
      field = null;
      for (const item of fields) {
        if (!item.optional) { field = item; break; }
      }
    }
    if (!field) { host.hidden = true; host.textContent = ""; return; }
    activeKey = field.key;
    const currentField = field;
    host.hidden = false;
    host.textContent = "";

    const tabs = document.createElement("div");
    tabs.className = "focus-tabs";
    tabs.setAttribute("role", "tablist");
    for (const item of fields) {
      if (item.optional && !(state.yearEnabled && dialect.allows("year"))) continue;
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "focus-tab fc-" + item.key;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", item.key === currentField.key ? "true" : "false");
      const dot = document.createElement("i");
      dot.className = "fdot fdot-" + item.key;
      dot.setAttribute("aria-hidden", "true");
      const text = document.createElement("span");
      text.textContent = t("field.long." + item.key);
      tab.appendChild(dot);
      tab.appendChild(text);
      tab.addEventListener("click", function () {
        if (item.key !== activeKey) setActive(item.key);
      });
      tabs.appendChild(tab);
    }
    host.appendChild(tabs);

    const tokens = tokensOf(state);
    const index = dialect.fieldIndexOf(currentField.key);
    const token = tokens[index] || "";
    let mode = detectMode(token, currentField, dialect);
    if (mode === "none" && !dialect.allows("question")) mode = "raw";
    const wide = currentField.max - currentField.min > WIDE_LIMIT;

    const head = document.createElement("div");
    head.className = "focus-head";
    const title = document.createElement("span");
    title.className = "focus-title";
    title.textContent = t("builder.editField", { field: longName(currentField.key) });
    const value = document.createElement("code");
    value.className = "focus-token";
    value.textContent = token || "—";
    head.appendChild(title);
    head.appendChild(value);
    host.appendChild(head);

    const hint = document.createElement("p");
    hint.className = "focus-hint";
    hint.textContent = t("builder.focusHint");
    host.appendChild(hint);

    const issues = result && result.issues ? result.issues : [];
    const conflict = (currentField.key === "dom" || currentField.key === "dow") &&
      dialect.allows("question") && issues.some(function (issue) {
        return issue.code === "QUARTZ_BOTH_DAYS_CONCRETE";
      });
    if (conflict) {
      const warn = document.createElement("div");
      warn.className = "focus-warning";
      const text = document.createElement("span");
      text.textContent = t("msg.QUARTZ_NEEDS_QUESTION");
      warn.appendChild(text);
      warn.appendChild(makeButton(t("builder.setQuestion"), function () {
        update(state, currentField.key, "?");
      }));
      host.appendChild(warn);
    }

    function addMode(name, labelKey, buildControls) {
      const row = document.createElement("div");
      row.className = labelKey ? "mode-row" : "mode-row mode-row-inline";
      const label = document.createElement("label");
      label.className = "mode-label";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "cp-focus-mode";
      radio.value = name;
      radio.checked = mode === name;
      radio.addEventListener("change", function () {
        if (!radio.checked) return;
        const seed = seedToken(name, currentField, dialect);
        if (seed !== null) update(state, currentField.key, seed);
        else renderFocus(lastResult, lastState);
      });
      label.appendChild(radio);
      if (labelKey) {
        const text = document.createElement("span");
        text.textContent = t(labelKey, {
          unit: unitName(currentField.key),
          field: longName(currentField.key)
        });
        label.appendChild(text);
      }
      row.appendChild(label);
      if (buildControls) {
        const controls = document.createElement("div");
        controls.className = "mode-controls";
        buildControls(controls, mode === name);
        row.appendChild(controls);
      }
      host.appendChild(row);
    }

    function buildStepControls(controls, enabled) {
      const bounds = numericBounds(currentField, dialect);
      const match = /^(\*|\d{1,4})(?:-(\d{1,4}))?\/(\d{1,4})$/.exec(token);
      const stepSel = makeSelect(numericOptions(1, bounds.max - bounds.min + 1),
        match ? match[3] : "1", "builder.step");
      const startSel = makeSelect(numericOptions(bounds.min, bounds.max),
        match && match[1] !== "*" ? match[1] : String(bounds.min), "builder.from");
      const applyStep = function () {
        update(state, currentField.key, startSel.value + "/" + stepSel.value);
      };
      for (const select of [stepSel, startSel]) {
        select.disabled = !enabled;
        select.addEventListener("change", applyStep);
      }
      appendInline(controls, "builder.mode.cycleInline", unitName(currentField.key),
        { a: stepSel, b: startSel });
    }

    function buildRangeControls(controls, enabled) {
      const bounds = numericBounds(currentField, dialect);
      const match = /^([A-Za-z]{3}|\d{1,4})-([A-Za-z]{3}|\d{1,4})$/.exec(token);
      const fromSel = makeSelect(numericOptions(bounds.min, bounds.max),
        match && /^\d+$/.test(match[1]) ? match[1] : String(bounds.min), "builder.from");
      const toSel = makeSelect(numericOptions(bounds.min, bounds.max),
        match && /^\d+$/.test(match[2]) ? match[2] : String(bounds.max), "builder.to");
      const applyRange = function () {
        if (Number(toSel.value) < Number(fromSel.value)) return;
        update(state, currentField.key, fromSel.value + "-" + toSel.value);
      };
      for (const select of [fromSel, toSel]) {
        select.disabled = !enabled;
        select.addEventListener("change", applyRange);
      }
      appendInline(controls, "builder.mode.rangeInline", unitName(currentField.key),
        { a: fromSel, b: toSel });
    }

    function buildOffsetControls(controls, enabled) {
      const match = /^L-(\d{1,2})$/.exec(token);
      const select = makeSelect(numericOptions(1, 30), match ? match[1] : "3", "builder.to");
      select.disabled = !enabled;
      select.addEventListener("change", function () {
        update(state, currentField.key, "L-" + select.value);
      });
      controls.appendChild(select);
    }

    function buildNearestControls(controls, enabled) {
      const match = /^(\d{1,2})W$/.exec(token);
      const select = makeSelect(numericOptions(currentField.min, currentField.max),
        match ? match[1] : String(currentField.min), currentField.i18nKey);
      select.disabled = !enabled;
      select.addEventListener("change", function () {
        update(state, currentField.key, select.value + "W");
      });
      controls.appendChild(select);
    }

    function dowOptions(dialectRef) {
      const options = [];
      for (let c = 0; c <= 6; c += 1) {
        options.push({ value: String(c), text: dialectRef.dowNames()[c] });
      }
      return options;
    }

    function buildLastDowControls(controls, enabled) {
      const match = /^(\d)L$/.exec(token);
      const select = makeSelect(dowOptions(dialect),
        match ? String(toCanonical(Number(match[1]), dialect)) : "0", currentField.i18nKey);
      select.disabled = !enabled;
      select.addEventListener("change", function () {
        update(state, currentField.key, fromCanonical(Number(select.value), dialect) + "L");
      });
      controls.appendChild(select);
    }

    function buildNthControls(controls, enabled) {
      const match = /^(\d)#([1-5])$/.exec(token);
      const dowSel = makeSelect(dowOptions(dialect),
        match ? String(toCanonical(Number(match[1]), dialect)) : "0", currentField.i18nKey);
      const nthSel = makeSelect(numericOptions(1, 5), match ? match[2] : "1", "builder.step");
      const applyNth = function () {
        update(state, currentField.key, fromCanonical(Number(dowSel.value), dialect) + "#" + nthSel.value);
      };
      for (const select of [dowSel, nthSel]) {
        select.disabled = !enabled;
        select.addEventListener("change", applyNth);
        controls.appendChild(select);
      }
    }

    addMode("every", "builder.mode.everyUnit");
    if ((currentField.key === "dom" || currentField.key === "dow") && dialect.allows("question")) {
      addMode("none", "builder.mode.none");
    }
    if (!wide) {
      addMode("step", null, buildStepControls);
      addMode("range", null, buildRangeControls);
      addMode("specific", "builder.mode.specificUnit", function (controls, enabled) {
        if (enabled) buildGrid(controls, enabled, state, currentField, dialect, token);
      });
    }
    if (currentField.key === "dom") {
      if (dialect.allows("last")) addMode("lastDom", "builder.mode.lastDay");
      if (dialect.allows("lw")) addMode("lastWeekday", "builder.mode.lastWeekday");
      if (dialect.allows("lMinus")) addMode("daysBeforeEnd", "builder.mode.daysBeforeEnd", buildOffsetControls);
      if (dialect.allows("w")) addMode("nearestWeekday", "builder.mode.nearestWeekday", buildNearestControls);
    }
    if (currentField.key === "dow") {
      if (dialect.allows("last")) addMode("lastDow", "builder.mode.lastDow", buildLastDowControls);
      if (dialect.allows("nth")) addMode("nthDow", "builder.mode.nthDow", buildNthControls);
    }
  }

  function renderCards(result, state) {
    lastResult = result;
    lastState = state;
    const dialect = CP.cron.dialect.get(state.dialect);
    if (!dialect) return;
    const tokens = tokensOf(state);
    const issues = result && result.issues ? result.issues : [];
    const fields = dialect.getFields();
    let known = false;
    for (const item of fields) {
      if (item.key === activeKey) { known = true; break; }
    }
    if (!known) activeKey = fields.length ? fields[0].key : null;
    const present = {};
    for (const field of fields) present[field.key] = true;
    for (const key of ALL_KEYS) {
      const orphan = CP.app.$("card-" + key);
      if (orphan && !present[key]) orphan.hidden = true;
    }
    for (const field of fields) {
      const card = CP.app.$("card-" + field.key);
      if (!card) continue;
      const index = dialect.fieldIndexOf(field.key);
      card.hidden = !!field.optional && !(state.yearEnabled && dialect.allows("year"));
      card.textContent = "";
      if (card.classList && typeof card.classList.remove === "function") {
        card.classList.remove("invalid", "active");
      }
      if (card.classList && typeof card.classList.add === "function") {
        card.classList.add("fc-" + field.key);
      }

      const input = document.createElement("input");
      input.type = "text";
      input.className = "field-card-input";
      input.value = tokens[index] || "*";
      input.spellcheck = false;
      input.setAttribute("aria-label", t(field.i18nKey));
      input.addEventListener("click", function (event) {
        const source = event.currentTarget || input;
        if (field.key !== activeKey) {
          pendingFocus = {
            key: field.key,
            offset: typeof source.selectionStart === "number" ? source.selectionStart : 0
          };
        }
      });
      input.addEventListener("keydown", function (event) {
        if (event.key === "Enter") input.blur();
      });
      input.addEventListener("change", function () {
        update(state, field.key, input.value.trim() || "*");
      });

      const label = document.createElement("span");
      label.className = "field-card-label";
      const dot = document.createElement("i");
      dot.className = "fdot fdot-" + field.key;
      dot.setAttribute("aria-hidden", "true");
      const text = document.createElement("span");
      text.textContent = t("field.long." + field.key);
      label.appendChild(dot);
      label.appendChild(text);

      card.appendChild(input);
      card.appendChild(label);

      const invalid = issues.some(function (issue) {
        return issue.severity === "error" && issue.fieldIndex === index;
      });
      if (invalid && card.classList && typeof card.classList.add === "function") {
        card.classList.add("invalid");
      }
      if (field.key === activeKey && !card.hidden &&
        card.classList && typeof card.classList.add === "function") {
        card.classList.add("active");
      }
      card.addEventListener("click", function () {
        if (card.hidden || field.key === activeKey) return;
        setActive(field.key);
      });
    }
    renderFocus(result, state);
    if (pendingFocus) {
      const focusCard = CP.app.$("card-" + pendingFocus.key);
      const focusInput = focusCard && focusCard.querySelector
        ? focusCard.querySelector(".field-card-input") : null;
      if (focusInput && typeof focusInput.focus === "function") {
        focusInput.focus();
        const offset = Math.min(pendingFocus.offset, focusInput.value.length);
        if (typeof focusInput.setSelectionRange === "function") {
          focusInput.setSelectionRange(offset, offset);
        }
      }
      pendingFocus = null;
    }
  }

  function setActive(key) {
    activeKey = key;
    if (lastState) renderCards(lastResult, lastState);
  }

  return {
    renderCards: renderCards,
    update: update,
    setActive: setActive,
    advanced: ADVANCED
  };
})();
