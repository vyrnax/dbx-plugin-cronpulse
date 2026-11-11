CP.cron = CP.cron || {};
CP.cron.validate = (function () {
  "use strict";

  const DAY_FIELDS = ["dom", "dow"];

  function makeIssue(code, fieldIndex, fieldName, item, severity, params, suggestion) {
    return {
      code: code,
      fieldIndex: typeof fieldIndex === "number" ? fieldIndex : -1,
      fieldName: fieldName || "",
      charOffset: item ? item.charOffset : 0,
      charLength: item ? item.charLength : 0,
      severity: severity || "error",
      messageKey: "msg." + code,
      params: params || {},
      suggestion: suggestion || null
    };
  }

  function hasQuestion(fieldAst) {
    return !!fieldAst && (fieldAst.kind === "question" ||
      (fieldAst.items || []).some(function (item) { return item.special === "question"; }));
  }

  function isWildcard(fieldAst) {
    return !!fieldAst && fieldAst.kind === "wildcard";
  }

  function numericItems(fieldAst) {
    if (!fieldAst) return [];
    return (fieldAst.items || []).filter(function (item) {
      return (item.type === "value" || item.type === "range" || item.type === "step") &&
        !/[A-Za-z]/.test(item.raw || "");
    });
  }

  function validate(ast, dialect, options) {
    const opts = options || {};
    const issues = [];
    const fields = dialect.getFields();
    if (!ast || !ast.normalized) return { status: "empty", issues: issues, predictable: false };

    if (ast.nonTemporal) {
      issues.push(makeIssue("REBOOT_MACRO_HAS_NO_TIME", -1, "", ast.tokens[0], "warning", {}));
      return { status: "warning", issues: issues, predictable: false };
    }

    if (ast.tooLong) {
      issues.push(makeIssue("INPUT_TOO_LONG", -1, "", null, "error", { value: ast.maxInput }));
    }
    const tokenCount = ast.tokens.length;
    if (tokenCount < dialect.fieldCountMin || tokenCount > dialect.fieldCountMax) {
      issues.push(makeIssue("FIELD_COUNT_MISMATCH", -1, "", null, "error", {
        expected: dialect.fieldCountMin + (dialect.fieldCountMax > dialect.fieldCountMin ? ".." + dialect.fieldCountMax : ""),
        actual: tokenCount
      }));
    }

    let hasRandom = false;
    let hasNames = false;
    for (let index = 0; index < ast.fields.length; index += 1) {
      const fieldAst = ast.fields[index];
      const spec = fields[index];
      if (!spec) continue;
      const fieldName = spec.i18nKey;
      for (const item of fieldAst.items || []) {
        if (item.error) {
          issues.push(makeIssue(item.error, index, fieldName, item, "error", {
            value: item.raw, field: fieldName, suggestion: item.suggestion || ""
          }, item.suggestion || null));
        }
        if (item.type === "names") hasNames = true;
        if (item.special === "randomRange") {
          hasRandom = true;
          issues.push(makeIssue("RANDOM_RANGE_NOT_DETERMINISTIC", index, fieldName, item, "warning", { value: item.raw }));
        }
        if (item.special === "unknown") {
          issues.push(makeIssue(/^\d+#/.test(item.raw) ? "N_TH_OUT_OF_RANGE" : "SYNTAX_UNEXPECTED_CHAR",
            index, fieldName, item, "error", { value: item.raw }));
        }
        if (item.special === "question") {
          if (!dialect.allows("question")) {
            issues.push(makeIssue("QUESTION_NOT_ALLOWED", index, fieldName, item, "error", { field: fieldName }));
          } else if (DAY_FIELDS.indexOf(spec.key) < 0) {
            issues.push(makeIssue("NOT_ALLOWED_IN_DIALECT", index, fieldName, item, "error", { value: "?" }));
          }
        }
        if (["L", "LW", "Lminus", "W"].indexOf(item.special) >= 0) {
          if (spec.key !== "dom") {
            issues.push(makeIssue("LW_REQUIRES_DOM", index, fieldName, item, "error", { value: item.raw }));
          } else {
            const feature = item.special === "L" || item.special === "Lminus" ? "last"
              : item.special === "LW" ? "lw" : "w";
            if (!dialect.allows(feature)) {
              issues.push(makeIssue("NOT_ALLOWED_IN_DIALECT", index, fieldName, item, "error", { value: item.raw }));
            }
          }
        }
        if (item.special === "Lminus" && (item.offsetValue < 1 || item.offsetValue > 30)) {
          issues.push(makeIssue("L_MINUS_OUT_OF_RANGE", index, fieldName, item, "error", { value: item.offsetValue }));
        }
        if (item.special === "nth") {
          if (spec.key !== "dow") {
            issues.push(makeIssue("HASH_ONLY_DOW", index, fieldName, item, "error", { value: item.raw }));
          } else if (!dialect.allows("nth")) {
            issues.push(makeIssue("NOT_ALLOWED_IN_DIALECT", index, fieldName, item, "error", { value: item.raw }));
          } else if (item.n < 1 || item.n > 5) {
            issues.push(makeIssue("N_TH_OUT_OF_RANGE", index, fieldName, item, "error", { value: item.n }));
          }
        }
        if (item.special === "lastN" && (spec.key !== "dow" || !dialect.allows("last"))) {
          issues.push(makeIssue("NOT_ALLOWED_IN_DIALECT", index, fieldName, item, "error", { value: item.raw }));
        }
        if (item.type === "step" && item.base !== "*" && item.from !== spec.min &&
            !item.error && item.step > (spec.max - spec.min) / 2) {
          issues.push(makeIssue("UNEXPECTED_STEP_BASE", index, fieldName, item, "warning", {
            from: item.from, step: item.step
          }));
        }
      }
      if (spec.key === "dow" && !dialect.allows("names")) {
        for (const item of fieldAst.items || []) {
          if (item.type === "names" || /[A-Za-z]/.test(item.raw || "")) {
            issues.push(makeIssue("NAMES_NOT_SUPPORTED", index, fieldName, item, "error", { value: item.raw }));
          }
        }
      }
    }

    if (hasNames && !dialect.allows("names")) {
      issues.push(makeIssue("NAMES_NOT_SUPPORTED", dialect.fieldIndexOf("month"), "field.month", null, "error", {}));
    }

    const domIndex = dialect.fieldIndexOf("dom");
    const dowIndex = dialect.fieldIndexOf("dow");
    const domAst = ast.fields[domIndex];
    const dowAst = ast.fields[dowIndex];
    const domConcrete = CP.cron.bits.fromField(domAst, fields[domIndex]).concrete;
    const dowConcrete = CP.cron.bits.fromField(dowAst, fields[dowIndex]).concrete;

    if (dialect.dayMatch() === "intersection") {
      if (domConcrete && dowConcrete && !hasQuestion(domAst) && !hasQuestion(dowAst)) {
        issues.push(makeIssue("QUARTZ_BOTH_DAYS_CONCRETE", domIndex, "field.dom", domAst, "error", {},
          "set-day-question"));
        issues.push(makeIssue("QUARTZ_BOTH_DAYS_CONCRETE", dowIndex, "field.dow", dowAst, "error", {},
          "set-week-question"));
      } else if (isWildcard(domAst) && isWildcard(dowAst) && !hasQuestion(domAst) && !hasQuestion(dowAst)) {
        issues.push(makeIssue("QUARTZ_NEEDS_QUESTION", domIndex, "field.dom", domAst, "warning", {}));
      }
    } else if (domConcrete && dowConcrete) {
      issues.push(makeIssue("POSIX_DAY_UNION", domIndex, "field.dom", domAst, "warning", {}));
    }

    if (dowAst) {
      // 星期数字是两套编号唯一会分歧的地方：公共区间内同一数字在本方言与
      // 另一基准下代表不同星期。直接算出两个星期名交给文案，用户一眼看懂差异。
      // 纯 0 / 7（都指周日）与含字母的名称写法不产生歧义，跳过。
      // 不写方言字面量（触发 ⑨ 访问器契约闸门）：方向由 dowRange().min 推出，
      // quartz 基准下另一读法多一天，unix 基准下少一天；0 在 quartz 非法，不告警。
      const shift = dialect.dowRange().min === 1 ? 1 : -1;
      for (const item of numericItems(dowAst)) {
        if (item.type !== "value") continue;
        if (!Number.isFinite(item.value) || item.value < 1) continue;
        const current = CP.cron.dialect.toCanonical(item.value, dialect.dowBase());
        const other = ((current + shift) % 7 + 7) % 7;
        if (current === other) continue;
        issues.push(makeIssue("DOW_BASE_AMBIGUOUS", dowIndex, "field.dow", item, "info", {
          value: item.raw,
          hereIdx: current,
          thereIdx: other,
          here: CP.cron.dialect.dowNames[current],
          there: CP.cron.dialect.dowNames[other]
        }));
        break;
      }
    }

    const monthIndex = dialect.fieldIndexOf("month");
    const monthAst = ast.fields[monthIndex];
    if (domAst && monthAst) {
      const monthBits = CP.cron.bits.fromField(monthAst, fields[monthIndex]);
      const months = CP.cron.bits.toArray(monthBits.bits).filter(function (m) { return m >= 1 && m <= 12; });
      const domValues = CP.cron.bits.toArray(CP.cron.bits.fromField(domAst, fields[domIndex]).bits);
      if (domValues.indexOf(30) >= 0 && months.length === 1 && months[0] === 2) {
        issues.push(makeIssue("FEB_30", monthIndex, "field.month", monthAst, "warning", {}));
      }
      if (domValues.indexOf(31) >= 0 && months.length && months.every(function (m) {
        return [2, 4, 6, 9, 11].indexOf(m) >= 0;
      })) {
        issues.push(makeIssue("MONTH_HAS_NO_31ST", monthIndex, "field.month", monthAst, "warning", {}));
      }
    }

    if (opts.tz && CP.cron.tz && !CP.cron.tz.isZone(opts.tz)) {
      issues.push(makeIssue("BAD_TIMEZONE", -1, "", null, "error", { value: opts.tz }));
    }
    const count = Number(opts.count || 10);
    if (count > 200 || count < 1) {
      issues.push(makeIssue("COUNT_OUT_OF_BOUNDS", -1, "", null, "error", { value: count }));
    }

    const hasError = issues.some(function (item) { return item.severity === "error"; });
    const hasWarning = issues.some(function (item) { return item.severity === "warning"; });
    const status = hasError ? "error" : hasWarning ? "warning" : "valid";
    return {
      status: status,
      issues: issues,
      predictable: !hasError && !hasRandom,
      domConcrete: domConcrete,
      dowConcrete: dowConcrete
    };
  }

  return { validate: validate, makeIssue: makeIssue, hasQuestion: hasQuestion };
})();
