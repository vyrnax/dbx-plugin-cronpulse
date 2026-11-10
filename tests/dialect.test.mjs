import test from 'node:test';
import assert from 'node:assert';
import { loadCP } from './_loader.mjs';

const CP = loadCP();
const D = CP.cron.dialect;

test('注册表只暴露三个可选方言，names 含兼容档', () => {
  assert.deepEqual(D.list(), ['unix', 'spring', 'quartz']);
  assert.deepEqual(D.names(), ['unix', 'spring', 'quartz', 'robfig', 'nodecron']);
  assert.equal(D.get('missing'), null);
  assert.equal(D.get('unix').selectable, true);
  assert.equal(D.get('robfig').selectable, false);
  assert.equal(D.get('nodecron').selectable, false);
});

test('方言实例冻结且访问器契约完整', () => {
  const quartz = D.get('quartz');
  assert.equal(Object.isFrozen(quartz), true);
  assert.equal(Object.isFrozen(quartz.features), true);
  assert.equal(Object.isFrozen(quartz.getFields()), true);
  assert.equal(quartz.getFields().length, 7);
  assert.equal(quartz.getOptionalFields().length, 1);
  assert.equal(quartz.fieldCountMin, 6);
  assert.equal(quartz.fieldCountMax, 7);
  assert.equal(quartz.fieldIndexOf('dow'), 5);
  assert.equal(quartz.fieldIndexOf('year'), 6);
  assert.equal(quartz.fieldIndexOf('nope'), -1);
  assert.equal(quartz.allows('year'), true);
  assert.equal(quartz.allows('question'), true);
  assert.equal(quartz.allows('randomRange'), false);
  assert.equal(quartz.dowBase(), 'quartz');
  assert.deepEqual(quartz.dowRange(), { min: 1, max: 7 });
  assert.equal(quartz.dayMatch(), 'intersection');
  assert.equal(D.get('unix').dayMatch(), 'union');
  assert.deepEqual(D.get('unix').dowRange(), { min: 0, max: 7 });
  assert.equal(D.get('spring').allows('year'), false);
  assert.equal(D.get('spring').fieldCountMax, 6);
  assert.equal(D.get('unix').fieldCountMax, 5);
  assert.deepEqual(D.get('quartz').stepForms(), ['a/b', '*/b', 'a-b/c']);
  assert.equal(D.get('spring').macroTable()['@daily'], '0 0 0 * * *');
  assert.equal(D.get('unix').macroTable()['@daily'], '0 0 * * *');
  assert.equal(D.get('unix').macroTable()['@reboot'], null);
});

test('selfCheck 拒绝矛盾的 spec', () => {
  assert.throws(() => D.create({
    name: 'bad', dayMatch: 'intersection', fields: D.get('spring').getFields(),
    features: { question: false }
  }), /intersection/);
  assert.throws(() => D.create({
    name: 'bad2', dayMatch: 'union', fields: D.get('unix').getFields(),
    features: { year: true }
  }), /optional/);
  assert.throws(() => D.create({
    name: 'bad3', dowBase: 'other', fields: D.get('unix').getFields()
  }), /dowBase/);
  assert.throws(() => D.create({ name: 'bad4', fields: [] }), /field count/);
});

test('星期编号基准与归一往返一致', () => {
  const unix = D.get('unix');
  const quartz = D.get('quartz');
  assert.equal(D.toCanonical(5, 'unix'), 5);
  assert.equal(D.toCanonical(7, 'unix'), 0);
  assert.equal(D.toCanonical(0, 'unix'), 0);
  assert.equal(D.toCanonical(5, 'quartz'), 4);
  assert.equal(D.toCanonical(1, 'quartz'), 0);
  assert.equal(D.toCanonical(7, 'quartz'), 6);
  assert.equal(D.fromCanonical(5, 'quartz', false), 6);
  assert.equal(D.fromCanonical(0, 'unix', true), 7);
  assert.equal(unix.normalizeDow(5, 'quartz'), 6);
  assert.equal(quartz.normalizeDow(5, 'unix'), 4);
  for (let value = 0; value <= 7; value += 1) {
    const roundTrip = quartz.normalizeDow(unix.normalizeDow(value, 'quartz'), 'unix');
    assert.equal(D.toCanonical(roundTrip, 'unix'), D.toCanonical(value, 'unix'));
  }
  assert.equal(D.get('spring').normalizeMonth('SEP'), 9);
  assert.equal(D.get('unix').normalizeMonth(3), 3);
  assert.equal(D.monthNames.length, 12);
  assert.equal(D.dowNames.length, 7);
});

test('新增方言零侵入：注册 spec 后全链路可直接处理', () => {
  const fake = D.register({
    name: 'fakedialect', label: 'Fake', selectable: false,
    dowBase: 'unix', dayMatch: 'intersection', macroSet: 'spring',
    features: {
      question: true, last: true, lMinus: true, lw: true, w: true,
      nth: true, names: true, macros: true
    },
    fields: D.get('spring').getFields()
  });
  try {
    assert.equal(D.get('fakedialect'), fake);
    const ast = CP.cron.parse.parse('0 15 10 ? * 5L', fake);
    const validation = CP.cron.validate.validate(ast, fake, { tz: 'UTC' });
    assert.equal(validation.status, 'valid');
    const upcoming = CP.cron.next.next(ast, fake, {
      tz: 'UTC', count: 2, from: Date.parse('2026-01-01T00:00:00Z')
    });
    assert.equal(upcoming.times.length, 2);
    assert.ok(CP.cron.describe.describe(ast, fake, { lang: 'en' }).full.length > 0);
    const converted = CP.cron.convert.convert(ast, fake, 'spring');
    assert.equal(converted.ok, true);
    const reparsed = CP.cron.parse.parse(converted.expression, D.get('spring'));
    assert.notEqual(CP.cron.validate.validate(reparsed, D.get('spring'), {}).status, 'error');
    assert.deepEqual(D.list(), ['unix', 'spring', 'quartz']);
  } finally {
    D.remove('fakedialect');
    assert.equal(D.get('fakedialect'), null);
  }
});

test('宏表与字段元数据由访问器统一提供', () => {
  for (const name of D.names()) {
    const spec = D.get(name);
    for (const field of spec.getFields()) {
      assert.ok(field.key);
      assert.ok(field.i18nKey);
      assert.ok(field.min <= field.max);
      assert.ok(Array.isArray(field.itemTypes));
      assert.equal(spec.fieldIndexOf(field.key) >= 0, true);
    }
    assert.equal(typeof spec.hintKey, 'string');
    assert.equal(typeof spec.macroTable(), 'object');
  }
});
