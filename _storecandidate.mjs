#!/usr/bin/env node
/**
 * 生成商店扁平候选文件。无侧车二进制可核对，provenance 闸门改为：
 * HEAD == tag 指向的 commit，且工作树干净；CI 中另校验 GITHUB_REF。
 *
 * 用法：
 *   node _storecandidate.mjs --from <release-candidates.json> --repo <owner>/<name> --tag v0.1.0 --out <dir>
 *   node _storecandidate.mjs --allow-unverified   # 仅本地冒烟，产物不可提交商店
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FALLBACK_REPO = 'vyrnax/dbx-plugin-cronpulse';
const ALLOWED_KEYS = ['schemaVersion', 'id', 'publisher', 'version', 'name', 'description',
  'icon', 'tags', 'permissions', 'source', 'homepage', 'license', 'releaseNotes',
  'localizations', 'targets'];

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    const key = argv[index].slice(2);
    out[key] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
  }
  return out;
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function detectRepo(explicit) {
  if (explicit && explicit.includes('/')) return explicit;
  const url = git(['config', '--get', 'remote.origin.url']);
  const matched = /github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?$/.exec(url);
  return matched ? `${matched[1]}/${matched[2]}` : FALLBACK_REPO;
}

function checkProvenance(tag, allowUnverified) {
  const reasons = [];
  const head = git(['rev-parse', 'HEAD']);
  const dirty = git(['status', '--porcelain']);
  if (!head) reasons.push('不在 git 仓库中，无法证明字节来源');
  if (dirty) reasons.push('工作树不干净：' + dirty.split('\n').slice(0, 3).join(' | '));
  const tagCommit = tag ? git(['rev-list', '-n', '1', tag]) : '';
  if (tag && tagCommit && tagCommit !== head) reasons.push(`tag ${tag} 未指向 HEAD`);
  const inCI = process.env.CI === 'true' || !!process.env.GITHUB_ACTIONS;
  if (inCI && tag && process.env.GITHUB_REF !== `refs/tags/${tag}`) {
    reasons.push(`GITHUB_REF(${process.env.GITHUB_REF}) 不是 refs/tags/${tag}`);
  }
  const ok = reasons.length === 0;
  if (!ok && !allowUnverified) {
    console.error('provenance 闸门未通过：');
    for (const reason of reasons) console.error('  - ' + reason);
    process.exit(1);
  }
  return { ok, reasons, head };
}

function collectArtifacts(from) {
  const result = [];
  if (from && fs.existsSync(from)) {
    const payload = JSON.parse(fs.readFileSync(from, 'utf8'));
    const list = Array.isArray(payload) ? payload
      : Array.isArray(payload.artifacts) ? payload.artifacts : [];
    for (const item of list) {
      const meta = item.metadata || item.artifact || item;
      if (meta && meta.target) result.push(meta);
    }
  }
  if (result.length) return result;
  const dist = path.join(ROOT, 'dist');
  if (fs.existsSync(dist)) {
    for (const name of fs.readdirSync(dist).filter((n) => n.endsWith('.artifact.json'))) {
      result.push(JSON.parse(fs.readFileSync(path.join(dist, name), 'utf8')));
    }
  }
  return result;
}

function buildCandidate(manifest, store, repo, tag, artifacts) {
  const version = manifest.version;
  const urlFor = (file) => `https://github.com/${repo}/releases/download/${tag}/${file}`;
  const targets = artifacts.map((item) => ({
    target: item.target || 'universal',
    url: item.url && /^https:\/\//.test(item.url) ? item.url : urlFor(path.basename(item.url || item.file || `${manifest.id}-${version}-universal.dbxp`)),
    sha256: item.sha256 || '',
    size: item.size || 0
  }));
  if (!targets.length) {
    const file = `${manifest.id}-${version}-universal.dbxp`;
    const abs = path.join(ROOT, 'dist', file);
    const bytes = fs.existsSync(abs) ? fs.readFileSync(abs) : Buffer.alloc(0);
    targets.push({
      target: 'universal', url: urlFor(file),
      sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length
    });
  }
  const candidate = {
    schemaVersion: 1,
    id: manifest.id,
    publisher: manifest.publisher,
    version,
    name: manifest.name,
    description: manifest.description,
    tags: store.tags || [],
    permissions: manifest.permissions,
    source: manifest.source,
    homepage: manifest.homepage,
    license: store.license || 'Apache-2.0',
    releaseNotes: store.releaseNotes || '',
    targets
  };
  if (manifest.localizations) {
    candidate.localizations = {};
    for (const locale of Object.keys(manifest.localizations)) {
      const entry = manifest.localizations[locale];
      candidate.localizations[locale] = { name: entry.name, description: entry.description };
    }
  }
  return candidate;
}

function selfCheck(candidate) {
  const problems = [];
  for (const key of Object.keys(candidate)) {
    if (!ALLOWED_KEYS.includes(key)) problems.push(`未知字段 ${key}`);
  }
  if (!Array.isArray(candidate.targets) || candidate.targets.length !== 1) {
    problems.push('纯前端候选必须恰有 1 个 target');
  }
  for (const item of candidate.targets || []) {
    if (!/^[a-z0-9-]+$/.test(item.target)) problems.push(`target 不合法：${item.target}`);
    if (!/^https:\/\//.test(item.url)) problems.push('target.url 必须是绝对 HTTPS 地址');
    if (!/^[0-9a-f]{64}$/.test(item.sha256)) problems.push('target.sha256 缺失');
    if (!(item.size > 0)) problems.push('target.size 缺失');
  }
  if (JSON.stringify(candidate).includes('signingKeyId')) problems.push('候选不得含 signingKeyId');
  if (problems.length) {
    for (const problem of problems) console.error('FAIL ' + problem);
    process.exit(1);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const store = JSON.parse(fs.readFileSync(path.join(ROOT, '.dbx-store.json'), 'utf8'));
  const tag = args.tag || `v${manifest.version}`;
  const repo = detectRepo(args.repo);
  const provenance = checkProvenance(tag, !!args['allow-unverified']);
  const candidate = buildCandidate(manifest, store, repo, tag, collectArtifacts(args.from));
  selfCheck(candidate);
  const out = path.resolve(args.out || path.join(ROOT, 'dist', 'store-candidate'));
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `${manifest.id}.json`);
  fs.writeFileSync(file, JSON.stringify(candidate, null, 2) + '\n', 'utf8');
  console.log(`候选文件：${file}`);
  console.log(`target：${candidate.targets[0].target}  size：${candidate.targets[0].size}  sha256：${candidate.targets[0].sha256}`);
  console.log(`provenance：${provenance.ok ? 'verified' : 'UNVERIFIED（不可提交商店）'}`);
}

main();
