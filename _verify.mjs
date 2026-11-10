#!/usr/bin/env node
/**
 * 包结构闸门：解包 .dbxp 后一次报完所有问题。
 * 只做校验，不做打包；只用 Node 内置模块（自带最小 zip 读取器）。
 *
 * 用法：node _verify.mjs "dist/*.dbxp"
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { basename, dirname, join, resolve } from 'node:path';

const FORBIDDEN_APIS = ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie'];
const TEXT_EXTENSIONS = ['.json', '.js', '.css', '.html', '.svg', '.md', '.toml'];

const TOP_LEVEL = ['$schema', 'manifest_version', 'id', 'name', 'version', 'publisher',
  'description', 'icon', 'source', 'homepage', 'engines', 'permissions', 'entrypoints',
  'contributions', 'localizations'];
const ENGINES_KEYS = ['dbx', 'host_api'];
const ENTRYPOINT_KEYS = ['ui', 'backend'];
const UI_ENTRY_KEYS = ['root', 'entry'];
const CONTRIBUTION_COMMON = ['type', 'id', 'label', 'description', 'icon'];
const CONTRIBUTION_EXTRA = { workbench: [], command: ['action'], menus: ['items'] };
const ACTION_KEYS = ['type', 'workbench', 'presentation'];
const MENU_ITEM_KEYS = ['location', 'command', 'group', 'order', 'default_visible'];
const LOCALIZATION_KEYS = ['name', 'description', 'contributions'];
const FORBIDDEN_PERMISSIONS = ['host.ai', 'host.workbench', 'host.events', 'host.binary',
  'host.filesystem', 'host.data:read', 'host.connections:read', 'host.clipboard:read'];
const BANNED_ENTRIES = [/^tests\//, /^node_modules\//, /^package\.json$/, /^\.dbx-dev\//,
  /^docs\//, /^PLAN\.md$/, /^AGENTS\.md$/, /\.mjs$/, /\.py$/, /^\.git\//, /^dist\//];
const BORROW = /(?:借鉴|参考自|移植自|clone\s*自|灵感来自|抄自|源自)[^\n]{0,60}?[A-Za-z][A-Za-z0-9._-]{2,}/;
const LOCAL_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/]|\/Users\/|\/home\//;
const REPO_REF = /(?<![\w./-])([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)(?![\w/])/g;
const IGNORE_REFS = new Set(['Area/City', 'MON/FRI', 'SUN/SAT', 'N/A', 'n/a', 'JS/TS', 'Not/AZone',
  'Spring/Unix', 'Unix/Spring', 'assert/strict', 'owner/repo', 'cronstrue/locales',
  'refs/tags', 'refs/heads',
  'dbx-app/plugin-cli', 'RUNNER_TEMP/store-candidate']);
const PATH_PREFIXES = new Set(['ui', 'assets', 'tests', 'docs', 'dist', 'node_modules',
  'http:', 'https:', 'actions', 'RUNNER_TEMP', 'Asia', 'America', 'Europe', 'Australia',
  'Pacific', 'Africa', 'Atlantic', 'Indian', 'Arctic', 'Antarctica', 'Etc']);
const FILE_SUFFIXES = ['.js', '.css', '.html', '.json', '.svg', '.mjs', '.py', '.yml', '.yaml', '.md', '.toml', '.txt'];

const problems = [];
const notes = [];
const fail = (message) => problems.push(message);
const note = (message) => notes.push(message);

function isFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

function isDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function checkUnknownKeys(allowed, value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  const set = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!set.has(key)) fail(`${path} 出现未知字段 "${key}"（允许：${allowed.join(', ')}）`);
  }
}

function checkPaths(value, path) {
  if (typeof value === 'string') {
    if (value.startsWith('/') || value.includes('..') || value.includes('\\') || value.includes('//')) {
      fail(`${path} 路径不合法：${value}`);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) checkPaths(value[key], `${path}.${key}`);
  }
}

function readZip(file) {
  const buffer = readFileSync(file);
  let eocd = -1;
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：找不到 EOCD 记录');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('zip 中央目录记录损坏');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.slice(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.slice(start, start + compressedSize);
    files.set(name, method === 0 ? raw : inflateRawSync(raw));
  }
  return files;
}

function expandArg(argument) {
  if (argument && !argument.includes('*')) return [argument];
  const pattern = argument || 'dist/*.dbxp';
  const folder = dirname(pattern) || '.';
  const suffix = basename(pattern).replace('*', '');
  if (!isDirectory(folder)) return [];
  return readdirSync(folder).filter((name) => name.endsWith(suffix)).map((name) => join(folder, name));
}

function verifyManifest(manifest, label) {
  checkUnknownKeys(TOP_LEVEL, manifest, `${label}`);
  checkUnknownKeys(ENGINES_KEYS, manifest.engines, `${label}.engines`);
  checkUnknownKeys(ENTRYPOINT_KEYS, manifest.entrypoints, `${label}.entrypoints`);
  if (manifest.entrypoints && manifest.entrypoints.ui) {
    checkUnknownKeys(UI_ENTRY_KEYS, manifest.entrypoints.ui, `${label}.entrypoints.ui`);
    if (manifest.entrypoints.ui.root !== 'ui' || manifest.entrypoints.ui.entry !== 'ui/index.html') {
      fail(`${label}.entrypoints.ui 必须是 { root: "ui", entry: "ui/index.html" }`);
    }
  }
  if (manifest.entrypoints && manifest.entrypoints.backend) {
    fail(`${label} 不应声明 backend 入口（纯前端插件）`);
  }
  if (!/^>=0\.6\.21$/.test(String((manifest.engines || {}).dbx || ''))) {
    fail(`${label}.engines.dbx 必须 >=0.6.21`);
  }
  if ((manifest.engines || {}).host_api !== '1') fail(`${label}.engines.host_api 必须为 "1"`);
  if (JSON.stringify(manifest.permissions) !== JSON.stringify(['host.storage'])) {
    fail(`${label}.permissions 必须精确等于 ["host.storage"]`);
  }
  for (const permission of manifest.permissions || []) {
    if (FORBIDDEN_PERMISSIONS.includes(permission) || permission.startsWith('host.network:')) {
      fail(`${label} 声明了被禁止的权限 ${permission}`);
    }
  }
  checkPaths(manifest.icon, `${label}.icon`);

  const contributions = manifest.contributions || [];
  const localizable = new Set();
  for (const contribution of contributions) {
    const allowed = CONTRIBUTION_COMMON.concat(CONTRIBUTION_EXTRA[contribution.type] || []);
    checkUnknownKeys(allowed, contribution, `${label}.contributions[${contribution.id}]`);
    if (contribution.type !== 'menus') localizable.add(contribution.id);
    if (contribution.type === 'menus') {
      for (const key of ['label', 'description', 'icon']) {
        if (key in contribution) fail(`${label} 的 menus 贡献点不允许字段 ${key}`);
      }
      for (const item of contribution.items || []) {
        checkUnknownKeys(MENU_ITEM_KEYS, item, `${label}.menus.item`);
        for (const required of ['location', 'command', 'group', 'order']) {
          if (!(required in item)) fail(`${label}.menus.item 缺必填字段 ${required}`);
        }
      }
    }
    if (contribution.type === 'command') {
      checkUnknownKeys(ACTION_KEYS, contribution.action, `${label}.command.action`);
      if (contribution.action && contribution.action.presentation !== 'tab') {
        fail(`${label}.command.action.presentation 必须是字符串 "tab"`);
      }
    }
  }
  const loc = manifest.localizations || {};
  for (const locale of Object.keys(loc)) {
    checkUnknownKeys(LOCALIZATION_KEYS, loc[locale], `${label}.localizations.${locale}`);
    const entries = (loc[locale] || {}).contributions || {};
    for (const id of Object.keys(entries)) {
      if (!localizable.has(id)) fail(`${label}.localizations.${locale} 出现死条目 ${id}`);
      checkUnknownKeys(['label', 'description'], entries[id], `${label}.localizations.${locale}.${id}`);
    }
  }
}

function verifyProvenanceText(name, text) {
  for (const [number, line] of text.split('\n').entries()) {
    const where = `${name}:${number + 1}`;
    if (name === 'manifest.json' && /^\s*"(?:source|homepage)"\s*:/.test(line)) continue;
    if (line.includes('github.com/')) fail(`${where} 包内出现仓库链接`);
    if (LOCAL_PATH.test(line)) fail(`${where} 包内出现本机绝对路径`);
    if (BORROW.test(line)) fail(`${where} 包内出现借鉴措辞`);
    REPO_REF.lastIndex = 0;
    let match;
    while ((match = REPO_REF.exec(line)) !== null) {
      const [token, left, right] = [match[0], match[1], match[2]];
      if (PATH_PREFIXES.has(left) || FILE_SUFFIXES.some((suffix) => right.endsWith(suffix)) || IGNORE_REFS.has(token)) continue;
      if (right.length <= 2 || right === right.toUpperCase() || (right.length <= 3 && right === right.toLowerCase())) continue;
      fail(`${where} 包内出现 owner/repo 形态标识 ${token}`);
    }
  }
}

function verifyPackageText(name, buffer) {
  if (!TEXT_EXTENSIONS.some((suffix) => name.toLowerCase().endsWith(suffix))) return;
  const text = buffer.toString('utf8');
  verifyProvenanceText(name, text);
  if (name.endsWith('.js') || name.endsWith('.html')) {
    const code = stripComments(text);
    for (const api of FORBIDDEN_APIS) {
      if (code.includes(api)) fail(`${name} 使用了禁用 API ${api}`);
    }
    for (const api of ['alert(', 'confirm(', 'prompt(', 'innerHTML', 'fetch(', 'XMLHttpRequest']) {
      if (code.includes(api)) fail(`${name} 使用了禁用 API ${api}`);
    }
    for (const pkg of ['cronstrue', 'cron-parser', 'croner']) {
      if (code.includes(pkg) && name !== 'ui/snippets.js') fail(`${name} 出现差分测试包名 ${pkg}`);
    }
  }
}

function verifyRepository(manifest) {
  const license = resolve('LICENSE');
  if (!isFile(license) || readFileSync(license).length < 1000) fail('仓库根缺少 LICENSE 全文');
  const notesPath = resolve('RELEASE_NOTES.md');
  if (!isFile(notesPath)) {
    fail('缺少 RELEASE_NOTES.md');
  } else {
    const first = readFileSync(notesPath, 'utf8').split('\n')[0].trim();
    if (!first.includes(manifest.version)) fail(`RELEASE_NOTES.md 首行应含版本 ${manifest.version}`);
  }
  const storePath = resolve('.dbx-store.json');
  if (!isFile(storePath)) {
    fail('缺少 .dbx-store.json');
  } else {
    const store = JSON.parse(readFileSync(storePath, 'utf8'));
    for (const key of ['name', 'description']) {
      if (store[key] !== manifest[key]) fail(`.dbx-store.json 的 ${key} 与 manifest 不一致`);
    }
    if (JSON.stringify(store.permissions) !== JSON.stringify(manifest.permissions)) {
      fail('.dbx-store.json 的 permissions 与 manifest 不一致');
    }
  }
  const toml = resolve('dbx-plugin.toml');
  if (!isFile(toml)) fail('缺少 dbx-plugin.toml');
  else {
    const text = readFileSync(toml, 'utf8');
    if (!/include\s*=\s*\["assets",\s*"ui"\]/.test(text)) fail('dbx-plugin.toml 的 include 必须只有 assets 与 ui');
    if (/\[backend\]/.test(text)) fail('dbx-plugin.toml 不应有 [backend] 段');
  }
}

function main() {
  const packages = expandArg(process.argv[2]);
  if (!packages.length) {
    console.error('没有找到 .dbxp，先跑 dbx-plugin package .');
    process.exit(1);
  }
  const sourcePath = resolve('manifest.json');
  if (!isFile(sourcePath)) {
    fail('仓库根缺少 manifest.json');
  } else {
    const manifest = JSON.parse(readFileSync(sourcePath, 'utf8'));
    verifyManifest(manifest, 'manifest');
    verifyRepository(manifest);
  }

  if (packages.length !== 1) fail(`纯前端应只产出 1 个包，实际 ${packages.length} 个`);
  for (const packagePath of packages) {
    console.log(`\n=== ${packagePath} ===`);
    let files;
    try { files = readZip(packagePath); }
    catch (error) { fail(`${packagePath} 解包失败：${error.message}`); continue; }
    const names = [...files.keys()].filter((name) => !name.endsWith('/'));

    const artifactPath = packagePath.replace(/\.dbxp$/, '.artifact.json');
    if (isFile(artifactPath)) {
      const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
      const bytes = readFileSync(packagePath);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (artifact.sha256 !== sha256) fail(`sha256 不符：实际 ${sha256}，记录 ${artifact.sha256}`);
      if (artifact.size !== bytes.length) fail(`size 不符：实际 ${bytes.length}，记录 ${artifact.size}`);
      if (artifact.url !== basename(packagePath)) fail(`artifact.url 与包名不一致：${artifact.url}`);
      if (artifact.target !== 'universal') fail(`artifact.target 必须是 universal，实际 ${artifact.target}`);
      if ('signingKeyId' in artifact) fail('.artifact.json 不得含 signingKeyId');
    } else {
      note(`没有找到 ${artifactPath}，跳过哈希校验`);
    }

    for (const name of names) {
      for (const banned of BANNED_ENTRIES) {
        if (banned.test(name)) fail(`包内出现禁止文件 ${name}`);
      }
      if (name.startsWith('/') || name.includes('..') || name.includes('\\') || name.includes('//')) {
        fail(`包内路径不合法 ${name}`);
      }
      if (name === 'signature.json') fail('包内不得有 signature.json（候选包必须未签名）');
      verifyPackageText(name, files.get(name));
    }

    const manifestName = names.find((name) => name === 'manifest.json' || name.endsWith('/manifest.json'));
    if (!manifestName) {
      fail('包内缺少 manifest.json');
    } else {
      const inner = JSON.parse(files.get(manifestName).toString('utf8'));
      verifyManifest(inner, '包内 manifest');
      note(`包内 ${names.length} 个文件`);
    }
    if (!names.includes('ui/index.html')) fail('包内缺少 ui/index.html');
    if (!names.includes('assets/plugin.svg')) fail('包内缺少 assets/plugin.svg');
  }

  for (const item of notes) console.log('OK  ' + item);
  if (problems.length) {
    for (const item of problems) console.log('FAIL ' + item);
    console.log(`\n${problems.length} 处问题`);
    process.exit(1);
  }
  console.log('\n包结构闸门全部通过');
}

main();
