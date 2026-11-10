CP.cron = CP.cron || {};
CP.cron.next = (function () {
  "use strict";

  const MAX_DAYS = 1830;
  const MAX_COUNT = 200;

  function jsDow(year, month, day) {
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  }

  function lastWeekday(year, month, last) {
    const dow = jsDow(year, month, last);
    if (dow === 0) return last - 2;
    if (dow === 6) return last - 1;
    return last;
  }

  function nearestWeekday(year, month, day, last) {
    if (day < 1 || day > last) return null;
    const dow = jsDow(year, month, day);
    if (dow >= 1 && dow <= 5) return day;
    if (dow === 6) return day > 1 ? day - 1 : day + 2;
    return day < last ? day + 1 : day - 2;
  }

  function lastDow(year, month, last, dow) {
    for (let day = last; day >= 1; day -= 1) {
      if (jsDow(year, month, day) === dow) return day;
    }
    return null;
  }

  function nthDow(year, month, last, dow, n) {
    let seen = 0;
    for (let day = 1; day <= last; day += 1) {
      if (jsDow(year, month, day) === dow) {
        seen += 1;
        if (seen === n) return day;
      }
    }
    return null;
  }

  function matchedDays(year, month, bm, dialect, tz) {
    const last = tz.daysInMonth(year, month);
    const domSet = new Set();
    for (let day = 1; day <= last; day += 1) {
      if (CP.cron.bits.has(bm.dom.bits, day)) domSet.add(day);
    }
    for (const item of bm.dom.specials) {
      if (item.special === "L") domSet.add(last);
      else if (item.special === "Lminus") {
        const day = last - item.offsetValue;
        if (day >= 1) domSet.add(day);
      } else if (item.special === "LW") domSet.add(lastWeekday(year, month, last));
      else if (item.special === "W") {
        const day = nearestWeekday(year, month, item.day, last);
        if (day) domSet.add(day);
      }
    }
    const dowSet = new Set();
    for (let day = 1; day <= last; day += 1) {
      if (CP.cron.bits.has(bm.dow.bits, jsDow(year, month, day))) dowSet.add(day);
    }
    for (const item of bm.dow.specials) {
      if (item.special === "lastN") {
        const day = lastDow(year, month, last, item.dow);
        if (day) dowSet.add(day);
      } else if (item.special === "nth") {
        const day = nthDow(year, month, last, item.dow, item.n);
        if (day) dowSet.add(day);
      }
    }
    const all = new Set();
    for (let day = 1; day <= last; day += 1) all.add(day);
    const domUse = bm.dom.concrete ? domSet : null;
    const dowUse = bm.dow.concrete ? dowSet : null;
    if (dialect.dayMatch() === "union") {
      if (domUse && dowUse) {
        const merged = new Set();
        for (const day of domUse) merged.add(day);
        for (const day of dowUse) merged.add(day);
        return merged;
      }
      return domUse || dowUse || all;
    }
    if (domUse && dowUse) {
      const merged = new Set();
      for (const day of domUse) if (dowUse.has(day)) merged.add(day);
      return merged;
    }
    return domUse || dowUse || all;
  }

  function buildBitmaps(ast, dialect) {
    const fields = dialect.getFields();
    const bm = {};
    for (const key of ["sec", "min", "hour", "dom", "month", "dow", "year"]) {
      const index = dialect.fieldIndexOf(key);
      if (index < 0) {
        bm[key] = { bits: CP.cron.bits.make(0, 0), specials: [], concrete: false, wildcard: true };
        CP.cron.bits.fill(bm[key].bits, 0, 0, 1);
        continue;
      }
      bm[key] = CP.cron.bits.fromField(ast.fields[index], fields[index]);
    }
    if (dialect.fieldIndexOf("sec") < 0) {
      bm.sec = { bits: CP.cron.bits.make(0, 0), specials: [], concrete: false, wildcard: true };
      CP.cron.bits.fill(bm.sec.bits, 0, 0, 1);
    }
    return bm;
  }

  function toInstant(value) {
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return Date.now();
  }

  function run(ast, dialect, options, direction) {
    const opts = options || {};
    const tz = CP.cron.tz;
    const zone = opts.tz || "UTC";
    const count = Math.min(MAX_COUNT, Math.max(1, Number(opts.count) || 10));
    const dstMissing = opts.dstMissing === "shift" ? "shift" : "skip";
    const from = toInstant(opts.from);
    const startWall = tz.utcToWall(from, zone);
    const bm = buildBitmaps(ast, dialect);
    if (bm.dom.specials.concat(bm.dow.specials).some(function (item) { return item.special === "randomRange"; })) {
      return { times: [], skipped: [], code: "NOT_PREDICTABLE" };
    }
    const fixed = tz.fixedOffset(zone, from);
    const hours = CP.cron.bits.toArray(bm.hour.bits);
    const minutes = CP.cron.bits.toArray(bm.min.bits);
    const seconds = CP.cron.bits.toArray(bm.sec.bits);
    const times = [];
    const skipped = [];

    function convert(wall) {
      const naive = Date.UTC(wall.y, wall.m - 1, wall.d, wall.h, wall.mi, wall.s);
      if (fixed !== null) {
        return { instant: naive - fixed * 60000, offset: fixed, status: "normal", gapEnd: null };
      }
      return tz.wallToUtc(wall, zone);
    }

    function monthAllowed(year, month) {
      return bm.month.concrete ? CP.cron.bits.has(bm.month.bits, month) : true;
    }

    function yearAllowed(year) {
      return bm.year.concrete ? CP.cron.bits.has(bm.year.bits, year) : true;
    }

    let scanned = 0;
    let exhausted = true;
    for (let offset = 0; offset < MAX_DAYS && times.length < count; offset += 1) {
      const dayDate = new Date(Date.UTC(startWall.y, startWall.m - 1, startWall.d + direction * offset));
      const year = dayDate.getUTCFullYear();
      const month = dayDate.getUTCMonth() + 1;
      const day = dayDate.getUTCDate();
      scanned += 1;
      if (!monthAllowed(year, month) || !yearAllowed(year)) continue;
      const days = matchedDays(year, month, bm, dialect, tz);
      if (!days.has(day)) continue;
      const orderH = direction > 0 ? hours : hours.slice().reverse();
      const orderM = direction > 0 ? minutes : minutes.slice().reverse();
      const orderS = direction > 0 ? seconds : seconds.slice().reverse();
      for (const hour of orderH) {
        for (const minute of orderM) {
          for (const second of orderS) {
            const wall = { y: year, m: month, d: day, h: hour, mi: minute, s: second };
            const wallOrder = tz.compareWall(wall, startWall) * direction;
            if (offset === 0 && wallOrder <= 0) continue;
            const converted = convert(wall);
            let instant = converted.instant;
            if (converted.status === "missing") {
              if (dstMissing === "skip") {
                if (converted.gapEnd > from) {
                  skipped.push({ wall: wall, instant: converted.gapEnd, reason: "missing", zone: zone });
                }
                continue;
              }
              instant = converted.gapEnd;
            }
            if (direction > 0 ? instant <= from : instant >= from) continue;
            const shown = fixed !== null && converted.status !== "missing"
              ? Object.assign({}, wall, { offset: converted.offset, instant: instant, zone: zone })
              : tz.utcToWall(instant, zone);
            times.push({
              instant: instant, wall: shown, offset: converted.offset,
              status: converted.status, zone: zone
            });
            if (times.length >= count) break;
          }
          if (times.length >= count) break;
        }
        if (times.length >= count) break;
      }
      if (times.length >= count) { exhausted = false; break; }
    }
    if (!times.length) {
      return { times: [], skipped: skipped, scannedDays: scanned, code: "NO_OCCURRENCE_WITHIN_LIMIT" };
    }
    if (direction < 0) times.reverse();
    return { times: times, skipped: skipped, scannedDays: scanned, code: null, exhausted: exhausted };
  }

  function next(ast, dialect, options) { return run(ast, dialect, options, 1); }
  function prev(ast, dialect, options) { return run(ast, dialect, options, -1); }

  return {
    next: next, prev: prev, matchedDays: matchedDays, buildBitmaps: buildBitmaps,
    lastWeekday: lastWeekday, nearestWeekday: nearestWeekday,
    lastDow: lastDow, nthDow: nthDow
  };
})();
