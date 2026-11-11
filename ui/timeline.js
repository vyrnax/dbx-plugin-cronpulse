CP.timeline = (function () {
  "use strict";

  function pad(value) { return String(value).padStart(2, "0"); }

  function formatWall(wall) {
    if (!wall) return "";
    return wall.y + "-" + pad(wall.m) + "-" + pad(wall.d) + " " +
      pad(wall.h) + ":" + pad(wall.mi) + ":" + pad(wall.s);
  }

  function addRow(list, className, parts) {
    const row = document.createElement("li");
    row.className = className;
    for (const part of parts) {
      if (!part) continue;
      const span = document.createElement("span");
      span.className = part.className || "timeline-note";
      span.textContent = part.text;
      row.appendChild(span);
    }
    list.appendChild(row);
  }

  function render(result, state) {
    const list = CP.app.$("timeline-list");
    if (!list) return;
    const view = CP.app.$("view-timeline");
    if (view && view.dataset && !view.dataset.windowControls) {
      view.dataset.windowControls = "1";
      const box = document.createElement("div");
      box.className = "badges";
      for (const key of Object.keys(WINDOWS)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "chip";
        button.textContent = key;
        button.addEventListener("click", function () {
          state.timelineWindow = key;
          CP.app.recompute();
        });
        box.appendChild(button);
      }
      const toolbar = view.querySelector ? view.querySelector(".timeline-toolbar") : null;
      if (toolbar && typeof toolbar.appendChild === "function") toolbar.appendChild(box);
      else if (view.insertBefore) view.insertBefore(box, view.firstChild);
    }
    list.textContent = "";
    if (!result || !result.times || !result.times.times.length) {
      const key = result && (result.status === "error" || result.status === "empty")
        ? "timeline.empty" : "status.notPredictable";
      addRow(list, "timeline-row", [{ text: CP.i18n.t(key), className: "timeline-note" }]);
      return;
    }
    const rows = [];
    for (const item of result.times.times) {
      rows.push({ instant: item.instant, kind: "hit", item: item });
    }
    for (const item of result.times.skipped) {
      rows.push({ instant: item.instant, kind: "skipped", item: item });
    }
    rows.sort(function (a, b) { return a.instant - b.instant; });

    for (const row of rows) {
      if (row.kind === "skipped") {
        addRow(list, "timeline-row timeline-skipped", [
          { text: formatWall(row.item.wall), className: "timeline-wall" },
          { text: CP.i18n.t("timeline.skipped"), className: "timeline-note" }
        ]);
        continue;
      }
      const item = row.item;
      const parts = [{ text: formatWall(item.wall), className: "timeline-wall" }];
      if (item.status === "ambiguous") {
        parts.push({ text: CP.i18n.t("timeline.repeated"), className: "timeline-note" });
      }
      addRow(list, "timeline-row", parts);
    }
  }

  const WINDOWS = { "24h": 86400000, "7d": 604800000, "30d": 2592000000 };
  const COLOR_FALLBACK = {
    "--color-background": "#ffffff", "--color-foreground": "#1f2937",
    "--color-primary": "#2563eb", "--color-border": "#d1d5db",
    "--color-muted-foreground": "#6b7280"
  };

  function tokenColor(name) {
    const computed = typeof getComputedStyle === "function"
      ? getComputedStyle(document.documentElement) : null;
    const value = computed && computed.getPropertyValue
      ? String(computed.getPropertyValue(name) || "").trim() : "";
    return value || COLOR_FALLBACK[name] || "#888888";
  }

  function drawCanvas(result, state) {
    const canvas = CP.app.$("timeline-canvas");
    if (!canvas || !canvas.getContext) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const width = canvas.clientWidth || 600;
    const height = canvas.clientHeight || 120;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    if (context.setTransform) context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = tokenColor("--color-background");
    context.fillRect(0, 0, width, height);
    const border = tokenColor("--color-border");
    const primary = tokenColor("--color-primary");
    const muted = tokenColor("--color-muted-foreground");
    context.strokeStyle = border;
    context.lineWidth = 1;
    for (let tick = 0; tick <= 6; tick += 1) {
      const x = 8 + tick * (width - 16) / 6;
      context.beginPath();
      context.moveTo(x, 10);
      context.lineTo(x, height - 20);
      context.stroke();
    }
    const times = result && result.times ? result.times.times : [];
    const skipped = result && result.times ? result.times.skipped : [];
    if (!times.length) {
      context.fillStyle = muted;
      context.textAlign = "center";
      context.fillText(CP.i18n.t("timeline.empty"), width / 2, height / 2);
      return;
    }
    const span = WINDOWS[(state && state.timelineWindow) || "7d"] || WINDOWS["7d"];
    const start = times[0].instant;
    const end = start + span;
    const toX = function (instant) {
      return 8 + (instant - start) / (end - start) * (width - 16);
    };
    context.strokeStyle = primary;
    context.lineWidth = 2;
    for (const item of times) {
      if (item.instant > end) break;
      const x = toX(item.instant);
      context.beginPath();
      context.moveTo(x, 12);
      context.lineTo(x, height - 22);
      context.stroke();
    }
    context.fillStyle = muted;
    for (const item of skipped) {
      if (item.instant > end) continue;
      context.beginPath();
      context.arc(toX(item.instant), height - 14, 3, 0, Math.PI * 2);
      context.fill();
    }
    context.font = "11px sans-serif";
    context.fillText(formatWall(times[0].wall), 8, height - 4);
    context.textAlign = "right";
    context.fillText(String((state && state.timelineWindow) || "7d"), width - 8, height - 4);
  }

  return { render: render, drawCanvas: drawCanvas, formatWall: formatWall };
})();
