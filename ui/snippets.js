CP.snippets = (function () {
  "use strict";

  const PLATFORMS = ["k8s", "xxljob", "crontab"];
  let activeId = null;

  function groupOf(id) {
    return PLATFORMS.indexOf(id) >= 0 ? "platform" : "lang";
  }

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
        id: "robfig", needs: ["special"], dialect: "unix",
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
          return 'from croniter import croniter\nimport zoneinfo\nfrom datetime import datetime\nbase = datetime.now(zoneinfo.ZoneInfo("' + zone + '"))\nitr = croniter("' + value + '", base)\nprint(itr.get_next(datetime))';
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
        group: groupOf(target.id),
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
    const group = state && state.tab === "deploy" ? "platform" : "lang";
    const visible = items.filter(function (item) { return item.group === group; });

    let found = false;
    for (const item of visible) {
      if (item.id === activeId) { found = true; break; }
    }
    if (!found) activeId = visible.length ? visible[0].id : null;

    const buttons = [];
    const host = document.createElement("div");
    host.className = "snippet-code-host";

    function paint() {
      for (const button of buttons) {
        const selected = button.getAttribute("data-snippet") === activeId;
        button.setAttribute("aria-pressed", selected ? "true" : "false");
      }
      host.textContent = "";
      let current = null;
      for (const item of visible) {
        if (item.id === activeId) { current = item; break; }
      }
      if (!current) return;
      if (!current.supported) {
        const warning = document.createElement("p");
        warning.className = "timeline-note";
        warning.textContent = CP.i18n.t("snippets.unsupported") + ": " + current.reason;
        host.appendChild(warning);
        return;
      }
      const pre = document.createElement("pre");
      pre.className = "snippet-code";
      pre.textContent = current.code;
      host.appendChild(pre);
    }

    const box = document.createElement("div");
    box.className = "snippet-tabs";
    for (const item of visible) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chip";
      button.setAttribute("data-snippet", item.id);
      button.setAttribute("data-supported", item.supported ? "yes" : "no");
      button.setAttribute("aria-pressed", "false");
      button.textContent = item.label;
      button.addEventListener("click", function () {
        activeId = item.id;
        paint();
      });
      buttons.push(button);
      box.appendChild(button);
    }
    el.appendChild(box);
    el.appendChild(host);
    paint();
  }

  return { generate: generate, compatibility: compatibility, render: render };
})();
