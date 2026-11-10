import test from 'node:test';
import assert from 'node:assert';
import { loadCP } from './_loader.mjs';

const CP = loadCP();
const D = CP.cron.dialect;

function check(expr, dialectName, options) {
  const dialect = D.get(dialectName);
  const ast = CP.cron.parse.parse(expr, dialect);
  const result = CP.cron.validate.validate(ast, dialect, options || { tz: 'UTC', count: 10 });
  return { ast, result, dialect };
}

function codes(expr, dialectName, options) {
  return check(expr, dialectName, options).result.issues.map((issue) => issue.code);
}

test('字段数与范围：一次报出全部错误', () => {
  assert.ok(codes('* * * *', 'unix').includes('FIELD_COUNT_MISMATCH'));
  assert.ok(codes('0 0 12 * * ? * *', 'quartz').includes('FIELD_COUNT_MISMATCH'));
  assert.equal(check('0 0 12 * * ?', 'quartz').result.status, 'valid');
  assert.equal(check('0 0 12 * * ? 2026', 'quartz').result.status, 'valid');
  assert.ok(codes('60 24 * * *', 'unix').includes('OUT_OF_RANGE'));
  const both = check('60 99 * * *', 'unix').result;
  assert.equal(both.issues.filter((issue) => issue.code === 'OUT_OF_RANGE').length, 2);
  assert.equal(check('0 0 12 * *', 'unix').result.status, 'valid');
});

test('名称只接受前 3 字母并给出建议', () => {
  assert.equal(check('0 12 * JAN *', 'unix').result.status, 'valid');
  const long = check('0 12 * January *', 'unix').result.issues;
  assert.ok(long.some((issue) => issue.code === 'NAME_TOO_LONG' && issue.params.suggestion === 'JAN'));
  assert.ok(codes('0 12 * XYZ *', 'unix').includes('BAD_NAME'));
  assert.equal(check('0 15 10 ? * MON-FRI', 'quartz').result.status, 'valid');
  const robfig = codes('15 10 ? * MON-FRI', 'robfig');
  assert.ok(robfig.includes('NAMES_NOT_SUPPORTED'));
});

test('问号与方言专属字符', () => {
  assert.ok(codes('0 12 ? * ?', 'unix').includes('QUESTION_NOT_ALLOWED'));
  assert.equal(check('0 12 ? * ?', 'robfig').result.status, 'valid');
  assert.ok(codes('? 0 12 * * ?', 'quartz').includes('NOT_ALLOWED_IN_DIALECT'));
  assert.equal(check('0 15 10 L-3 * ?', 'quartz').result.status, 'valid');
  assert.equal(check('0 15 10 LW * ?', 'quartz').result.status, 'valid');
  assert.equal(check('0 15 10 15W * ?', 'quartz').result.status, 'valid');
  assert.equal(check('0 15 10 ? * 6L', 'quartz').result.status, 'valid');
  assert.equal(check('0 15 10 ? * 6#3', 'quartz').result.status, 'valid');
  assert.ok(codes('15 10 L * ?', 'unix').includes('NOT_ALLOWED_IN_DIALECT'));
  assert.ok(codes('15 10 ? * 6#3', 'unix').includes('NOT_ALLOWED_IN_DIALECT'));
  assert.ok(codes('0 15 10 ? * LW', 'quartz').includes('LW_REQUIRES_DOM'));
  assert.ok(codes('0 15 10 ? * 6#6', 'quartz').includes('N_TH_OUT_OF_RANGE'));
  assert.ok(codes('0 15 10 L-31 * ?', 'quartz').includes('L_MINUS_OUT_OF_RANGE'));
  assert.ok(codes('0 15 10 5#3 * ?', 'quartz').includes('HASH_ONLY_DOW'));
});

