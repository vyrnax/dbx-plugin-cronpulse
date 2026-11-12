import test from 'node:test';
import assert from 'node:assert';
import { loadCP } from './_loader.mjs';

const CP = loadCP();
const D = CP.cron.dialect;

function evaluate(overrides) {
  return CP.engine.evaluate(Object.assign({
    expr: '0 0 12 * * ?', dialect: 'quartz', tz: 'UTC', count: 10,
    dstMissing: 'skip', describeLang: 'zh-CN'
  }, overrides || {}));
}

function recordingDocument() {
  const tokens = [];
  const attributes = [];
  const element = function () {
    return {
      hidden: false, value: '', textContent: '', title: '', style: {}, dataset: {},
      children: [], classList: { add() {}, remove() {} },
      setAttribute() {}, getAttribute() { return ''; },
      appendChild(child) { this.children.push(child); return child; },
      addEventListener() {}, removeEventListener() {},
      querySelectorAll() { return []; }, getContext() { return null; }
    };
  };
  return {
    tokens, attributes,
    hidden: false,
    documentElement: {
      style: { setProperty(name, value) { tokens.push([name, value]); } },
      setAttribute(name, value) { attributes.push([name, value]); }
    },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return element(); },
    addEventListener() {}
  };
}

test('空表达式、只有空格与全角空白均安全', () => {
  for (const expr of ['', '   ', '\t\n', '\u3000\u3000']) {
    const result = evaluate({ expr });
    assert.equal(result.status, 'empty');
    assert.equal(result.description, null);
    assert.equal(result.times, null);
    assert.equal(result.issues.length, 0);
  }
});

test('1 万 token 超长输入被截断且不卡死', () => {
  const expr = Array.from({ length: 10000 }, function (_, index) {
    return String(index % 60);
  }).join(' ');
  const started = performance.now();
  const result = evaluate({ expr, dialect: 'unix' });
  const elapsed = performance.now() - started;
  assert.equal(result.ast.tooLong, true);
  assert.equal(result.ast.raw.length, expr.length);
  assert.ok(result.ast.normalized.length <= 4096);
  assert.ok(result.issues.some(function (issue) { return issue.code === 'INPUT_TOO_LONG'; }));
  assert.equal(result.status, 'error');
  assert.equal(result.times, null);
  assert.ok(elapsed < 300, '超长输入耗时 ' + elapsed.toFixed(1) + 'ms');
});

test('未知时区与条数边界', () => {
  const bad = evaluate({ tz: 'Not/AZone' });
  assert.ok(bad.issues.some(function (issue) { return issue.code === 'BAD_TIMEZONE'; }));
  assert.equal(bad.status, 'error');
  assert.ok(evaluate({ count: 201 }).issues.some(function (issue) {
    return issue.code === 'COUNT_OUT_OF_BOUNDS';
  }));
  assert.equal(evaluate({ count: 200 }).issues.some(function (issue) {
    return issue.code === 'COUNT_OUT_OF_BOUNDS';
  }), false);
  assert.equal(CP.cron.tz.isZone('UTC'), true);
  assert.equal(CP.cron.tz.isZone('Not/AZone'), false);
  assert.equal(CP.bridge.supportsTimezones(), true);
});

test('重复重算与页签切换不产生状态漂移', () => {
  const first = CP.app.recompute();
  for (let index = 0; index < 20; index += 1) CP.app.recompute();
  const last = CP.app.recompute();
  assert.equal(first.status, last.status);
  assert.equal(CP.app.state.tab, 'timeline');
  CP.app.state.tab = 'describe';
  CP.app.recompute();
  assert.equal(CP.app.state.tab, 'describe');
  CP.app.state.tab = 'timeline';
  CP.app.recompute();
});

