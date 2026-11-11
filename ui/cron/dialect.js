window.CP = window.CP || {};
CP.cron = CP.cron || {};
CP.cron.dialect = (function () {
  "use strict";

  const REGISTRY = Object.create(null);

  const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
    "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const DOW_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

  const MACROS = {
    unix: Object.freeze({
      "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *",
      "@weekly": "0 0 * * 0", "@daily": "0 0 * * *", "@midnight": "0 0 * * *",
      "@hourly": "0 * * * *", "@reboot": null
    }),
    spring: Object.freeze({
      "@yearly": "0 0 0 1 1 *", "@annually": "0 0 0 1 1 *", "@monthly": "0 0 0 1 * *",
      "@weekly": "0 0 0 * * 0", "@daily": "0 0 0 * * *", "@midnight": "0 0 0 * * *",
      "@hourly": "0 0 * * * *"
    })
  };

  const BASELINE = {
    name: "", label: "", selectable: true, hintKey: "hint.unixDow",
    dowBase: "unix", dayMatch: "union", macroSet: "unix",
    features: {
      question: false, last: false, lMinus: false, lw: false, w: false, nth: false,
      year: false, names: true, randomRange: false, rebootMacro: false, macros: false
    },
    fields: []
  };

  const FIELD_BASELINE = {
    key: "", i18nKey: "", min: 0, max: 0, stepMin: 1, stepMax: 1,
    optional: false,
    itemTypes: ["wildcard", "question", "value", "range", "step", "list", "names"]
  };

  const SEC = { key: "sec", i18nKey: "field.sec", min: 0, max: 59, stepMin: 1, stepMax: 59 };
  const MIN = { key: "min", i18nKey: "field.min", min: 0, max: 59, stepMin: 1, stepMax: 59 };
  const HOUR = { key: "hour", i18nKey: "field.hour", min: 0, max: 23, stepMin: 1, stepMax: 23 };
  const DOM = { key: "dom", i18nKey: "field.dom", min: 1, max: 31, stepMin: 1, stepMax: 31 };
  const MONTH = { key: "month", i18nKey: "field.month", min: 1, max: 12, stepMin: 1, stepMax: 12 };
  const DOW = { key: "dow", i18nKey: "field.dow", min: 0, max: 7, stepMin: 1, stepMax: 7 };
  // 年份上限取自官方允许值（1970-2099），不能放到 2199
  const YEAR = { key: "year", i18nKey: "field.year", min: 1970, max: 2099, stepMin: 1, stepMax: 129, optional: true };
  const UNIX_FIELDS = [MIN, HOUR, DOM, MONTH, DOW];
  const SIX_FIELDS = [SEC, MIN, HOUR, DOM, MONTH, DOW];

  function toCanonical(value, base) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return 0;
    if (base === "quartz") return Math.min(6, Math.max(0, n - 1));
    return ((n % 7) + 7) % 7;
  }

  function fromCanonical(canonical, base, preferSeven) {
    if (base === "quartz") return canonical + 1;
    return canonical === 0 && preferSeven ? 7 : canonical;
  }

  function selfCheck(d) {
    const fields = d.getFields();
    if (fields.length < 5 || fields.length > 7) throw new Error("field count must be 5..7: " + d.name);
    if (d.dowBase() !== "unix" && d.dowBase() !== "quartz") throw new Error("invalid dowBase: " + d.name);
    if (d.dayMatch() !== "union" && d.dayMatch() !== "intersection") throw new Error("invalid dayMatch: " + d.name);
    if (d.dayMatch() === "intersection" && !d.allows("question")) {
      throw new Error("intersection requires ?: " + d.name);
    }
    if (d.allows("year") && d.getOptionalFields().length === 0) {
      throw new Error("year feature requires an optional field: " + d.name);
    }
    for (const field of fields) {
      if (!(field.min <= field.max)) throw new Error("inconsistent field range: " + d.name + "." + field.key);
      if (d.fieldIndexOf(field.key) < 0) throw new Error("missing field index: " + d.name + "." + field.key);
    }
  }

  function create(spec) {
    const fields = Object.freeze((spec.fields || []).map(function (field) {
      return Object.freeze(Object.assign({}, FIELD_BASELINE, field));
    }));
    const features = Object.freeze(Object.assign({}, BASELINE.features, spec.features || {}));
    const indexByName = Object.create(null);
    fields.forEach(function (field, index) { indexByName[field.key] = index; });
    const concrete = fields.filter(function (field) { return !field.optional; });
    const base = Object.assign({}, BASELINE, spec, { fields: fields, features: features });
    const instance = Object.freeze(Object.assign({}, base, {
      fieldIndexByName: Object.freeze(indexByName),
      fieldCountMin: concrete.length,
      fieldCountMax: fields.length,
      getFields: function () { return fields; },
      getOptionalFields: function () { return fields.filter(function (f) { return f.optional; }); },
      fieldIndexOf: function (key) {
        return Object.prototype.hasOwnProperty.call(indexByName, key) ? indexByName[key] : -1;
      },
      allows: function (feature) { return !!features[feature]; },
      dowBase: function () { return base.dowBase; },
      dowRange: function () {
        return Object.freeze({ min: base.dowBase === "quartz" ? 1 : 0, max: 7 });
      },
      dayMatch: function () { return base.dayMatch; },
      normalizeDow: function (value, targetName) {
        const target = REGISTRY[targetName] || instance;
        const canonical = toCanonical(value, base.dowBase);
        return fromCanonical(canonical, target.dowBase(), Math.round(Number(value)) === 7);
      },
      normalizeMonth: function (value) {
        if (typeof value === "number") return value;
        const text = String(value || "").slice(0, 3).toUpperCase();
        const index = MONTH_NAMES.indexOf(text);
        return index < 0 ? Number(value) : index + 1;
      },
      macroTable: function () { return MACROS[base.macroSet] || MACROS.unix; },
      stepForms: function () { return ["a/b", "*/b", "a-b/c"]; },
      monthNames: function () { return MONTH_NAMES; },
      dowNames: function () { return DOW_NAMES; }
    }));
    selfCheck(instance);
    return instance;
  }

  function register(spec) {
    const d = create(spec);
    REGISTRY[d.name] = d;
    return d;
  }

  function get(name) { return REGISTRY[name] || null; }
  function list() { return Object.keys(REGISTRY).filter(function (n) { return REGISTRY[n].selectable; }); }
  function names() { return Object.keys(REGISTRY); }
  function remove(name) { delete REGISTRY[name]; }

  register({
    name: "unix", label: "Unix (Linux Crontab)", hintKey: "hint.unixDow",
    dowBase: "unix", dayMatch: "union", macroSet: "unix",
    features: { names: true, randomRange: true, rebootMacro: true, macros: true },
    fields: UNIX_FIELDS
  });

  register({
    name: "spring", label: "Spring (@Scheduled)", hintKey: "hint.springDow",
    dowBase: "unix", dayMatch: "intersection", macroSet: "spring",
    features: {
      question: true, last: true, lMinus: true, lw: true, w: true, nth: true,
      names: true, macros: true
    },
    fields: SIX_FIELDS
  });

  register({
    name: "quartz", label: "Quartz (Java)", hintKey: "hint.quartzDow",
    dowBase: "quartz", dayMatch: "intersection", macroSet: "spring",
    features: {
      question: true, last: true, lMinus: true, lw: true, w: true, nth: true,
      year: true, names: true
    },
    fields: SIX_FIELDS.concat([YEAR])
  });

  register({
    name: "robfig", label: "robfig compatibility", selectable: false, hintKey: "hint.unixDow",
    dowBase: "unix", dayMatch: "union", macroSet: "unix",
    features: { question: true, macros: true, names: true },
    fields: UNIX_FIELDS
  });

  register({
    name: "nodecron", label: "node-cron compatibility", selectable: false, hintKey: "hint.unixDow",
    dowBase: "unix", dayMatch: "union", macroSet: "unix",
    features: { names: true, macros: true },
    fields: UNIX_FIELDS
  });

  return {
    register: register, create: create, get: get, list: list, names: names,
    remove: remove, toCanonical: toCanonical, fromCanonical: fromCanonical,
    monthNames: MONTH_NAMES, dowNames: DOW_NAMES
  };
})();
