CP.snippets = (function () {
  "use strict";

  function converted(expr, dialect, targetName) {
    const ast = CP.cron.parse.parse(expr, dialect);
    return CP.cron.convert.convert(ast, dialect, targetName);
  }

  function sourceFor(expr, dialect, targetName) {
    const result = converted(expr, dialect, targetName);
    return result.ok ? result.expression : null;
  }

  function requires(expr, dialect, targetName, banned) {
    const ast = CP.cron.parse.parse(expr, dialect);
    let special = null;
    let named = null;
    let random = null;
    for (const field of ast.fields || []) {
      for (const item of field.items || []) {
        if (item.type === "special" && item.special !== "question") {
          if (!special) special = item.raw;
          if (item.special === "randomRange") random = item.raw;
        }
        if (item.type === "names" || item.name || /[A-Za-z]{3}/.test(item.raw || "")) {
          named = item.raw;
        }
      }
    }
    if (banned.indexOf("special") >= 0 && special) return { ok: false, reason: special };
    if (banned.indexOf("names") >= 0 && named) return { ok: false, reason: named };
    if (banned.indexOf("random") >= 0 && random) return { ok: false, reason: random };
    const output = sourceFor(expr, dialect, targetName);
    return output ? { ok: true, expr: output } : { ok: false, reason: "UNSUPPORTED_IN_TARGET" };
  }

  function generate(expr, dialect, state) {
    const zone = state && state.tz ? state.tz : "UTC";
    const targets = [
      {
        id: "spring", needs: [], dialect: "spring",
        code: function (value) {
          return '@Scheduled(cron = "' + value + '", zone = "' + zone + '")\npublic void scheduledTask() {\n    // ...\n}';
        }
      },
      {
        id: "quartz", needs: [], dialect: "quartz",
        code: function (value) {
          return 'CronScheduleBuilder.cronSchedule("' + value + '")\n    .inTimeZone(TimeZone.getTimeZone("' + zone + '"));';
        }
      },
      {
        id: "robfig", needs: ["special", "names", "lastN", "nth", "W", "Lminus"], dialect: "unix",
        code: function (value) {
          return 'c := cron.New(cron.WithParser(\n    cron.NewParser(cron.SecondOptional | cron.Descriptor),\n))\n// CRON_TZ=' + zone + ' ' + value + '\nc.AddFunc("' + value + '", func() { /* ... */ })';
        }
      },
      {
        id: "apscheduler", needs: ["special", "lastN", "nth", "W", "Lminus"], dialect: "unix",
        code: function (value) {
          return 'CronTrigger.from_crontab("' + value + '", timezone="' + zone + '")';
        }
      },
      {
        id: "croniter", needs: ["special", "lastN", "nth", "W", "Lminus"], dialect: "unix",
        code: function (value) {
          return 'from croniter import croniter\nimport zoneinfo\nbase = datetime.now(zoneinfo.ZoneInfo("' + zone + '"))\nitr = croniter("' + value + '", base)';
        }
      },
      {
        id: "node", needs: ["special", "lastN", "nth", "W", "Lminus"], dialect: "unix",
        code: function (value) {
          return '// 纯 5 位语法可用下列任一生态\ncron.schedule("' + value + '", () => { /* ... */ });\nconst job = new Cron("' + value + '", { timezone: "' + zone + '" });\nconst interval = CronExpressionParser.parse("' + value + '", { tz: "' + zone + '" });';
        }
      },
      {
        id: "k8s", needs: ["special", "lastN", "nth", "W", "Lminus"], dialect: "unix",
        code: function (value) {
          return 'apiVersion: batch/v1\nkind: CronJob\nmetadata:\n  name: scheduled-job\nspec:\n  schedule: "' + value + '"\n  timeZone: "' + zone + '"\n  jobTemplate:\n    spec:\n      template:\n        spec:\n          restartPolicy: OnFailure\n          containers:\n            - name: job\n              image: example:latest';
        }
      },
      {
        id: "xxljob", needs: ["random"], dialect: "quartz",
        code: function (value) {
          return '// 控制台「CRON」输入框填：\n' + value;
        }
      },
      {
        id: "crontab", needs: ["special", "lastN", "nth", "W", "Lminus"], dialect: "unix",
        code: function (value) {
          return 'CRON_TZ=' + zone + '\n' + value + ' /usr/local/bin/task.sh';
        }
      }
    ];
    return targets.map(function (target) {
      const check = requires(expr, dialect, target.dialect, target.needs);
      return {
        id: target.id,
        label: CP.i18n.t("snippets." + target.id),
        supported: check.ok,
        reason: check.ok ? null : check.reason,
        code: check.ok ? target.code(check.expr) : null,
        expr: check.ok ? check.expr : null
      };
    });
  }

  function compatibility(expr, dialect) {
    return generate(expr, dialect, { tz: "UTC" }).map(function (item) {
      return { id: item.id, label: item.label, supported: item.supported, reason: item.reason };
    });
  }

  function render(el, result, state) {
    if (!el) return;
    el.textContent = "";
    if (!result || !result.ast || !result.ast.normalized || result.status === "error") {
      const empty = document.createElement("p");
      empty.className = "timeline-note";
      empty.textContent = CP.i18n.t("status.empty");
      el.appendChild(empty);
      return;
    }
    const items = generate(result.ast.raw, result.dialect, state);
    const title = document.createElement("h3");
    title.textContent = CP.i18n.t("snippets.title");
    el.appendChild(title);

    const matrix = document.createElement("div");
    matrix.className = "badges";
    for (const item of items) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.setAttribute("data-supported", item.supported ? "yes" : "no");
      badge.textContent = item.label + ": " + (item.supported
        ? CP.i18n.t("snippets.supported")
        : CP.i18n.t("snippets.unsupported"));
      matrix.appendChild(badge);
    }
    el.appendChild(matrix);

    for (const item of items) {
      const block = document.createElement("div");
      block.className = "timeline-row";
      const heading = document.createElement("strong");
      heading.textContent = item.label;
      block.appendChild(heading);
      if (!item.supported) {
        const warning = document.createElement("p");
        warning.className = "timeline-note";
        warning.textContent = CP.i18n.t("snippets.unsupported") + ": " + item.reason;
        block.appendChild(warning);
      } else {
        const pre = document.createElement("pre");
        pre.className = "compare-value";
        pre.textContent = item.code;
        block.appendChild(pre);
      }
      el.appendChild(block);
    }
  }

  return { generate: generate, compatibility: compatibility, render: render };
})();
