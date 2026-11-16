import test from 'node:test';
import assert from 'node:assert';
import { loadCP } from './_loader.mjs';

const CP = loadCP();
const D = CP.cron.dialect;
const TZ = CP.cron.tz;

function upcoming(expr, dialectName, options) {
  const dialect = D.get(dialectName);
  const ast = CP.cron.parse.parse(expr, dialect);
  return CP.cron.next.next(ast, dialect, Object.assign({
    tz: 'UTC', count: 10, from: Date.parse('2026-01-01T00:00:00Z'), dstMissing: 'skip'
  }, options || {}));
}

function iso(result) {
  return result.times.map((item) => new Date(item.instant).toISOString());
}

test('Intl 时区基础能力与非法时区', () => {
  assert.equal(TZ.isZone('UTC'), true);
  assert.equal(TZ.isZone('Asia/Shanghai'), true);
  assert.equal(TZ.isZone('America/New_York'), true);
  assert.equal(TZ.isZone('Not/AZone'), false);
  assert.ok(TZ.localZone().length > 0);
  assert.equal(TZ.offsetAt(Date.parse('2026-01-15T12:00:00Z'), 'UTC'), 0);
  assert.equal(TZ.offsetAt(Date.parse('2026-01-15T12:00:00Z'), 'Asia/Shanghai'), 480);
  assert.equal(TZ.offsetAt(Date.parse('2026-01-15T12:00:00Z'), 'America/New_York'), -300);
  assert.equal(TZ.offsetAt(Date.parse('2026-07-15T12:00:00Z'), 'America/New_York'), -240);
  assert.equal(TZ.daysInMonth(2028, 2), 29);
  assert.equal(TZ.daysInMonth(2026, 2), 28);
  const wall = TZ.utcToWall(Date.parse('2026-01-15T12:00:00Z'), 'Asia/Shanghai');
  assert.equal(wall.h, 20);
  const back = TZ.wallToUtc({ y: 2026, m: 1, d: 15, h: 20, mi: 0, s: 0 }, 'Asia/Shanghai');
  assert.equal(new Date(back.instant).toISOString(), '2026-01-15T12:00:00.000Z');
  assert.equal(back.status, 'normal');
  assert.ok(TZ.formatOffset(-300).startsWith('UTC-'));
});

test('基础预测：连续日、步长与 POSIX 并集', () => {
  assert.deepEqual(iso(upcoming('0 0 12 * * ?', 'quartz', { count: 3 })), [
    '2026-01-01T12:00:00.000Z', '2026-01-02T12:00:00.000Z', '2026-01-03T12:00:00.000Z'
  ]);
  const every15 = upcoming('*/15 * * * *', 'unix', { count: 4 });
  assert.deepEqual(every15.times.map((item) => item.wall.mi), [15, 30, 45, 0]);
  const from5 = upcoming('5/15 * * * *', 'unix', { count: 4 });
  assert.deepEqual(from5.times.map((item) => item.wall.mi), [5, 20, 35, 50]);
  const rangeStep = upcoming('0 2-5/2 * * *', 'unix', { count: 4 });
  assert.deepEqual(rangeStep.times.map((item) => item.wall.h), [2, 4, 2, 4]);
  const union = upcoming('0 12 1 * 5', 'unix', { count: 4 });
  assert.deepEqual(union.times.map((item) => item.wall.d), [1, 2, 9, 16]);
  const intersection = upcoming('0 0 12 1 * ?', 'quartz', { count: 3 });
  assert.deepEqual(intersection.times.map((item) => item.wall.d), [1, 1, 1]);
});

