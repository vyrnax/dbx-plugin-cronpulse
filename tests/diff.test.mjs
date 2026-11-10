import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { CronExpressionParser } from 'cron-parser';
import { Cron } from 'croner';
import { loadCP } from './_loader.mjs';

const require = createRequire(import.meta.url);
const cronstrue = require('cronstrue');
require('cronstrue/locales/zh_CN');
const CP = loadCP();
const D = CP.cron.dialect;
const FROM = new Date('2026-01-01T00:00:00.000Z');

function own(expr, dialectName, count, options) {
  const dialect = D.get(dialectName);
  const ast = CP.cron.parse.parse(expr, dialect);
  return CP.cron.next.next(ast, dialect, Object.assign({
    tz: 'UTC', count: count, from: FROM.getTime(), dstMissing: 'skip'
  }, options || {})).times.map((item) => new Date(item.instant).toISOString());
}

function parserTimes(expr, count, timezone) {
  const iterator = CronExpressionParser.parse(expr, {
    currentDate: FROM, tz: timezone || 'UTC'
  });
  const result = [];
  for (let index = 0; index < count; index += 1) {
    result.push(iterator.next().toDate().toISOString());
  }
  return result;
}

function cronerTimes(expr, count, timezone, fromDate) {
  const job = new Cron(expr, { timezone: timezone || 'UTC', paused: true });
  return job.nextRuns(count, fromDate || FROM).map((date) => date.toISOString());
}

test('一致域：自研结果逐条等于两个通用调度库', () => {
  const cases = [
    { expr: '*/15 * * * *', dialect: 'unix', count: 5 },
    { expr: '0 12 * * *', dialect: 'unix', count: 4 },
    { expr: '0 12 1 * *', dialect: 'unix', count: 3 },
    { expr: '0 0 12 * * *', dialect: 'spring', count: 4 },
    { expr: '0 15 10 * * *', dialect: 'spring', count: 4 },
    { expr: '0 */5 14 * * *', dialect: 'spring', count: 5 },
    { expr: '0 0 12 1,15 * *', dialect: 'spring', count: 4 }
  ];
  for (const item of cases) {
    const ownTimes = own(item.expr, item.dialect, item.count);
    const fromParser = parserTimes(item.expr, item.count);
    const fromCroner = cronerTimes(item.expr, item.count);
    assert.equal(ownTimes.length, item.count, item.expr);
    assert.deepEqual(ownTimes, fromParser, `${item.expr} 与通用解析库不一致`);
    assert.deepEqual(ownTimes, fromCroner, `${item.expr} 与通用调度库不一致`);
  }
});

test('分歧点 L-3：通用解析库不支持该语法，自研按 Quartz 规范给出倒数第 3 天', () => {
  const expr = '0 0 12 L-3 * *';
  assert.throws(() => parserTimes(expr, 1), /.*/);
  assert.equal(own(expr, 'spring', 2)[0], '2026-01-28T12:00:00.000Z');
  assert.equal(own(expr, 'spring', 2)[1], '2026-02-25T12:00:00.000Z');
});

test('分歧点 LW 与 W：通用解析库报非法字符，自研与通用调度库一致', () => {
  const lw = '0 0 12 LW * *';
  assert.throws(() => parserTimes(lw, 1), /.*/);
  assert.equal(own(lw, 'spring', 1)[0], cronerTimes(lw, 1)[0]);
  const w = '0 0 12 15W * *';
  assert.throws(() => parserTimes(w, 1), /.*/);
  assert.equal(own(w, 'spring', 2)[0], cronerTimes(w, 1)[0]);
});

test('分歧点 0/5：通用调度库不接受步长前缀，自研与通用解析库一致', () => {
  const expr = '0 0/5 14 * * *';
  assert.throws(() => cronerTimes(expr, 1), /.*/);
  assert.deepEqual(own(expr, 'spring', 3), parserTimes(expr, 3));
});

test('分歧点 7 位年份：通用解析库拒绝 7 位，自研与通用调度库一致', () => {
  const expr = '0 0 12 * * ? 2026';
  assert.throws(() => parserTimes(expr, 1), /.*/);
  assert.deepEqual(own(expr, 'quartz', 3), cronerTimes(expr, 3));
});

test('分歧点 DST 缺失时刻：自研 skip 与 shift 两种策略各有对应语义', () => {
  const expr = '30 2 * * *';
  const march = new Date('2026-03-01T00:00:00.000Z');
  const fromMarch = { tz: 'America/New_York', from: march.getTime() };
  const skipped = own(expr, 'unix', 12, Object.assign({}, fromMarch, { dstMissing: 'skip' }));
  assert.equal(skipped.some((value) => value.startsWith('2026-03-08')), false);
  const shifted = own(expr, 'unix', 12, Object.assign({}, fromMarch, { dstMissing: 'shift' }));
  assert.ok(shifted.includes('2026-03-08T07:00:00.000Z'));
  const fromCroner = cronerTimes(expr, 12, 'America/New_York', march);
  assert.ok(fromCroner.some((value) => value.startsWith('2026-03-08')), '通用调度库把缺失时刻夹到间隙末端');
});

test('cronstrue 中文语义要素与星期基准差异', () => {
  const every15 = cronstrue.toString('*/15 * * * *', { locale: 'zh_CN' });
  assert.ok(every15.includes('15'));
  const ownText = CP.cron.describe.describe(
    CP.cron.parse.parse('*/15 * * * *', D.get('unix')), D.get('unix'), { lang: 'zh-CN' }
  ).full;
  assert.ok(ownText.includes('15'));

  const quartzExpr = '0 15 10 ? * 6L';
  const defaultText = cronstrue.toString(quartzExpr);
  const quartzText = cronstrue.toString(quartzExpr, { dayOfWeekStartIndexZero: false });
  assert.ok(/Saturday/i.test(defaultText), '默认按 0=Sunday 基准会误读 Quartz 的 6L');
  assert.ok(/Friday/i.test(quartzText), '显式切换基准后才得到规范语义');
  const ownQuartz = CP.cron.describe.describe(
    CP.cron.parse.parse(quartzExpr, D.get('quartz')), D.get('quartz'), { lang: 'en' }
  ).full;
  assert.ok(ownQuartz.includes('last Friday'), '自研固定按 Quartz 规范解释 6L');
  assert.ok(!ownQuartz.includes('last Saturday'));
});

test('逻辑与关系差异：dom/dow 默认 OR 与显式 AND', () => {
  const expr = '0 0 12 1 * 5';
  const orText = cronstrue.toString(expr);
  const andText = cronstrue.toString(expr, { logicalAndDayFields: true });
  assert.notEqual(orText, andText);
  assert.ok(orText.includes('and on Friday'), '默认把两个日期字段并列，即并集语义');
  assert.ok(andText.includes('only on Friday'), '显式 logicalAndDayFields 才是交集语义');
  const union = describe(expr, 'unix');
  const intersection = describe(expr, 'quartz');
  assert.ok(union.includes('either') || union.includes('任一'));
  assert.ok(intersection.includes('both') || intersection.includes('同时'));

  function describe(text, dialectName) {
    const dialect = D.get(dialectName);
    return CP.cron.describe.describe(CP.cron.parse.parse(text, dialect), dialect, { lang: 'en' }).dayRelation;
  }
});