test('步长、区间与字符偏移定位', () => {
  assert.ok(codes('*/0 * * * *', 'unix').includes('STEP_ZERO'));
  assert.ok(codes('5-1 * * * *', 'unix').includes('RANGE_REVERSED'));
  assert.equal(check('0 0 12 5/15 * ?', 'quartz').result.status, 'valid');
  assert.equal(check('0 0 12 2-5/2 * ?', 'quartz').result.status, 'valid');
  assert.equal(check('0 0/15 12 * * ?', 'quartz').result.status, 'valid');
  const raw = '0 0 12 32 * ?';
  const issue = check(raw, 'quartz').result.issues.find((item) => item.code === 'OUT_OF_RANGE');
  assert.ok(issue);
  assert.equal(raw.slice(issue.charOffset, issue.charOffset + issue.charLength), '32');
  assert.equal(issue.fieldName, 'field.dom');
  assert.equal(issue.severity, 'error');
  assert.ok(issue.messageKey.startsWith('msg.'));
  const macro = check('@daily', 'unix');
  assert.equal(macro.ast.expandedFrom, '@daily');
  assert.equal(macro.ast.fields.length, 5);
  assert.equal(macro.ast.fields[0].raw, '0');
});

test('Quartz 双日冲突与星期编号歧义警告', () => {
  const both = check('0 0 12 1 * 5', 'quartz').result;
  assert.equal(both.issues.filter((item) => item.code === 'QUARTZ_BOTH_DAYS_CONCRETE').length, 2);
  assert.ok(both.issues.some((item) => item.suggestion === 'set-day-question'));
  assert.equal(check('0 0 12 ? * 5', 'quartz').result.issues.some((item) => item.code === 'QUARTZ_BOTH_DAYS_CONCRETE'), false);
  assert.ok(codes('0 0 12 ? * 5', 'quartz').includes('DOW_BASE_AMBIGUOUS'));
  assert.ok(codes('0 12 1 * 5', 'unix').includes('POSIX_DAY_UNION'));
  assert.ok(codes('0 12 1 * 1', 'robfig').includes('DOW_BASE_AMBIGUOUS'));
});

test('cronie 扩展：随机区间与重启宏只给警告', () => {
  const random = check('6~15 * * * *', 'unix');
  assert.ok(random.result.issues.some((item) => item.code === 'RANDOM_RANGE_NOT_DETERMINISTIC'));
  assert.equal(random.result.predictable, false);
  const reboot = check('@reboot', 'unix');
  assert.equal(reboot.ast.nonTemporal, true);
  assert.ok(reboot.result.issues.some((item) => item.code === 'REBOOT_MACRO_HAS_NO_TIME'));
  assert.equal(reboot.result.predictable, false);
  assert.equal(check('0 12 * * *', 'unix').result.predictable, true);
});

test('时区、条数与月份边界', () => {
  assert.ok(codes('0 0 12 * * ?', 'quartz', { tz: 'Not/AZone', count: 10 }).includes('BAD_TIMEZONE'));
  assert.ok(codes('0 0 12 * * ?', 'quartz', { tz: 'UTC', count: 201 }).includes('COUNT_OUT_OF_BOUNDS'));
  assert.ok(codes('0 0 0 30 2 ?', 'quartz').includes('FEB_30'));
  assert.ok(codes('0 0 0 31 2 ?', 'quartz').includes('MONTH_HAS_NO_31ST'));
  assert.equal(check('0 0 12 * * ?', 'quartz', { tz: 'Asia/Shanghai', count: 10 }).result.status, 'valid');
  assert.equal(check('', 'unix').result.status, 'empty');
  assert.equal(check('   ', 'unix').result.predictable, false);
});

test('编排层把错误码转成可读文案', () => {
  const result = CP.engine.evaluate({
    expr: '60 * * * *', dialect: 'unix', tz: 'UTC', count: 10,
    dstMissing: 'skip', describeLang: 'zh-CN'
  });
  assert.equal(result.status, 'error');
  assert.ok(result.issues[0].message.includes('60'));
  assert.equal(result.description, null);
  const ok = CP.engine.evaluate({
    expr: '0 0 12 * * ?', dialect: 'quartz', tz: 'UTC', count: 3,
    dstMissing: 'skip', describeLang: 'en'
  });
  assert.equal(ok.status, 'valid');
  assert.ok(ok.description.full.length > 0);
  assert.equal(ok.times.times.length, 3);
});