test('主题、自定义调色板与编辑器字体 token 生效', async () => {
  const document = recordingDocument();
  const theme = {
    appearance: 'dark',
    tokens: {
      '--color-primary': '#ff8800', '--radius-md': '4px',
      '--font-mono': 'Fira Code', '--dbx-private': 'ignored'
    },
    editor: { fontSize: 16, fontFamily: 'Fira Code' }
  };
  const sandbox = loadCP({ document: document, theme: theme, locale: 'en' });
  await sandbox.app.init();
  const names = document.tokens.map(function (pair) { return pair[0]; });
  assert.ok(names.includes('--color-primary'));
  assert.ok(names.includes('--radius-md'));
  assert.ok(names.includes('--font-mono'));
  assert.ok(names.includes('--cp-editor-size'));
  assert.ok(names.includes('--cp-mono'));
  assert.equal(names.includes('--dbx-private'), false);
  assert.ok(document.tokens.some(function (pair) {
    return pair[0] === '--cp-editor-size' && pair[1] === '16px';
  }));
  assert.ok(document.attributes.some(function (pair) {
    return pair[0] === 'data-appearance' && pair[1] === 'dark';
  }));
  assert.equal(sandbox.i18n.locale(), 'en');
});

test('host.storage 可用路径与降级路径都能读写', async () => {
  const data = new Map();
  const storage = {
    get: async function (key) { return data.has(key) ? data.get(key) : null; },
    set: async function (key, value) { data.set(key, value); },
    delete: async function (key) { data.delete(key); }
  };
  const sandbox = loadCP({
    document: recordingDocument(),
    capabilities: { storage: true }, storage: storage
  });
  await sandbox.bridge.init();
  assert.equal(sandbox.bridge.hasStorage(), true);
  await sandbox.store.load();
  await sandbox.store.addFavorite({ expr: '0 0 12 * * ?', dialect: 'quartz', tz: 'UTC' });
  assert.equal(data.has('favorites'), true);
  assert.equal(sandbox.store.favorites().length, 1);
  await sandbox.store.setPrefs({ dialect: 'quartz' });
  assert.equal(data.get('prefs').dialect, 'quartz');
  assert.equal(CP.bridge.hasStorage(), false);
  assert.equal(CP.bridge.storageWarned(), true);
});

test('宿主 token 与 appearance 标记不一致时，以实测底色为准', async () => {
  const document = recordingDocument();
  const sandbox = loadCP({
    document: document,
    theme: { appearance: 'dark', tokens: { '--color-background': '#ffffff', '--color-card': '#ffffff' } },
    locale: 'zh-CN'
  });
  await sandbox.bridge.init();
  const scheme = document.tokens.filter(function (pair) { return pair[0] === 'color-scheme'; }).pop();
  assert.ok(scheme, '未写入 color-scheme');
  assert.equal(scheme[1], 'light', '浅色 token + 残留 dark 标记必须判为 light');
  assert.equal(sandbox.bridge.toneOf('#ffffff'), 'light');
  assert.equal(sandbox.bridge.toneOf('#1e1e22'), 'dark');
  assert.equal(sandbox.bridge.toneOf('rgb(30 30 34)'), 'dark');
  assert.equal(sandbox.bridge.toneOf('rgb(248 250 252)'), 'light');
  assert.equal(sandbox.bridge.toneOf('oklch(1 0 0)'), 'light');
  assert.equal(sandbox.bridge.toneOf('oklch(0.2 0.01 270)'), 'dark');
  assert.equal(sandbox.bridge.toneOf('hsl(220 10% 96%)'), 'light');
  assert.equal(sandbox.bridge.toneOf(''), null);
});

test('新增文案键与字典无重复', () => {
  for (const key of ['msg.INPUT_TOO_LONG', 'banner.intlMissing', 'toast.undo',
    'snippets.title', 'snippets.supported', 'snippets.unsupported']) {
    assert.ok(CP.i18n.dict['zh-CN'][key], 'zh-CN 缺 ' + key);
    assert.ok(CP.i18n.dict.en[key], 'en 缺 ' + key);
  }
  assert.equal(CP.i18n.t('msg.INPUT_TOO_LONG', { value: 4096 }).includes('4096'), true);
  assert.equal(CP.i18n.t('banner.intlMissing').length > 0, true);
  assert.equal(Object.keys(CP.i18n.dict['zh-CN']).length,
    Object.keys(CP.i18n.dict.en).length);
  assert.equal(D.get('quartz').dowRange().min, 1);
});
