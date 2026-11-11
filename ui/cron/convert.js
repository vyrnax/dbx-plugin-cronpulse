CP.cron = CP.cron || {};
CP.cron.convert = (function () {
  "use strict";

  const D = function (name) { return CP.cron.dialect.get(name); };

  function remapNumber(value, source, target) {
    if (!Number.isFinite(Number(value))) return value;
    return source.normalizeDow(Number(value), target.name);
  }

  function remapCanonical(canonical, target) {
    return CP.cron.dialect.fromCanonical(canonical, target.dowBase(), false);
  }

  function remapItem(item, fieldAst, source, target) {
    const isDow = fieldAst.key === "dow";
    const clone = Object.assign({}, item);
    if (!isDow) return clone;
    if (item.type === "value" && item.name === null) {
      clone.value = remapNumber(item.value, source, target);
      clone.raw = String(clone.value);
    } else if (item.type === "range" || item.type === "step") {
      // 含字母的写法（MON-FRI）与方言无关，原样透传。
      if (/[A-Za-z]/.test(item.raw || "")) return clone;
      // 纯数字：星期区间可能跨周日边界回绕（canonical(0)==canonical(7)），
      // 直接重映射端点会产出逆向区间（如 spring 1-7 → quartz 2-1）。
      // 因此按逐值 canonicalValues 映射到目标数字集合，再压缩重建。
      if (Array.isArray(item.canonicalValues)) {
        clone.mappedValues = item.canonicalValues
          .map(function (c) { return remapCanonical(c, target); });
        clone.from = item.base === "*" ? target.dowRange().min : clone.mappedValues[0];
        clone.to = clone.mappedValues[clone.mappedValues.length - 1];
      } else if (item.base === "*") {
        clone.from = target.dowRange().min;
      } else {
        const cFrom = item.canonicalFrom !== undefined ? item.canonicalFrom : item.from;
        const cTo = item.canonicalTo !== undefined ? item.canonicalTo : item.to;
        if (Number.isFinite(cFrom)) clone.from = remapCanonical(cFrom, target);
        if (Number.isFinite(cTo)) clone.to = remapCanonical(cTo, target);
      }
    } else if (item.special === "lastN" || item.special === "nth") {
      if (Number.isFinite(item.dow)) {
        const mapped = remapCanonical(item.dow, target);
        clone.raw = item.raw.replace(/^[0-7]+/, String(mapped));
        clone.dow = item.dow;
        clone.mappedDow = mapped;
      }
    }
    return clone;
  }

  // 将星期数字集合压缩为区间与散值的混合写法（连续三个以上才并成区间）。
  function compactNumeric(values) {
    const out = [];
    let start = null, prev = null;
    const flush = function () {
      if (start === null) return;
      if (prev - start >= 3) out.push(start + "-" + prev);
      else { for (let v = start; v <= prev; v += 1) out.push(String(v)); }
      start = null; prev = null;
    };
    for (const v of values) {
      if (start === null) { start = v; prev = v; continue; }
      if (v === prev + 1) { prev = v; continue; }
      flush(); start = v; prev = v;
    }
    flush();
    return out.join(",");
  }

  function fieldToString(fieldAst, source, target, context) {
    if (!fieldAst) return "*";
    if (fieldAst.kind === "wildcard") return "*";
    if (fieldAst.kind === "question") {
      return target.allows("question") ? "?" : "*";
    }
    const parts = [];
    for (const item of fieldAst.items || []) {
      if (item.special === "question") {
        parts.push(target.allows("question") ? "?" : "*");
        continue;
      }
      if (item.special === "randomRange") {
        context.unsupported = "RANDOM_RANGE_NOT_DETERMINISTIC";
        parts.push(item.raw);
        continue;
      }
      if (["L", "LW", "Lminus", "W", "lastN", "nth"].indexOf(item.special) >= 0) {
        const feature = item.special === "L" || item.special === "Lminus" ? "last"
          : item.special === "LW" ? "lw" : item.special === "W" ? "w"
            : item.special === "lastN" ? "last" : "nth";
        if (!target.allows(feature)) context.unsupported = "UNSUPPORTED_IN_TARGET";
      }
      const mapped = remapItem(item, fieldAst, source, target);
      if (mapped.mappedDow !== undefined && mapped.special === "lastN") {
        parts.push(/^[0-7]/.test(item.raw) ? mapped.mappedDow + "L" : item.raw);
      } else if (mapped.mappedDow !== undefined && mapped.special === "nth") {
        parts.push(/^[0-7]/.test(item.raw) ? mapped.mappedDow + "#" + mapped.n : item.raw);
      } else if (mapped.type === "value" && mapped.name === null && fieldAst.key === "dow") {
        parts.push(String(mapped.value));
      } else if (mapped.type === "range" || mapped.type === "step") {
        // 含字母的名称写法（MON-FRI / MON-FRI/2）与方言星期基准无关，跨方言原样透传；
        // 仅纯数字区间才用重映射后的端点重建。
        if (/[A-Za-z]/.test(mapped.raw || "")) {
          parts.push(mapped.raw);
        } else if (Array.isArray(mapped.mappedValues)) {
          const sorted = mapped.mappedValues.slice().sort(function (a, b) { return a - b; });
          const min = target.dowRange().min;
          // 覆盖目标方言全部七天 → 直接用 （既省又不会回绕）
          const full = min === 1 ? sorted.length >= 7 : sorted.length >= 7;
          if (full) {
            parts.push("*");
          } else {
            parts.push(compactNumeric(sorted));
          }
        } else {
          const head = mapped.base === "*" ? "*" : String(mapped.from) +
            (mapped.type === "range" || mapped.headRange ? "-" + mapped.to : "");
          parts.push(head + (mapped.type === "step" ? "/" + mapped.step : ""));
        }
      } else {
        parts.push(mapped.raw || String(mapped.value));
      }
    }
    return parts.join(",");
  }

  function convert(ast, source, targetName) {
    const target = D(targetName);
    if (!target) return { ok: false, code: "BAD_DIALECT", messageKey: "msg.BAD_DIALECT" };
    if (!ast || !ast.fields || !ast.fields.length) {
      return { ok: false, code: "EMPTY_EXPRESSION", messageKey: "msg.EMPTY_EXPRESSION" };
    }
    const context = { unsupported: null, remapped: false, yearRemoved: false };
    const sourceFields = source.getFields();
    const targetFields = target.getFields().filter(function (field) { return !field.optional; });
    const sourceByKey = Object.create(null);
    ast.fields.forEach(function (fieldAst, index) {
      const spec = sourceFields[index];
      if (spec) sourceByKey[spec.key] = fieldAst;
    });

    const strings = targetFields.map(function (field) {
      let fieldAst = sourceByKey[field.key];
      if (!fieldAst) {
        if (field.key === "sec") return "0";
        if (field.key === "year") return "*";
        return "*";
      }
      if (field.key === "sec" && source.fieldIndexOf("sec") < 0) return "0";
      if (field.key === "dow" && source.dowBase() !== target.dowBase()) {
        const numeric = (fieldAst.items || []).some(function (item) {
          return item.type === "value" && item.name === null ||
            item.special === "lastN" || item.special === "nth" ||
            item.type === "range" || item.type === "step";
        });
        if (numeric && fieldAst.kind !== "question" && fieldAst.kind !== "wildcard") {
          context.remapped = true;
        }
      }
      return fieldToString(fieldAst, source, target, context);
    });

    if (source.fieldIndexOf("year") >= 0 && sourceByKey.year && !target.allows("year")) {
      context.yearRemoved = true;
    } else if (sourceByKey.year && target.allows("year")) {
      strings.push(fieldToString(sourceByKey.year, source, target, context));
    }

    if (target.dayMatch() === "intersection" && target.allows("question")) {
      const domIndex = target.fieldIndexOf("dom");
      const dowIndex = target.fieldIndexOf("dow");
      const dom = strings[domIndex];
      const dow = strings[dowIndex];
      const concrete = function (text) { return text !== "*" && text !== "?"; };
      if (concrete(dom) && concrete(dow)) strings[domIndex] = "?";
      else if (!concrete(dom) && !concrete(dow)) strings[dowIndex] = "?";
    }

    const expression = strings.join(" ");
    // 并集语义（crontab 的“日 或 周”）无法在交集方言无损表达：
    // 源里 dom 与 dow 同时被限定（都 concrete）时，交集方言只能保留其一，另一个语义会静默丢失。
    if (source.dayMatch() === "union" && target.dayMatch() === "intersection") {
      const domAst = sourceByKey.dom;
      const dowAst = sourceByKey.dow;
      const limited = function (fieldAst) {
        return !!fieldAst && fieldAst.kind !== "wildcard" && fieldAst.kind !== "question";
      };
      if (limited(domAst) && limited(dowAst)) {
        return {
          ok: false, code: "LOSSY_DAY_UNION", messageKey: "msg.LOSSY_DAY_UNION",
          expression: expression, reason: "LOSSY_DAY_UNION", remapped: context.remapped
        };
      }
    }
    if (context.unsupported) {
      return {
        ok: false, code: context.unsupported, messageKey: "msg." + context.unsupported,
        expression: expression, reason: context.unsupported, remapped: context.remapped
      };
    }
    const reparsed = CP.cron.parse.parse(expression, target);
    const validation = CP.cron.validate.validate(reparsed, target, {});
    const ok = validation.status !== "error";
    return {
      ok: ok, code: ok ? null : validation.issues[0].code,
      messageKey: ok ? null : validation.issues[0].messageKey,
      expression: expression, tokens: strings,
      remapped: context.remapped, yearRemoved: context.yearRemoved,
      validation: validation
    };
  }

  function allTargets(ast, source) {
    const result = {};
    for (const name of CP.cron.dialect.list()) {
      result[name] = convert(ast, source, name);
    }
    return result;
  }

  return { convert: convert, allTargets: allTargets, remapNumber: remapNumber };
})();

CP.convert = (function () {
  "use strict";

  function renderCompare(el, result, state) {
    if (!el) return;
    el.textContent = "";
    if (!result || !result.ast || !result.ast.fields.length) return;
    const heading = document.createElement("span");
    heading.className = "compare-name";
    heading.textContent = CP.i18n.t("compare.title");
    el.appendChild(heading);
    const targets = CP.cron.convert.allTargets(result.ast, result.dialect);
    for (const name of Object.keys(targets)) {
      const item = document.createElement("div");
      item.className = "compare-item";
      const label = document.createElement("span");
      label.className = "compare-name";
      const spec = CP.cron.dialect.get(name);
      label.textContent = spec ? spec.label : name;
      const value = document.createElement("span");
      value.className = "compare-value";
      value.textContent = targets[name].ok ? targets[name].expression : "—";
      item.appendChild(label);
      item.appendChild(value);
      el.appendChild(item);
    }
  }

  return { renderCompare: renderCompare };
})();