test('月末特殊语法：L / L-3 / LW / W / dL / nth', () => {
  const last = upcoming('0 0 12 L * ?', 'quartz', { count: 2 });
  assert.deepEqual(last.times.map((item) => item.wall.d), [31, 28]);
  const minus = upcoming('0 0 12 L-3 * ?', 'quartz', {
    count: 2, from: Date.parse('2026-02-01T00:00:00Z')
  });
  assert.deepEqual(minus.times.map((item) => item.wall.d), [25, 28]);
  const lastWeekday = upcoming('0 0 12 LW * ?', 'quartz', { count: 1 });
  assert.equal(lastWeekday.times[0].wall.d, 30);
  const lastFriday = upcoming('0 0 12 ? * 6L', 'quartz', { count: 3 });
  assert.deepEqual(lastFriday.times.map((item) => item.wall.d), [30, 27, 27]);
  const thirdFriday = upcoming('0 0 12 ? * 6#3', 'quartz', { count: 2 });
  assert.deepEqual(thirdFriday.times.map((item) => item.wall.d), [16, 20]);
  const springLastFriday = upcoming('0 0 12 ? * 5L', 'spring', { count: 1 });
  assert.equal(springLastFriday.times[0].wall.d, 30);
});

test('W 的周六与周日边界不跨月', () => {
  let firstSaturday = null;
  let lastSaturday = null;
  for (let month = 1; month <= 12; month += 1) {
    const firstDow = new Date(Date.UTC(2026, month - 1, 1)).getUTCDay();
    const last = TZ.daysInMonth(2026, month);
    const lastDow = new Date(Date.UTC(2026, month - 1, last)).getUTCDay();
    if (firstDow === 6 && firstSaturday === null) firstSaturday = month;
    if (last === 31 && lastDow === 6 && lastSaturday === null) lastSaturday = month;
  }
  assert.ok(firstSaturday, '2026 年应存在 1 号为周六的月份');
  assert.ok(lastSaturday, '2026 年应存在 31 号为周六的月份');
  const fromFirst = Date.UTC(2026, firstSaturday - 1, 1);
  const first = upcoming('0 0 12 1W * ?', 'quartz', { count: 1, from: fromFirst });
  assert.equal(first.times[0].wall.m, firstSaturday);
  assert.equal(first.times[0].wall.d, 3);
  assert.equal(new Date(Date.UTC(first.times[0].wall.y, first.times[0].wall.m - 1, first.times[0].wall.d)).getUTCDay(), 1);
  const fromLast = Date.UTC(2026, lastSaturday - 1, 1);
  const last = upcoming('0 0 12 31W * ?', 'quartz', { count: 1, from: fromLast });
  assert.equal(last.times[0].wall.m, lastSaturday);
  assert.equal(last.times[0].wall.d, 30);
});

test('闰年、永不触发与 n 超出该月个数', () => {
  const leap = upcoming('0 0 0 29 2 ?', 'quartz', {
    count: 2, from: Date.parse('2027-01-01T00:00:00Z')
  });
  assert.equal(new Date(leap.times[0].instant).toISOString(), '2028-02-29T00:00:00.000Z');
  const nextLeap = upcoming('0 0 0 29 2 ?', 'quartz', {
    count: 1, from: Date.parse('2031-01-01T00:00:00Z')
  });
  assert.equal(new Date(nextLeap.times[0].instant).toISOString(), '2032-02-29T00:00:00.000Z');
  const never = upcoming('0 0 0 30 2 ?', 'quartz', { count: 3 });
  assert.equal(never.code, 'NO_OCCURRENCE_WITHIN_LIMIT');
  assert.equal(never.times.length, 0);
  let shortMonth = null;
  for (let month = 1; month <= 12; month += 1) {
    if (CP.cron.next.nthDow(2026, month, TZ.daysInMonth(2026, month), 5, 5) === null) {
      shortMonth = month;
      break;
    }
  }
  assert.ok(shortMonth);
  const noFifth = upcoming('0 0 12 ? * 6#5', 'quartz', {
    count: 5, from: Date.UTC(2026, shortMonth - 1, 1) - 86400000
  });
  assert.equal(noFifth.times.some((item) => item.wall.m === shortMonth), false);
});

