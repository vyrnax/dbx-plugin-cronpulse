CP.cron = CP.cron || {};
CP.cron.tz = (function () {
  "use strict";

  const cache = new Map();

  function localZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch (_) {
      return "UTC";
    }
  }

  function resolveZone(zone) {
    return !zone || zone === "Local" ? localZone() : zone;
  }

  function isZone(zone) {
    if (!zone || zone === "Local" || zone === "UTC") return true;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
      return true;
    } catch (_) {
      return false;
    }
  }

  function utcFormatter() {
    return {
      formatToParts: function (date) {
        const instant = new Date(date);
        return [
          ["year", instant.getUTCFullYear()], ["month", instant.getUTCMonth() + 1],
          ["day", instant.getUTCDate()], ["hour", instant.getUTCHours()],
          ["minute", instant.getUTCMinutes()], ["second", instant.getUTCSeconds()]
        ].map(function (pair) { return { type: pair[0], value: String(pair[1]) }; });
      }
    };
  }

  function formatter(zone, withName) {
    const key = (withName ? "name:" : "parts:") + resolveZone(zone);
    if (cache.has(key)) return cache.get(key);
    const options = {
      timeZone: resolveZone(zone), hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    };
    if (withName) options.timeZoneName = "short";
    let fmt;
    try {
      fmt = new Intl.DateTimeFormat("en-US", options);
    } catch (_) {
      try {
        const fallback = Object.assign({}, options);
        delete fallback.timeZone;
        fmt = new Intl.DateTimeFormat("en-US", fallback);
      } catch (_) {
        fmt = utcFormatter();
      }
    }
    cache.set(key, fmt);
    return fmt;
  }

  function partsAt(instant, zone) {
    const parts = formatter(zone).formatToParts(new Date(instant));
    const map = Object.create(null);
    for (const part of parts) map[part.type] = part.value;
    return {
      y: Number(map.year), m: Number(map.month), d: Number(map.day),
      h: Number(map.hour) % 24, mi: Number(map.minute), s: Number(map.second)
    };
  }

  function offsetAt(instant, zone) {
    const aligned = Math.floor(instant / 1000) * 1000;
    const wall = partsAt(aligned, zone);
    const asUtc = Date.UTC(wall.y, wall.m - 1, wall.d, wall.h, wall.mi, wall.s);
    return Math.round((asUtc - aligned) / 60000);
  }

  function utcToWall(instant, zone) {
    const aligned = Math.floor(instant / 1000) * 1000;
    const wall = partsAt(aligned, zone);
    wall.offset = offsetAt(aligned, zone);
    wall.instant = aligned;
    wall.zone = resolveZone(zone);
    return wall;
  }

  function compareWall(a, b) {
    return (a.y - b.y) || (a.m - b.m) || (a.d - b.d) ||
      (a.h - b.h) || (a.mi - b.mi) || (a.s - b.s);
  }

  function sameWall(a, b) {
    return a.y === b.y && a.m === b.m && a.d === b.d &&
      a.h === b.h && a.mi === b.mi && a.s === b.s;
  }

  function findGapEnd(wall, zone, naive) {
    let lo = naive - 6 * 3600000;
    let hi = naive + 6 * 3600000;
    while (hi - lo > 60000) {
      const mid = lo + Math.floor((hi - lo) / 2 / 60000) * 60000;
      if (compareWall(partsAt(mid, zone), wall) >= 0) hi = mid;
      else lo = mid + 60000;
    }
    return Math.ceil(hi / 60000) * 60000;
  }

  function wallToUtc(wall, zone) {
    const naive = Date.UTC(wall.y, wall.m - 1, wall.d, wall.h, wall.mi, wall.s || 0);
    const offsets = new Set();
    for (const delta of [-86400000, -7200000, 0, 7200000, 86400000]) {
      offsets.add(offsetAt(naive + delta, zone));
    }
    const candidates = [];
    for (const off of offsets) {
      const instant = naive - off * 60000;
      if (sameWall(partsAt(instant, zone), wall)) candidates.push({ instant: instant, offset: off });
    }
    if (candidates.length) {
      candidates.sort(function (a, b) { return a.instant - b.instant; });
      return {
        instant: candidates[0].instant,
        offset: candidates[0].offset,
        status: candidates.length > 1 ? "ambiguous" : "normal",
        candidates: candidates
      };
    }
    const gapEnd = findGapEnd(wall, zone, naive);
    return {
      instant: gapEnd,
      offset: offsetAt(gapEnd, zone),
      status: "missing",
      gapEnd: gapEnd,
      candidates: []
    };
  }

  function abbreviation(instant, zone) {
    const parts = formatter(zone, true).formatToParts(new Date(instant));
    for (const part of parts) {
      if (part.type === "timeZoneName") return part.value;
    }
    return "";
  }

  function formatOffset(minutes) {
    const sign = minutes < 0 ? "-" : "+";
    const abs = Math.abs(minutes);
    return "UTC" + sign + String(Math.floor(abs / 60)).padStart(2, "0") + ":" + String(abs % 60).padStart(2, "0");
  }

  function fixedOffset(zone, around) {
    const base = around || Date.now();
    const offsets = [0, -1, 1, -90, 90, -180, 180].map(function (days) {
      return offsetAt(base + days * 86400000, zone);
    });
    return offsets.every(function (value) { return value === offsets[0]; }) ? offsets[0] : null;
  }

  function dayOfWeek(wall) {
    return new Date(Date.UTC(wall.y, wall.m - 1, wall.d)).getUTCDay();
  }

  function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  return {
    localZone: localZone, resolveZone: resolveZone, isZone: isZone,
    partsAt: partsAt, offsetAt: offsetAt, utcToWall: utcToWall,
    wallToUtc: wallToUtc, abbreviation: abbreviation, formatOffset: formatOffset,
    fixedOffset: fixedOffset, dayOfWeek: dayOfWeek, daysInMonth: daysInMonth,
    compareWall: compareWall
  };
})();
