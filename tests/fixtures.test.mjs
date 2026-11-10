import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { loadCP, paths } from './_loader.mjs';

const CP = loadCP();
const D = CP.cron.dialect;
const fixtures = JSON.parse(fs.readFileSync(
  path.join(paths.ROOT, 'tests', 'fixtures', 'quartz-official.json'), 'utf8'
));

test('fixture 规模与来源字段完整', () => {
  assert.equal(fixtures.cases.length, 27);
  assert.equal(fixtures.cases.filter((item) => item.dialect === 'quartz').length, 12);
  assert.equal(fixtures.cases.filter((item) => item.dialect === 'spring').length, 15);
  for (const item of fixtures.cases) {
    assert.ok(item.expr);
    assert.ok(item.first);
    assert.ok(item.zh);
    assert.ok(item.en);
    assert.equal(typeof item.note, 'undefined');
  }
  assert.ok(fixtures.from.endsWith('Z'));
});

for (const item of fixtures.cases) {
  test(`${item.dialect} 官方示例：${item.expr}`, () => {
    const dialect = D.get(item.dialect);
    assert.ok(dialect);
    const ast = CP.cron.parse.parse(item.expr, dialect);
    const validation = CP.cron.validate.validate(ast, dialect, { tz: 'UTC', count: 10 });
    assert.notEqual(validation.status, 'error', JSON.stringify(validation.issues.map((i) => i.code)));
    const result = CP.cron.next.next(ast, dialect, {
      tz: 'UTC', count: 10, from: fixtures.from, dstMissing: 'skip'
    });
    assert.equal(result.code, null);
    assert.ok(result.times.length >= 2);
    assert.equal(new Date(result.times[0].instant).toISOString(), item.first);
    for (let index = 1; index < result.times.length; index += 1) {
      assert.ok(result.times[index].instant > result.times[index - 1].instant);
      assert.equal(result.times[index].wall.y >= 2026, true);
    }
    const zh = CP.cron.describe.describe(ast, dialect, { lang: 'zh-CN' });
    const en = CP.cron.describe.describe(ast, dialect, { lang: 'en' });
    assert.equal(zh.lang, 'zh-CN');
    assert.equal(en.lang, 'en');
    assert.ok(zh.full.includes(item.zh), `中文描述缺 ${item.zh}：${zh.full}`);
    assert.ok(en.full.includes(item.en), `英文描述缺 ${item.en}：${en.full}`);
    assert.ok(zh.dayRelation.length > 0);
    assert.ok(en.dayRelation.length > 0);
    assert.notEqual(zh.full, en.full);
  });
}
