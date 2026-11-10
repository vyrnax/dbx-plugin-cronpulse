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
      if (item.base !== "*" && Number.isFinite(item.from)) clone.from = remapNumber(item.from, source, target);
      if (item.to !== 7 && Number.isFinite(item.to) && item.canonicalTo === undefined) {
        clone.to = remapNumber(item.to, source, target);
      }
      if (item.base === "*") clone.from = target.dowRange().min;
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
        const head = mapped.base === "*" ? "*" : String(mapped.from) +
          (mapped.type === "range" || mapped.headRange ? "-" + mapped.to : "");
        parts.push(head + (mapped.type === "step" ? "/" + mapped.step : ""));
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
