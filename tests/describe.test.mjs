import test from 'node:test';
import assert from 'node:assert';
import { loadCP } from './_loader.mjs';

const CP = loadCP();
const D = CP.cron.dialect;

function described(expr, dialectName, lang) {
  const dialect = D.get(dialectName);
  const ast = CP.cron.parse.parse(expr, dialect);
  return CP.cron.describe.describe(ast, dialect, { lang: lang });
}

test('8 个关键构造的中文文案', () => {
  assert.ok(described('0 0 12 L-3 * ?', 'quartz', 'zh-CN').full.includes('本月倒数第 3 天'));
  assert.ok(described('0 0 12 LW * ?', 'quartz', 'zh-CN').full.includes('本月最后一个工作日'));
  assert.ok(described('0 0 12 15W * ?', 'quartz', 'zh-CN').full.includes('距 15 号最近的工作日'));
  assert.ok(described('0 0 12 ? * 6L', 'quartz', 'zh-CN').full.includes('本月最后一个星期五'));
  assert.ok(described('0 0 12 ? * 5L', 'spring', 'zh-CN').full.includes('本月最后一个星期五'));
  assert.ok(described('0 0 12 ? * 6#3', 'quartz', 'zh-CN').full.includes('本月第 3 个星期五'));
  assert.ok(described('0 0 12 ? * 6L', 'quartz', 'zh-CN').fieldLines.dom.includes('不指定'));
  assert.ok(described('0 0 12 5/15 * ?', 'quartz', 'zh-CN').full.includes('从 5 开始每 15'));
  assert.ok(described('0 0 2-5/2 * * ?', 'quartz', 'zh-CN').full.includes('2 到 5 之间每隔 2'));
});

test('8 个关键构造的英文文案与序数', () => {
  assert.ok(described('0 0 12 L-3 * ?', 'quartz', 'en').full.includes('the 3rd-to-last day of the month'));
  assert.ok(described('0 0 12 LW * ?', 'quartz', 'en').full.includes('the last weekday of the month'));
  assert.ok(described('0 0 12 15W * ?', 'quartz', 'en').full.includes('the nearest weekday to the 15th'));
  assert.ok(described('0 0 12 ? * 6L', 'quartz', 'en').full.includes('the last Friday of the month'));
  assert.ok(described('0 0 12 ? * 5L', 'spring', 'en').full.includes('the last Friday of the month'));
  assert.ok(described('0 0 12 ? * 6#3', 'quartz', 'en').full.includes('the 3rd Friday of the month'));
  assert.ok(described('0 0 12 ? * 6L', 'quartz', 'en').fieldLines.dom.includes('no specific value'));
  assert.ok(described('0 0 12 5/15 * ?', 'quartz', 'en').full.includes('starting at 5, every 15'));
  assert.ok(described('0 0 2-5/2 * * ?', 'quartz', 'en').full.includes('every 2 between 2 and 5'));
  assert.ok(described('0 0 12 1W * ?', 'quartz', 'en').full.includes('the nearest weekday to the 1st'));
});

test('日与周组合语义被显式说明', () => {
  assert.equal(described('0 0 12 1 * 5', 'unix', 'en').dayRelation, 'matches when either day field matches');
  assert.equal(described('0 0 12 ? * 6L', 'quartz', 'en').dayRelation, 'both day fields must match');
  assert.equal(described('0 0 12 * * *', 'unix', 'zh-CN').dayRelation, '日与周满足任一即触发');
});

test('逐字段展开与语言出口', () => {
  const zh = described('0 15 10 ? * MON-FRI', 'quartz', 'zh-CN');
  assert.equal(zh.lang, 'zh-CN');
  assert.deepEqual(Object.keys(zh.fieldLines), ['sec', 'min', 'hour', 'dom', 'month', 'dow']);
  assert.ok(zh.fieldLines.dow.length > 0);
  assert.ok(zh.dstNote.length > 0);
  const en = described('0 15 10 ? * MON-FRI', 'quartz', 'en');
  assert.equal(en.lang, 'en');
  assert.notEqual(en.full, zh.full);
  const unix = described('*/15 * * * *', 'unix', 'en');
  assert.equal(Object.keys(unix.fieldLines).length, 5);
});

test('描述模板在两份字典中完整覆盖', () => {
  for (const key of CP.cron.describe.templateKeys) {
    assert.ok(Object.prototype.hasOwnProperty.call(CP.i18n.dict['zh-CN'], 'desc.' + key), 'zh-CN 缺 desc.' + key);
    assert.ok(Object.prototype.hasOwnProperty.call(CP.i18n.dict.en, 'desc.' + key), 'en 缺 desc.' + key);
  }
  assert.ok(CP.cron.describe.templateKeys.length >= 40);
});
