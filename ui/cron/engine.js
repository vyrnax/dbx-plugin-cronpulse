CP.engine = (function () {
  "use strict";

  function withMessage(issue) {
    const copy = Object.assign({}, issue);
    copy.message = CP.i18n.t(issue.messageKey, issue.params);
    return copy;
  }

  function alternativeFirstTime(ast, dialect, state) {
    const targetName = CP.cron.dialect.list().find(function (name) {
      const candidate = CP.cron.dialect.get(name);
      return candidate && candidate.dowBase() !== dialect.dowBase();
    });
    const target = targetName ? CP.cron.dialect.get(targetName) : null;
    if (!target) return null;
    const converted = CP.cron.convert.convert(ast, dialect, targetName);
    if (!converted.ok) return null;
    const reparsed = CP.cron.parse.parse(converted.expression, target);
    const result = CP.cron.next.next(reparsed, target, {
      tz: state.tz, count: 1, dstMissing: state.dstMissing
    });
    return result.times.length ? result.times[0].instant : null;
  }

  function evaluate(state) {
    const dialect = CP.cron.dialect.get(state.dialect);
    if (!dialect) {
      return {
        status: "error",
        issues: [withMessage({ code: "BAD_DIALECT", messageKey: "msg.BAD_DIALECT", params: {}, severity: "error", fieldIndex: -1 })],
        ast: null, dialect: null, description: null, times: null
      };
    }
    const ast = CP.cron.parse.parse(state.expr, dialect);
    const validation = CP.cron.validate.validate(ast, dialect, {
      tz: state.tz, count: state.count
    });
    const issues = validation.issues.map(withMessage);
    const lang = state.describeLang || CP.i18n.locale();
    let description = null;
    let times = null;

    if (validation.status !== "error" && ast.normalized && !ast.nonTemporal) {
      description = CP.cron.describe.describe(ast, dialect, { lang: lang });
      if (validation.predictable) {
        times = CP.cron.next.next(ast, dialect, {
          tz: state.tz, count: state.count, dstMissing: state.dstMissing
        });
        if (times.code === "NO_OCCURRENCE_WITHIN_LIMIT") {
          issues.push(withMessage({
            code: "NO_OCCURRENCE_WITHIN_LIMIT", messageKey: "msg.NO_OCCURRENCE_WITHIN_LIMIT",
            params: {}, severity: "warning", fieldIndex: -1
          }));
        }
      }
      const ambiguous = issues.find(function (item) { return item.code === "DOW_BASE_AMBIGUOUS"; });
      if (ambiguous && times && times.times.length) {
        ambiguous.alternativeFirst = alternativeFirstTime(ast, dialect, state);
        ambiguous.currentFirst = times.times[0].instant;
      }
    }

    const status = validation.status === "valid" && issues.length ? "warning" : validation.status;
    return {
      status: status, issues: issues, ast: ast, dialect: dialect,
      description: description, times: times, validation: validation, lang: lang
    };
  }

  return { evaluate: evaluate, withMessage: withMessage };
})();
