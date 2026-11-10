CP.cron = CP.cron || {};
CP.cron.describe = (function () {
  "use strict";

  const TEMPLATE_KEYS = [
    "every", "at", "onDay", "inMonth", "inYear", "question", "wildcard",
    "Lminus", "lastDay", "LW", "W", "lastDow", "nthDow", "stepFrom", "rangeStep", "range",
    "values", "union", "intersection", "dst", "fieldLabel", "secondShort",
    "everyHour", "everyMinute", "everyNMinutes", "atMinuteN", "atMinutesList",
    "betweenTimes", "atTimesList", "dowRange", "monthRange", "domRange",
    "weekday.0", "weekday.1", "weekday.2", "weekday.3", "weekday.4", "weekday.5", "weekday.6",
    "month.1", "month.2", "month.3", "month.4", "month.5", "month.6",
    "month.7", "month.8", "month.9", "month.10", "month.11", "month.12"
  ];

  function table(lang) {
    return CP.i18n.dict[lang] || CP.i18n.dict.en;
  }

  function L(key, params, lang) {
    const dict = table(lang);
    let text = dict["desc." + key];
    if (text === undefined) text = CP.i18n.dict.en["desc." + key] || key;
    if (params) {
      text = String(text).replace(/\{(\w+)\}/g, function (match, name) {
        return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
      });
    }
    return text;
  }

  function ordinal(value, lang) {
    const n = Number(value);
    if (lang !== "en") return String(n);
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 13) return n + "th";
    return n + ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
  }

  function join(parts, lang) {
    const valid = parts.filter(function (part) { return !!part; });
    return valid.join(lang === "zh-CN" ? "，" : ", ");
  }

  function describeItem(item, field, dialect, lang) {
    if (item.type === "wildcard") return L("wildcard", { field: L("fieldLabel", { name: CP.i18n.dict[lang]["field." + field.key] }, lang) }, lang);
    if (item.type === "value" || item.type === "names") {
      if (field.key === "dow" && item.canonical !== undefined) return L("weekday." + item.canonical, null, lang);
      if (field.key === "month" && item.canonical >= 1 && item.canonical <= 12) return L("month." + item.canonical, null, lang);
      return String(item.raw);
    }
    if (item.type === "range") {
      if (item.from === field.min && item.to === field.max) {
        return L("every", { field: L("fieldLabel", { name: CP.i18n.dict[lang]["field." + field.key] }, lang) }, lang);
      }
      if (field.key === "dow") {
        return L("dowRange", {
          from: L("weekday." + item.from, null, lang),
          to: L("weekday." + item.to, null, lang)
        }, lang);
      }
      if (field.key === "month") {
        return L("monthRange", {
          from: L("month." + item.from, null, lang),
          to: L("month." + item.to, null, lang)
        }, lang);
      }
      if (field.key === "dom") {
        return L("domRange", { from: item.from, to: item.to }, lang);
      }
      return L("range", { from: item.from, to: item.to }, lang);
    }
    if (item.type === "step") {
      if (item.base === "*" || item.from === field.min) {
        return L("stepFrom", { from: item.base === "*" ? field.min : item.from, step: item.step }, lang);
      }
      if (item.canonicalFrom !== undefined && item.to !== field.max) {
        return L("rangeStep", { from: item.from, to: item.to, step: item.step }, lang);
      }
      return L("stepFrom", { from: item.from, step: item.step }, lang);
    }
    if (item.type === "special") {
      if (item.special === "question") return L("question", null, lang);
      if (item.special === "L") return L("lastDay", null, lang);
      if (item.special === "Lminus") {
        return L("Lminus", { n: item.offsetValue, ordinal: ordinal(item.offsetValue, lang) }, lang);
      }
      if (item.special === "LW") return L("LW", null, lang);
      if (item.special === "W") return L("W", { n: item.day, ordinal: ordinal(item.day, lang) }, lang);
      if (item.special === "lastN") {
        return L("lastDow", { weekday: L("weekday." + item.dow, null, lang) }, lang);
      }
      if (item.special === "nth") {
        return L("nthDow", {
          n: item.n, ordinal: ordinal(item.n, lang),
          weekday: L("weekday." + item.dow, null, lang)
        }, lang);
      }
      return String(item.raw);
    }
    return String(item.raw);
  }

  function describeField(fieldAst, field, dialect, lang) {
    if (!fieldAst) return "";
    if (fieldAst.kind === "question") return L("question", null, lang);
    if (fieldAst.kind === "wildcard") return L("every", { field: CP.i18n.dict[lang]["field." + field.key] }, lang);
    const parts = (fieldAst.items || []).map(function (item) {
      return describeItem(item, field, dialect, lang);
    });
    return join(parts, lang);
  }

  function compactTime(bm, dialect) {
    const single = function (key) {
      const entry = bm[key];
      if (!entry || entry.specials.length) return null;
      const values = CP.cron.bits.toArray(entry.bits);
      return values.length === 1 ? values[0] : null;
    };
    const hour = single("hour");
    const minute = single("min");
    const second = single("sec");
    if (hour === null || minute === null || second === null) return null;
    const pad = function (value) { return String(value).padStart(2, "0"); };
    return pad(hour) + ":" + pad(minute) +
      (dialect.fieldIndexOf("sec") >= 0 ? ":" + pad(second) : "");
  }

  function timeText(fieldLines, lang, compact) {
    if (compact) return compact;
    const keys = ["sec", "min", "hour"];
    const parts = [];
    for (const key of keys) {
      if (fieldLines[key]) parts.push(fieldLines[key]);
    }
    return join(parts, lang);
  }

  function fieldAstOf(ast, dialect, key) {
    const index = dialect.fieldIndexOf(key);
    return index >= 0 ? ast.fields[index] : null;
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function timeOfDay(hour, minute) {
    return pad2(hour) + ":" + pad2(minute);
  }

  function collectValues(fieldAst, field) {
    if (!fieldAst || fieldAst.kind === "question" || fieldAst.kind === "wildcard") return null;
    const values = [];
    for (const item of fieldAst.items || []) {
      if (item.type === "value") values.push(Number(item.raw));
      else if (item.type === "range") {
        for (let v = item.from; v <= item.to; v += 1) values.push(v);
      } else return null;
    }
    const unique = Array.from(new Set(values)).sort(function (a, b) { return a - b; });
    if (!unique.length) return null;
    for (const v of unique) {
      if (v < field.min || v > field.max) return null;
    }
    const contiguous = unique[unique.length - 1] - unique[0] + 1 === unique.length;
    if (!contiguous && unique.length > 8) return null;
    return unique;
  }

  function nameList(parts, lang) {
    if (parts.length <= 1) return parts.join("");
    if (lang === "zh-CN") return parts.join("、");
    return parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
  }

  function minuteInfoOf(minAst, field) {
    if (!minAst || minAst.kind === "question") return null;
    if (minAst.kind === "wildcard") return { kind: "wildcard" };
    const items = minAst.items || [];
    if (!items.length) return null;
    for (const item of items) {
      if (item.type === "special") return null;
      if (item.type === "step" && !(item.base === "*" || Number(item.from) === field.min)) return null;
    }
    const values = collectValues(minAst, field);
    if (values) {
      if (values.length === 1) return { kind: "single", value: values[0] };
      if (values.length === 2 && values[1] - values[0] > 4) return null;
      return { kind: "list", values: values };
    }
    if (items.length === 1 && items[0].type === "step") {
      return { kind: "step", step: items[0].step };
    }
    return null;
  }

  function minutePhrase(info, lang) {
    if (info.kind === "wildcard") return L("everyMinute", null, lang);
    if (info.kind === "single") {
      return info.value === 0 ? L("everyHour", null, lang) : L("atMinuteN", { m: info.value }, lang);
    }
    if (info.kind === "step") return L("everyNMinutes", { n: info.step }, lang);
    return L("atMinutesList", { list: nameList(info.values.map(String), lang) }, lang);
  }

  function hourPhrase(values, endpointMinute, lang) {
    const contiguous = values[values.length - 1] - values[0] + 1 === values.length;
    if (contiguous) {
      return L("betweenTimes", {
        from: timeOfDay(values[0], endpointMinute),
        to: timeOfDay(values[values.length - 1], endpointMinute)
      }, lang);
    }
    const times = values.map(function (hour) { return timeOfDay(hour, endpointMinute); });
    return L("atTimesList", { list: nameList(times, lang) }, lang);
  }

  function guruTime(ast, dialect, lang) {
    const minField = dialect.getFields()[dialect.fieldIndexOf("min")];
    const hourField = dialect.getFields()[dialect.fieldIndexOf("hour")];
    if (!minField || !hourField) return null;
    const secAst = fieldAstOf(ast, dialect, "sec");
    if (secAst && !(secAst.kind === "wildcard" ||
      (secAst.items || []).some(function (item) {
        return item.type === "value" && Number(item.raw) === 0;
      }))) return null;
    const minute = minuteInfoOf(fieldAstOf(ast, dialect, "min"), minField);
    const hours = collectValues(fieldAstOf(ast, dialect, "hour"), hourField);
    if (!minute || !hours || hours.length < 2) return null;
    const endpointMinute = minute.kind === "single" ? minute.value : 0;
    return join([minutePhrase(minute, lang), hourPhrase(hours, endpointMinute, lang)], lang);
  }

  function describe(ast, dialect, options) {
    const opts = options || {};
    const lang = opts.lang === "zh-CN" ? "zh-CN" : "en";
    const fields = dialect.getFields();
    const fieldLines = {};
    for (let index = 0; index < ast.fields.length; index += 1) {
      const spec = fields[index];
      if (!spec) continue;
      fieldLines[spec.key] = describeField(ast.fields[index], spec, dialect, lang);
    }
    const bm = CP.cron.next.buildBitmaps(ast, dialect);
    const relation = dialect.dayMatch() === "union" ? L("union", null, lang) : L("intersection", null, lang);
    const dayParts = [];
    if (bm.dom.concrete) dayParts.push(fieldLines.dom || "");
    if (bm.dow.concrete) dayParts.push(fieldLines.dow || "");
    const day = join(dayParts, lang);
    const month = bm.month.concrete ? L("inMonth", { months: fieldLines.month }, lang) : "";
    const year = bm.year && bm.year.concrete ? L("inYear", { years: fieldLines.year }, lang) : "";
    const time = guruTime(ast, dialect, lang) ||
      L("at", { time: timeText(fieldLines, lang, compactTime(bm, dialect)) }, lang);
    const full = join([time, day ? L("onDay", { day: day }, lang) : "", month, year], lang);
    return {
      full: full, time: time, day: day, month: month, year: year,
      fieldLines: fieldLines, dayRelation: relation, lang: lang,
      dstNote: L("dst", null, lang)
    };
  }

  return { describe: describe, describeField: describeField, templateKeys: TEMPLATE_KEYS, L: L };
})();
