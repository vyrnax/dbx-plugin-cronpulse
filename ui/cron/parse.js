CP.cron = CP.cron || {};
CP.cron.parse = (function () {
  "use strict";

  function rawRange(field, dialect, bits) {
    if (field.key === "dow") return dialect.dowRange();
    return { min: field.min, max: field.max, stepMax: bits || field.stepMax };
  }

  function resolve(text, field, dialect) {
    const result = { value: Number.NaN, canonical: Number.NaN, name: null, error: null, suggestion: null };
    if (/^\d+$/.test(text)) {
      result.value = Number(text);
      result.canonical = result.value;
    } else if (/^[A-Za-z]+$/.test(text)) {
      const short = text.slice(0, 3).toUpperCase();
      const table = field.key === "month" ? dialect.monthNames()
        : field.key === "dow" ? dialect.dowNames() : null;
      if (!table || table.indexOf(short) < 0) {
        result.error = "BAD_NAME";
        return result;
      }
      if (text.length > 3) {
        result.error = "NAME_TOO_LONG";
        result.suggestion = short;
        return result;
      }
      const index = table.indexOf(short);
      // 名称与方言无关：canonical 恒为该名称的通用序号（月份 1-12，星期 0-6=周日…周六）。
      // value 则是"当前方言写法下的数字"——星期按方言基准换算，Quartz 的 SUN 记 1、Unix 的 SUN 记 0，
      // 否则名称会拿去和方言数字范围比对而误判越界（Quartz 里 SUN 曾被判 OUT_OF_RANGE）。
      result.name = short;
      if (field.key === "month") {
        result.canonical = index + 1;
        result.value = index + 1;
      } else {
        result.canonical = index;
        result.value = CP.cron.dialect.fromCanonical(index, dialect.dowBase(), false);
      }
    } else {
      result.error = "SYNTAX_UNEXPECTED_CHAR";
      return result;
    }
    const range = rawRange(field, dialect);
    if (!Number.isFinite(result.value) || result.value < range.min || result.value > range.max) {
      result.error = "OUT_OF_RANGE";
      return result;
    }
    if (field.key === "dow" && result.name === null) {
      // 纯数字才按方言基准归一；名称分支已设好 canonical，勿覆盖
      result.canonical = CP.cron.dialect.toCanonical(result.value, dialect.dowBase());
    }
    return result;
  }

  function makeItem(type, raw, offset, extra) {
    return Object.assign({
      type: type, raw: raw, charOffset: offset, charLength: raw.length, error: null
    }, extra || {});
  }

  function parseSpecial(text, field, dialect, offset, all) {
    let match;
    if ((match = /^L-(\d+)$/i.exec(text))) {
      return makeItem("special", text, offset, { special: "Lminus", offsetValue: Number(match[1]) });
    }
    if (/^LW$/i.test(text)) return makeItem("special", text, offset, { special: "LW" });
    if (/^L$/i.test(text)) {
      if (field.key === "dow") return makeItem("special", text, offset, { special: "lastN", dow: 6, rawDow: "L" });
      return makeItem("special", text, offset, { special: "L" });
    }
    if ((match = /^(\d{1,2})W$/i.exec(text))) {
      return makeItem("special", text, offset, { special: "W", day: Number(match[1]) });
    }
    if ((match = /^([0-7A-Za-z]{1,3})L$/i.exec(text))) {
      const r = resolve(match[1], field, dialect);
      return makeItem("special", text, offset, {
        special: "lastN", dow: r.canonical, rawDow: match[1], error: r.error
      });
    }
    if ((match = /^([0-7A-Za-z]{1,3})#([1-5])$/i.exec(text))) {
      const r = resolve(match[1], field, dialect);
      return makeItem("special", text, offset, {
        special: "nth", dow: r.canonical, n: Number(match[2]), rawDow: match[1], error: r.error
      });
    }
    if (/^#\d+$/.test(text)) return makeItem("special", text, offset, { special: "nthStray" });
    if ((match = /^(\d+)~(\d+)$/.exec(text))) {
      return makeItem("special", text, offset, {
        special: "randomRange", from: Number(match[1]), to: Number(match[2])
      });
    }
    if (/[0-9][LW#]|[LW#][0-9]|~/.test(text)) {
      return makeItem("special", text, offset, { special: "unknown" });
    }
    return null;
  }

  function parseItem(text, field, dialect, offset) {
    const special = parseSpecial(text, field, dialect, offset, false);
    if (special) return special;

    if (text === "*") return makeItem("wildcard", text, offset, {});

    let match;
    if ((match = /^(.+)\/(\d+)$/.exec(text))) {
      const head = match[1];
      const step = Number(match[2]);
      const item = makeItem("step", text, offset, { step: step, error: step === 0 ? "STEP_ZERO" : null });
      if (head === "*") {
        item.base = "*";
        item.from = field.min;
        item.to = field.max;
        item.canonicalFrom = field.min;
        item.canonicalTo = field.max;
      } else if ((/-/.test(head))) {
        const parts = head.split("-");
        const a = resolve(parts[0], field, dialect);
        const b = resolve(parts[1], field, dialect);
        item.headRange = true;
        item.from = a.value;
        item.to = b.value;
        item.canonicalFrom = a.canonical;
        item.canonicalTo = b.canonical;
        item.error = item.error || a.error || b.error || (Number.isFinite(a.value) && Number.isFinite(b.value) && a.value > b.value ? "RANGE_REVERSED" : null);
      } else {
        const a = resolve(head, field, dialect);
        item.base = head;
        item.from = a.value;
        item.to = field.max;
        item.canonicalFrom = a.canonical;
        item.canonicalTo = field.max;
        item.error = item.error || a.error;
      }
      if (step > field.stepMax) item.error = item.error || "STEP_GT_RANGE";
      return item;
    }

    if ((match = /^(.+)-(.+)$/.exec(text))) {
      const a = resolve(match[1], field, dialect);
      const b = resolve(match[2], field, dialect);
      return makeItem("range", text, offset, {
        from: a.value, to: b.value, canonicalFrom: a.canonical, canonicalTo: b.canonical,
        step: 1, base: match[1], error: a.error || b.error ||
          (Number.isFinite(a.value) && Number.isFinite(b.value) && a.value > b.value ? "RANGE_REVERSED" : null)
      });
    }

    const r = resolve(text, field, dialect);
    return makeItem(r.name !== null ? "names" : "value", text, offset, {
      value: r.value, canonical: r.canonical, name: r.name,
      error: r.error, suggestion: r.suggestion
    });
  }

  // dow 的区间与步长写法必须在原始数字域推进后，再逐个归一到 canonical：
  // canonical(0) 与 canonical(7) 同为周日，若直接对 canonical 端点 fill 会丢信息，
  // 导致 1-7 塌空、0-7 只剩周日、5-7 反被当成全域等经典 crontab 陷阱。
  function expandDow(item, field, dialect) {
    const from = Number.isFinite(item.from) ? item.from : field.min;
    const to = Number.isFinite(item.to) ? item.to : field.max;
    const step = item.step > 0 ? item.step : 1;
    const values = [];
    for (let value = from; value <= to; value += step) {
      values.push(CP.cron.dialect.toCanonical(value, dialect.dowBase()));
    }
    return values;
  }

  function parseField(token, field, dialect, offset) {
    const ast = {
      key: field.key, raw: token, kind: "list", items: [],
      charOffset: offset, charLength: token.length,
      domSpecial: null, dowSpecial: null
    };
    if (token === "*") {
      ast.kind = "wildcard";
      ast.items.push(makeItem("wildcard", token, offset, {}));
      return ast;
    }
    if (token === "?") {
      ast.kind = "question";
      ast.items.push(makeItem("special", token, offset, { special: "question" }));
      return ast;
    }
    let cursor = 0;
    for (const part of token.split(",")) {
      const partOffset = offset + token.indexOf(part, cursor);
      cursor = token.indexOf(part, cursor) + part.length;
      const item = parseItem(part, field, dialect, partOffset);
      if (field.key === "dow" && (item.type === "range" || item.type === "step")) {
        item.canonicalValues = expandDow(item, field, dialect);
      }
      ast.items.push(item);
      if (item.special && field.key === "dom" && ["L", "LW", "Lminus", "W"].indexOf(item.special) >= 0) {
        ast.domSpecial = { kind: item.special, offset: item.offsetValue || 0, day: item.day || 0,
          charOffset: item.charOffset, charLength: item.charLength };
      }
      if (item.special && field.key === "dow" && ["lastN", "nth"].indexOf(item.special) >= 0) {
        ast.dowSpecial = { kind: item.special, dow: item.dow, n: item.n || 0,
          charOffset: item.charOffset, charLength: item.charLength };
      }
    }
    return ast;
  }

  function tokenize(source, baseOffset, fromMacro) {
    const tokens = [];
    const re = /\S+/g;
    let match;
    while ((match = re.exec(source)) !== null) {
      tokens.push({
        text: match[0],
        charOffset: fromMacro ? baseOffset : baseOffset + match.index,
        charLength: fromMacro ? source.trim().length : match[0].length
      });
    }
    return tokens;
  }

  const MAX_INPUT = 4096;

  function parse(expression, dialect) {
    const raw = String(expression == null ? "" : expression);
    const effective = raw.length > MAX_INPUT ? raw.slice(0, MAX_INPUT) : raw;
    const trimmed = effective.trim().replace(/\s+/g, " ");
    const ast = {
      raw: raw, normalized: trimmed, expandedFrom: null, nonTemporal: false,
      tooLong: effective !== raw, maxInput: MAX_INPUT,
      tokens: [], fields: [], fieldTokens: [], dialect: dialect.name
    };
    if (!trimmed) return ast;

    let source = effective;
    let macroOffset = -1;
    if (trimmed.charAt(0) === "@") {
      const macro = trimmed.toLowerCase();
      const table = dialect.macroTable();
      if (Object.prototype.hasOwnProperty.call(table, macro)) {
        ast.expandedFrom = trimmed;
        if (table[macro] === null) {
          ast.nonTemporal = true;
          ast.tokens = [{ text: trimmed, charOffset: raw.indexOf(trimmed), charLength: trimmed.length }];
          return ast;
        }
        source = table[macro];
        macroOffset = raw.indexOf(trimmed);
      }
    }
    const isMacro = macroOffset >= 0;
    ast.tokens = tokenize(source, isMacro ? macroOffset : 0, isMacro);
    const fields = dialect.getFields();
    for (let index = 0; index < ast.tokens.length; index += 1) {
      const token = ast.tokens[index];
      const field = fields[index];
      if (!field) {
        ast.fieldTokens.push(token);
        continue;
      }
      ast.fields.push(parseField(token.text, field, dialect, token.charOffset));
    }
    return ast;
  }

  return { parse: parse, parseField: parseField, resolve: resolve, rawRange: rawRange };
})();
