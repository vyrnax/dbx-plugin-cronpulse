import test from 'node:test';
import assert from 'node:assert';
import { loadCP } from './_loader.mjs';

const CP = loadCP();
const D = CP.cron.dialect;

function converted(expr, from, to) {
  const source = D.get(from);
  const ast = CP.cron.parse.parse(expr, source);
  return CP.cron.convert.convert(ast, source, to);
}

function validate(expr, name) {
  const dialect = D.get(name);
  return CP.cron.validate.validate(CP.cron.parse.parse(expr, dialect), dialect, { tz: 'UTC' }).status;
}

test('Spring 5L 与 Quartz 6L 互转做星期编号重映射', () => {
  const toQuartz = converted('0 15 10 ? * 5L', 'spring', 'quartz');
  assert.equal(toQuartz.ok, true);
  assert.equal(toQuartz.expression, '0 15 10 ? * 6L');
  assert.equal(toQuartz.remapped, true);
  assert.equal(validate(toQuartz.expression, 'quartz'), 'valid');
  const toSpring = converted('0 15 10 ? * 6L', 'quartz', 'spring');
  assert.equal(toSpring.ok, true);
  assert.equal(toSpring.expression, '0 15 10 ? * 5L');
  assert.equal(validate(toSpring.expression, 'spring'), 'valid');
  assert.equal(converted('0 15 10 ? * 5', 'spring', 'quartz').expression, '0 15 10 ? * 6');
  assert.equal(converted('0 15 10 ? * 5', 'quartz', 'spring').expression, '0 15 10 ? * 4');
});

test('字段数对齐与年份裁剪', () => {
  const toSpring = converted('0 15 * * *', 'unix', 'spring');
  assert.equal(toSpring.ok, true);
  assert.equal(toSpring.expression.split(' ').length, 6);
  assert.equal(toSpring.expression.split(' ')[0], '0');
  const toUnix = converted('0 15 10 * * ?', 'quartz', 'unix');
  assert.equal(toUnix.ok, true);
  assert.equal(toUnix.expression.split(' ').length, 5);
  const yearRemoved = converted('0 0 12 * * ? 2026', 'quartz', 'spring');
  assert.equal(yearRemoved.yearRemoved, true);
  assert.equal(yearRemoved.expression.split(' ').length, 6);
  const yearKept = converted('0 0 12 * * ? 2026', 'quartz', 'quartz');
  assert.equal(yearKept.expression.split(' ').length, 7);
  assert.equal(validate(yearKept.expression, 'quartz'), 'valid');
});

test('目标方言不支持时返回降级结果而非假代码', () => {
  const unsupported = converted('0 15 10 LW * ?', 'quartz', 'unix');
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.code, 'UNSUPPORTED_IN_TARGET');
  assert.equal(unsupported.messageKey, 'msg.UNSUPPORTED_IN_TARGET');
  const nth = converted('0 15 10 ? * 6#3', 'quartz', 'unix');
  assert.equal(nth.ok, false);
  assert.equal(converted('', 'unix', 'spring').code, 'EMPTY_EXPRESSION');
  assert.equal(CP.cron.convert.convert(CP.cron.parse.parse('0 0 12 * * ?', D.get('quartz')),
    D.get('quartz'), 'unknown').code, 'BAD_DIALECT');
});

test('每个目标方言输出都能被自身 validate 通过', () => {
  const cases = [
    ['0 0 12 ? * 6L', 'quartz'],
    ['0 0 12 L-3 * ?', 'quartz'],
    ['0 0 12 ? * 6#3', 'quartz'],
    ['0 15 10 ? * MON-FRI', 'spring'],
    ['*/15 * * * *', 'unix']
  ];
  for (const [expr, from] of cases) {
    const source = D.get(from);
    const ast = CP.cron.parse.parse(expr, source);
    const targets = CP.cron.convert.allTargets(ast, source);
    assert.deepEqual(Object.keys(targets), ['unix', 'spring', 'quartz']);
    for (const name of Object.keys(targets)) {
      if (!targets[name].ok) continue;
      assert.notEqual(validate(targets[name].expression, name), 'error', `${expr} → ${name}`);
    }
  }
});

test('名称型星期与步长写法在互转中保持', () => {
  const named = converted('0 15 10 ? * FRIL', 'spring', 'quartz');
  assert.equal(named.ok, true);
  assert.ok(named.expression.includes('FRIL'));
  const step = converted('0 0 12 5/15 * ?', 'quartz', 'spring');
  assert.equal(step.ok, true);
  assert.ok(step.expression.includes('5/15'));
  const ranged = converted('0 0 2-5/2 * * ?', 'quartz', 'spring');
  assert.equal(ranged.ok, true);
  assert.ok(ranged.expression.includes('2-5/2'));
});
