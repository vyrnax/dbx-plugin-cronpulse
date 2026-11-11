CP.engine = (function () {
  "use strict";

  function localizeWeekday(params) {
    if (!params || params.hereIdx === undefined || params.thereIdx === undefined) return params;
    // 编号对比要用当前语言的工作日名（THU/FRI 在中文语境不可读），validate 只提供索引
    return Object.assign({}, params, {
      here: CP.i18n.t("desc.weekday." + params.hereIdx),
      there: CP.i18n.t("desc.weekday." + params.thereIdx)
    });
  }

  function withMessage(issue) {
    const copy = Object.assign({}, issue);
    copy.params = localizeWeekday(issue.params);
    copy.message = CP.i18n.t(issue.messageKey, copy.params);
    return copy;
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
    }

    const escalated = issues.some(function (item) { return item.severity === "warning"; });
    const status = validation.status === "valid" && escalated ? "warning" : validation.status;
    return {
      status: status, issues: issues, ast: ast, dialect: dialect,
      description: description, times: times, validation: validation, lang: lang
    };
  }

  return { evaluate: evaluate, withMessage: withMessage };
})();
