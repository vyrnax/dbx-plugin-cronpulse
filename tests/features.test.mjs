import test from 'node:test';
import assert from 'node:assert';
import { loadCP } from './_loader.mjs';

const CP = loadCP();
const D = CP.cron.dialect;

test('预设是方言无关概念：8 条概念在每种可选方言下都能重铸为合法表达式', () => {
  const presets = CP.store.presets;
  assert.equal(presets.length, 8);
  for (const preset of presets) assert.ok(preset.emoji, '缺图标: ' + preset.id);
  for (const preset of presets) {
    const source = D.get(preset.source);
    assert.ok(source, preset.id);
    for (const name of D.list()) {
      const shown = CP.store.presetExpression(preset, name);
      assert.ok(shown.expression, '重铸为空: ' + preset.id + ' -> ' + name);
      assert.equal(shown.ok, true, '重铸有损: ' + preset.id + ' -> ' + name);
      const spec = D.get(name);
      const validation = CP.cron.validate.validate(
        CP.cron.parse.parse(shown.expression, spec), spec, { tz: 'UTC' }
      );
      assert.notEqual(validation.status, 'error', preset.id + ' -> ' + name + ': ' + shown.expression);
    }
    const validation = CP.cron.validate.validate(
      CP.cron.parse.parse(preset.expr, source), source, { tz: 'UTC' }
    );
    assert.notEqual(validation.status, 'error', preset.expr);
    assert.ok(CP.i18n.dict['zh-CN']['preset.' + preset.id], 'zh-CN 缺 preset.' + preset.id);
    assert.ok(CP.i18n.dict.en['preset.' + preset.id], 'en 缺 preset.' + preset.id);
    assert.ok(CP.i18n.dict.en['preset.' + preset.id] !== CP.i18n.dict['zh-CN']['preset.' + preset.id]
      || preset.id === 'k8s');
  }
});

test('收藏、历史与偏好：去重、裁剪、内存降级', async () => {
  await CP.store.load();
  await CP.store.clearHistory();
  const entry = { expr: '* * * * *', dialect: 'unix', tz: 'UTC' };
  await CP.store.addFavorite(entry);
  await CP.store.addFavorite(entry);
  assert.equal(CP.store.favorites().length, 1);
  assert.equal(CP.store.isFavorite(entry), true);
  await CP.store.toggleFavorite(entry);
  assert.equal(CP.store.isFavorite(entry), false);
  await CP.store.pushHistory(entry);
  await CP.store.pushHistory(entry);
  assert.equal(CP.store.history().length, 1);
  for (let index = 0; index < 60; index += 1) {
    await CP.store.pushHistory({ expr: '0 ' + index + ' * * *', dialect: 'unix' });
  }
  assert.ok(CP.store.history().length <= 50);
  assert.equal(CP.store.history()[0].expr.startsWith('0 '), true);
  await CP.store.setPrefs({ dialect: 'quartz', timezone: 'Asia/Shanghai' });
  assert.equal(CP.store.prefs().dialect, 'quartz');
  assert.equal(CP.store.prefs().timezone, 'Asia/Shanghai');
  assert.equal(CP.bridge.hasStorage(), false);
});

test('片段生成：支持与不支持明确区分，不产出假代码', () => {
  const quartz = D.get('quartz');
  const simple = CP.snippets.generate('0 0 12 * * ?', quartz, { tz: 'Asia/Shanghai' });
  assert.equal(simple.length, 9);
  assert.ok(simple.every((item) => item.label && item.id));
  const spring = simple.find((item) => item.id === 'spring');
  assert.equal(spring.supported, true);
  assert.ok(spring.code.includes('@Scheduled'));
  assert.ok(spring.code.includes('Asia/Shanghai'));
  assert.equal(simple.find((item) => item.id === 'k8s').supported, true);
  assert.equal(simple.find((item) => item.id === 'crontab').supported, true);

  const special = CP.snippets.generate('0 15 10 ? * 6L', quartz, { tz: 'UTC' });
  const robfig = special.find((item) => item.id === 'robfig');
  assert.equal(robfig.supported, false);
  assert.equal(robfig.code, null);
  assert.ok(robfig.reason);
  assert.equal(special.find((item) => item.id === 'xxljob').supported, true);

  const named = CP.snippets.generate('0 0 12 ? * MON-FRI', quartz, { tz: 'UTC' });
  // robfig 支持名称：MON-FRI 应可作为片段产出
  assert.equal(named.find((item) => item.id === 'robfig').supported, true);
  const random = CP.snippets.generate('6~15 * * * *', D.get('unix'), { tz: 'UTC' });
  assert.equal(random.find((item) => item.id === 'xxljob').supported, false);
});

test('兼容矩阵与渲染入口在无 DOM 环境下安全', () => {
  const matrix = CP.snippets.compatibility('0 0 12 * * ?', D.get('quartz'));
  assert.equal(matrix.length, 9);
  assert.equal(matrix.every((item) => typeof item.supported === 'boolean'), true);
  assert.equal(typeof CP.snippets.render(null, null, {}), 'undefined');
  assert.equal(typeof CP.store.render({}, {}), 'undefined');
  assert.equal(typeof CP.timeline.drawCanvas(null, {}), 'undefined');
  assert.equal(typeof CP.timeline.render(null, {}), 'undefined');
});

test('片段与预设文案键在两份字典中完整', () => {
  for (const id of ['spring', 'quartz', 'robfig', 'apscheduler', 'croniter', 'node', 'k8s', 'xxljob', 'crontab']) {
    assert.ok(CP.i18n.dict['zh-CN']['snippets.' + id]);
    assert.ok(CP.i18n.dict.en['snippets.' + id]);
  }
  for (const key of ['snippets.title', 'snippets.supported', 'snippets.unsupported',
    'history.empty', 'common.cancel', 'common.save', 'common.remove']) {
    assert.ok(CP.i18n.dict['zh-CN'][key], 'zh-CN 缺 ' + key);
    assert.ok(CP.i18n.dict.en[key], 'en 缺 ' + key);
  }
});

test('字段构建器：双向同步、高级项与无 DOM 降级', () => {
  assert.equal(CP.builder.advanced.length, 6);
  for (const item of CP.builder.advanced) {
    assert.ok(['dom', 'dow'].includes(item.key));
    assert.ok(item.feature);
    assert.ok(item.syntax);
  }
  assert.equal(typeof CP.builder.renderCards(null, { dialect: 'quartz', expr: '0 0 12 * * ?' }), 'undefined');
  const state = { dialect: 'quartz', expr: '0 0 12 * * ?', tz: 'UTC', count: 10, dstMissing: 'skip' };
  CP.builder.update(state, 'dom', '15');
  assert.equal(state.expr, '0 0 12 15 * ?');
  const dialect = D.get('quartz');
  assert.notEqual(CP.cron.validate.validate(
    CP.cron.parse.parse(state.expr, dialect), dialect, { tz: 'UTC' }
  ).status, 'error');
  CP.builder.update(state, 'dow', '?');
  assert.equal(state.expr, '0 0 12 15 * ?');
  CP.builder.update(state, 'year', '2026');
  assert.equal(state.expr.split(' ').length, 7);
  const conflict = CP.engine.evaluate({
    expr: '0 0 12 1 * 5', dialect: 'quartz', tz: 'UTC', count: 3, dstMissing: 'skip'
  });
  assert.ok(conflict.issues.some((issue) => issue.code === 'QUARTZ_BOTH_DAYS_CONCRETE'));
});
