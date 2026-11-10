import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { loadCP, paths } from './_loader.mjs';

const manifest = JSON.parse(fs.readFileSync(path.join(paths.ROOT, 'manifest.json'), 'utf8'));

test('清单身份与权限固定', () => {
  assert.equal(manifest.id, 'com.vyrnax.cronpulse');
  assert.equal(manifest.publisher, 'vyrnax');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.manifest_version, 1);
  assert.deepEqual(manifest.permissions, ['host.storage']);
  assert.equal(manifest.engines.dbx, '>=0.6.21');
  assert.equal(manifest.engines.host_api, '1');
  assert.equal(manifest.entrypoints.ui.root, 'ui');
  assert.equal(manifest.entrypoints.ui.entry, 'ui/index.html');
  assert.equal(manifest.entrypoints.backend, undefined);
});

test('贡献点结构符合安装期白名单', () => {
  const types = manifest.contributions.map((item) => item.type);
  assert.deepEqual(types, ['workbench', 'command', 'menus']);
  const command = manifest.contributions[1];
  assert.equal(command.action.type, 'open-workbench');
  assert.equal(command.action.presentation, 'tab');
  assert.equal(command.presentation, undefined);
  const menus = manifest.contributions[2];
  assert.equal(menus.label, undefined);
  assert.equal(menus.items.length, 2);
  for (const item of menus.items) {
    for (const key of ['location', 'command', 'group', 'order']) assert.ok(key in item);
  }
  const localizations = manifest.localizations.en.contributions;
  assert.equal(localizations[menus.id], undefined);
  assert.ok(localizations[command.id].label);
});

test('两份字典键集合完全一致', () => {
  const CP = loadCP({ files: ['i18n.js'] });
  const zh = Object.keys(CP.i18n.dict['zh-CN']).sort();
  const en = Object.keys(CP.i18n.dict.en).sort();
  assert.deepEqual(zh, en);
  assert.ok(zh.length >= 60);
});

test('文案出口与语言回退', () => {
  const CP = loadCP({ files: ['i18n.js'] });
  assert.equal(CP.i18n.setLocale('zh-CN'), 'zh-CN');
  assert.equal(CP.i18n.t('app.title'), 'Cron表达式生成器');
  CP.i18n.setLocale('en');
  assert.equal(CP.i18n.t('app.title'), 'CronPulse');
  CP.i18n.setLocale('fr-FR');
  assert.equal(CP.i18n.locale(), 'en');
  assert.equal(CP.i18n.t('toast.dowRemapped', { from: '5', to: '6' }),
    'Day-of-week remapped: Spring/Unix 5 → Quartz 6');
  assert.equal(CP.i18n.t('missing.key'), 'missing.key');
});

test('宿主桥接在缺少持久化能力时降级', async () => {
  const CP = loadCP({ files: ['i18n.js', 'bridge.js'] });
  await CP.bridge.init();
  assert.equal(CP.bridge.env().locale, 'zh-CN');
  assert.equal(CP.bridge.hasStorage(), false);
  await CP.bridge.set('favorites', [{ expr: '* * * * *' }]);
  assert.deepEqual(await CP.bridge.get('favorites'), [{ expr: '* * * * *' }]);
  assert.equal(await CP.bridge.get('missing'), null);
  assert.equal(CP.bridge.storageWarned(), true);
  assert.equal(CP.bridge.supportsTimezones(), true);
});

test('应用骨架可在无 DOM 节点的降级环境启动', async () => {
  const CP = loadCP({ files: ['i18n.js', 'bridge.js', 'app.js'] });
  assert.equal(typeof CP.app.recompute, 'function');
  assert.equal(typeof CP.app.state, 'object');
  CP.app.recompute();
  await Promise.resolve();
  assert.ok(CP.i18n);
});

test('HTML 与关键资源齐备', () => {
  const html = fs.readFileSync(path.join(paths.UI, 'index.html'), 'utf8');
  for (const id of ['expr-input', 'sel-dialect', 'sel-timezone', 'sel-count', 'sel-dst',
    'chk-year', 'card-sec', 'card-min', 'card-hour', 'card-dom', 'card-month',
    'card-dow', 'card-year', 'error-list', 'tab-describe', 'tab-timeline',
    'tab-snippets', 'timeline-canvas', 'preset-area', 'favorites-area', 'history-area']) {
    assert.ok(html.includes(`id="${id}"`), `缺 #${id}`);
  }
  assert.equal(/<script[^>]+type="module"/.test(html), false);
  assert.equal(/<link[^>]+href="https?:/.test(html), false);
});