test('DST 春季缺失：skip 跳过该日、shift 夹到 03:00 EDT', () => {
  const options = {
    tz: 'America/New_York', count: 12,
    from: Date.parse('2026-03-01T00:00:00Z')
  };
  const skip = upcoming('30 2 * * *', 'unix', Object.assign({}, options, { dstMissing: 'skip' }));
  assert.equal(skip.times.some((item) => item.wall.m === 3 && item.wall.d === 8), false);
  assert.ok(skip.skipped.some((item) => item.wall.m === 3 && item.wall.d === 8 && item.wall.h === 2));
  const shift = upcoming('30 2 * * *', 'unix', Object.assign({}, options, { dstMissing: 'shift' }));
  const hit = shift.times.find((item) => item.wall.m === 3 && item.wall.d === 8);
  assert.ok(hit);
  assert.equal(hit.wall.h, 3);
  assert.equal(hit.wall.mi, 0);
  assert.equal(new Date(hit.instant).toISOString(), '2026-03-08T07:00:00.000Z');
});

test('DST 秋季重复时刻取较早 UTC 实例', () => {
  const result = upcoming('30 1 * * *', 'unix', {
    tz: 'America/New_York', count: 12,
    from: Date.parse('2026-10-25T00:00:00Z')
  });
  const repeated = result.times.find((item) => item.wall.m === 11 && item.wall.d === 1);
  assert.ok(repeated);
  assert.equal(repeated.status, 'ambiguous');
  assert.equal(new Date(repeated.instant).toISOString(), '2026-11-01T05:30:00.000Z');
  const shanghai = upcoming('30 2 * * *', 'unix', {
    tz: 'Asia/Shanghai', count: 2, from: Date.parse('2026-03-07T00:00:00Z')
  });
  assert.equal(shanghai.times.length, 2);
  assert.equal(shanghai.skipped.length, 0);
  const sydney = upcoming('30 2 * * *', 'unix', {
    tz: 'Australia/Sydney', count: 5, from: Date.parse('2026-10-01T00:00:00Z')
  });
  assert.ok(sydney.times.length > 0);
});

test('prev 方向与年份字段', () => {
  const dialect = D.get('quartz');
  const ast = CP.cron.parse.parse('0 0 12 * * ?', dialect);
  const previous = CP.cron.next.prev(ast, dialect, {
    tz: 'UTC', count: 3, from: Date.parse('2026-01-05T00:00:00Z')
  });
  assert.deepEqual(iso(previous), [
    '2026-01-02T12:00:00.000Z', '2026-01-03T12:00:00.000Z', '2026-01-04T12:00:00.000Z'
  ]);
  const yearAst = CP.cron.parse.parse('0 0 12 * * ? 2026', dialect);
  const validation = CP.cron.validate.validate(yearAst, dialect, { tz: 'UTC' });
  assert.equal(validation.status, 'valid');
  const yearTimes = CP.cron.next.next(yearAst, dialect, {
    tz: 'UTC', count: 400, from: Date.parse('2026-12-30T00:00:00Z')
  });
  assert.ok(yearTimes.times.length > 0);
  assert.equal(yearTimes.times.every((item) => item.wall.y === 2026), true);
});

test('性能：10 次 count=50 查询不逐秒暴力枚举', () => {
  // 墙钟计时在多文件并行跑测下会被调度噪声抬高（实测偶发 180ms+），
  // 取 3 轮最快值：真暴力枚举会慢到秒级，最快轮同样超标，抓回归能力不变。
  let elapsed = Infinity;
  for (let round = 0; round < 3; round += 1) {
    const started = performance.now();
    for (let index = 0; index < 10; index += 1) {
      const result = upcoming('0 0 12 * * ?', 'quartz', { count: 50 });
      assert.equal(result.times.length, 50);
    }
    elapsed = Math.min(elapsed, performance.now() - started);
  }
  assert.ok(elapsed < 80, `10 次查询最快一轮耗时 ${elapsed.toFixed(1)}ms，应 < 80ms`);
});
