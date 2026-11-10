/**
 * 用 node:vm 按 index.html 的依赖顺序直接 eval 发行用的同一份脚本，
 * 取回全局 CP 供断言使用。不使用 ESM 副本，避免测试与发布字节漂移。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'ui');

export const LOAD_ORDER = [
  'i18n.js',
  'bridge.js',
  'cron/dialect.js',
  'cron/bits.js',
  'cron/parse.js',
  'cron/validate.js',
  'cron/tz.js',
  'cron/next.js',
  'cron/describe.js',
  'cron/convert.js',
  'cron/engine.js',
  'builder.js',
  'timeline.js',
  'snippets.js',
  'store.js',
  'app.js'
];

function makeElement() {
  return {
    hidden: false,
    value: '',
    textContent: '',
    title: '',
    style: {},
    dataset: {},
    children: [],
    setAttribute() {},
    getAttribute() { return ''; },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll() { return []; },
    getContext() { return null; }
  };
}

function makeDocument() {
  return {
    hidden: false,
    documentElement: { style: { setProperty() {} }, setAttribute() {} },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return makeElement(); },
    addEventListener() {}
  };
}

export function loadCP(options = {}) {
  const files = options.files || LOAD_ORDER;
  const document = (options.document || makeDocument());
  const sandbox = {
    document,
    Intl,
    Date,
    Math,
    JSON,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    getComputedStyle() { return { getPropertyValue() { return ''; } }; },
    devicePixelRatio: 1,
    dbxPlugin: {
      ready: Promise.resolve(),
      locale: options.locale || 'zh-CN',
      theme: options.theme || { appearance: 'light', tokens: {}, editor: {} },
      capabilities: options.capabilities || { storage: false },
      storage: options.storage || null
    },
    addEventListener() {},
    removeEventListener() {}
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  for (const relative of files) {
    const absolute = path.join(UI, relative);
    if (!fs.existsSync(absolute)) continue;
    vm.runInContext(fs.readFileSync(absolute, 'utf8'), context, { filename: relative });
  }
  return vm.runInContext('CP', context);
}

export const paths = { ROOT, UI };
