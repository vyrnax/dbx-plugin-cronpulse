#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""前端静态闸门：一次性报完所有问题。

检查项：
  ① 悬空属性访问（剥注释后扫描）
  ② 同名函数声明覆盖
  ③ 关键元素 id 清单
  ④ 禁用 API 出现即 FATAL
  ⑤ dbxPlugin 用法（await ready；不把 resolve 值当 API）
  ⑥ i18n 键双向覆盖（HTML + JS 引用必须在 zh-CN / en 两份字典都存在）
  ⑦ 方言联动表（字段卡数量与方言字段数一致）
  ⑧ 出处禁令扫描（封闭白名单）
  ⑨ 方言访问器契约（ui/ 内禁止裸方言字符串比较）
  ⑩ 错误码→文案（引擎每个 code 都需 msg.<code>，动态拼接键的静态盲区）

判据与 _verify.mjs 的「剥注释 + 禁用 API」规则保持一致，改一边必须改另一边。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = Path(__file__).resolve().parent
UI = BASE / "ui"
ROOT_FILES = ["manifest.json", "dbx-plugin.toml", "README.md", "RELEASE_NOTES.md", "AGENTS.md"]

FORBIDDEN_APIS = [
    "localStorage", "sessionStorage", "indexedDB", "document.cookie",
    "alert(", "confirm(", "prompt(", "innerHTML", "fetch(", "XMLHttpRequest",
]
DIFF_PACKAGES = ["cronstrue", "cron-parser", "croner"]
DIALECT_NAMES = ["unix", "spring", "quartz", "robfig", "nodecron"]

CRITICAL_IDS = [
    "app", "main", "statusbar", "toast",
    "expr-input", "summary-row", "summary-label", "dialect-hint", "sel-dialect", "sel-timezone",
    "sel-count", "sel-dst", "chk-year", "year-toggle-wrap", "tz-free",
    "status-dot", "status-text", "error-list", "builder", "field-cards",
    "card-sec", "card-min", "card-hour", "card-dom", "card-month", "card-dow", "card-year",
    "compare-bar", "tabs", "tab-describe", "tab-timeline", "tab-snippets",
    "view-describe", "view-timeline", "view-snippets", "timeline-list", "timeline-canvas",
    "preset-area",
]

problems: list[str] = []
notes: list[str] = []


def fail(message: str) -> None:
    problems.append(message)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def strip_js(source: str) -> str:
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    source = re.sub(r"<!--.*?-->", "", source, flags=re.S)
    source = re.sub(r"(^|[^:])//[^\n]*", r"\1", source)
    return source


def js_files() -> list[Path]:
    return sorted(p for p in UI.rglob("*.js") if p.is_file())


def html_live(html: str) -> str:
    return re.sub(r"<!--.*?-->", "", html, flags=re.S)


def check_encoding(path: Path) -> None:
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        fail(f"{path.relative_to(BASE)} 带 UTF-8 BOM")
    if b"\r\n" in raw:
        fail(f"{path.relative_to(BASE)} 含 CRLF 行尾（包内一律 LF）")
    try:
        raw.decode("utf-8")
    except UnicodeDecodeError:
        fail(f"{path.relative_to(BASE)} 不是合法 UTF-8")


def check_dom(html: str, sources: list[tuple[Path, str]]) -> None:
    live = html_live(html)
    declared = set(re.findall(r'\bid="([^"]+)"', live))
    referenced: set[str] = set()
    for path, source in sources:
        code = strip_js(source)
        referenced |= set(re.findall(r"""\$\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)""", code))
        referenced |= set(re.findall(r"""getElementById\(\s*['"]([^'"]+)['"]\s*\)""", code))
        referenced |= set(re.findall(r"""querySelector(?:All)?\(\s*['"]#([A-Za-z0-9_-]+)['"]""", code))
    for missing in sorted(referenced - declared):
        fail(f"JS 引用了 index.html 里不存在的 id：#{missing}")
    for missing in [key for key in CRITICAL_IDS if key not in declared]:
        fail(f"index.html 缺关键元素 #{missing}")
    notes.append(f"DOM：HTML 声明 {len(declared)} 个 id，JS 引用 {len(referenced)} 个，关键元素 {len(CRITICAL_IDS)} 项")


def check_dangling(html: str, sources: list[tuple[Path, str]]) -> None:
    declared = set(re.findall(r'\bid="([^"]+)"', html_live(html)))
    for path, source in sources:
        code = strip_js(source)
        for match in re.finditer(r"""\$\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)\s*\.""", code):
            if match.group(1) not in declared:
                line = code[: match.start()].count("\n") + 1
                fail(f"{path.relative_to(BASE)} 第 {line} 行：#{match.group(1)} 可能不存在却直接取属性")


def check_duplicates(sources: list[tuple[Path, str]]) -> None:
    for path, source in sources:
        code = strip_js(source)
        seen: dict[str, list[int]] = {}
        for match in re.finditer(r"^\s{2}function\s+([A-Za-z0-9_]+)\s*\(", code, flags=re.M):
            seen.setdefault(match.group(1), []).append(code[: match.start()].count("\n") + 1)
        for name, lines in seen.items():
            if len(lines) > 1:
                fail(f"{path.relative_to(BASE)} 同名函数 {name} 定义于 {lines}（后者覆盖前者）")


def check_forbidden(sources: list[tuple[Path, str]]) -> None:
    for path, source in sources:
        code = strip_js(source)
        for api in FORBIDDEN_APIS:
            if api in code:
                fail(f"{path.relative_to(BASE)} 使用了禁用 API {api}")
        rel = path.relative_to(BASE).as_posix()
        if rel != "ui/snippets.js":
            for package in DIFF_PACKAGES:
                if package in code:
                    fail(f"{rel} 出现差分测试包名 {package}（发行代码禁止）")
        else:
            comments = "\n".join(re.findall(r"//[^\n]*|/\*[\s\S]*?\*/", source))
            for package in DIFF_PACKAGES:
                if package in comments:
                    fail(f"{rel} 的注释里出现差分测试包名 {package}")


def check_bridge(sources: dict[str, str]) -> None:
    bridge = sources.get("ui/bridge.js", "")
    if "await host.ready" not in bridge and "await window.dbxPlugin.ready" not in bridge:
        fail("bridge.js 必须 await dbxPlugin.ready 之后才读 locale / theme / capabilities")
    if re.search(r"ready\s*\.\s*then\s*\(", strip_js(bridge)):
        fail("bridge.js 把 ready 的 resolve 值当 API 使用")
    for path, source in sources.items():
        if re.search(r"(?:const|let|var)\s+\w+\s*=\s*await\s+\w*\.?ready\b", strip_js(source)):
            fail(f"{path} 把 ready 的 resolve 值当 API 使用")


def locale_keys(i18n_source: str, tag: str) -> set[str] | None:
    match = re.search(r'["\']?%s["\']?\s*:\s*\{' % re.escape(tag), i18n_source)
    if not match:
        return None
    index, depth = match.end(), 1
    while index < len(i18n_source) and depth > 0:
        char = i18n_source[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
        index += 1
    block = i18n_source[match.end(): index - 1]
    return set(re.findall(r'^\s{6}"?([A-Za-z0-9_.]+)"?\s*:', block, flags=re.M))


def check_i18n(html: str, sources: list[tuple[Path, str]]) -> None:
    i18n_path = UI / "i18n.js"
    if not i18n_path.is_file():
        fail("缺少 ui/i18n.js")
        return
    i18n_source = strip_js(read(i18n_path))
    needed = set(re.findall(r'data-i18n(?:-placeholder)?="([^"]+)"', html_live(html)))
    for _, source in sources:
        needed |= set(re.findall(r"""\bt\(\s*["']([A-Za-z0-9_.]+)["']""", strip_js(source)))
    needed = {key for key in needed if not key.endswith(".")}
    zh = locale_keys(i18n_source, "zh-CN")
    en = locale_keys(i18n_source, "en")
    for tag, keys in (("zh-CN", zh), ("en", en)):
        if keys is None:
            fail(f"i18n.js 找不到 {tag} 语言块")
            continue
        missing = sorted(needed - keys)
        if missing:
            fail(f"i18n {tag} 缺 {len(missing)} 个键：{', '.join(missing[:12])}")
    if zh is not None and en is not None and zh != en:
        fail(f"i18n 两份字典键集合不一致：仅 zh-CN {sorted(zh - en)[:8]}；仅 en {sorted(en - zh)[:8]}")
    notes.append(f"i18n：HTML + t() 共引用 {len(needed)} 个键，两份字典均已覆盖")


def check_i18n_duplicates(source: str) -> None:
    for tag in ("zh-CN", "en"):
        match = re.search(r'["\']?%s["\']?\s*:\s*\{' % re.escape(tag), source)
        if not match:
            continue
        index, depth = match.end(), 1
        while index < len(source) and depth > 0:
            if source[index] == "{":
                depth += 1
            elif source[index] == "}":
                depth -= 1
            index += 1
        block = source[match.end(): index - 1]
        keys = re.findall(r'^\s{6}"?([A-Za-z0-9_.]+)"?\s*:', block, flags=re.M)
        counts: dict[str, int] = {}
        for key in keys:
            counts[key] = counts.get(key, 0) + 1
        duplicates = sorted(key for key, value in counts.items() if value > 1)
        if duplicates:
            fail(f"i18n {tag} 存在重复键：{', '.join(duplicates[:8])}")
        notes.append(f"i18n {tag} 共 {len(keys)} 个键，无重复")


def check_hardcoded_chinese(sources: list[tuple[Path, str]]) -> None:
    exempt = {"ui/i18n.js", "ui/snippets.js"}
    checked = 0
    for path, source in sources:
        rel = path.relative_to(BASE).as_posix()
        if rel in exempt or not rel.endswith(".js"):
            continue
        checked += 1
        code = strip_js(source)
        for match in re.finditer(r"""["']([^"']*)["']""", code):
            literal = match.group(1)
            if re.search(r"[\u4e00-\u9fff]", literal):
                fail(f"{rel} 出现硬编码中文字符串：{literal[:24]}（应走 t()）")
    notes.append(f"中文文案单一出口：扫描 {checked} 个发行脚本（字典与片段模板除外）")


def check_dialect_contract(html: str, sources: list[tuple[Path, str]]) -> None:
    cards = set(re.findall(r'\bid="card-([a-z]+)"', html_live(html)))
    for key in ["sec", "min", "hour", "dom", "month", "dow", "year"]:
        if key not in cards:
            fail(f"index.html 缺字段卡容器 #card-{key}")
    dialect = UI / "cron" / "dialect.js"
    if dialect.is_file():
        text = read(dialect)
        for name, expected in (("unix", 5), ("spring", 6), ("quartz", 7)):
            reg = re.search(r"register\(\{\s*name:\s*[\"']%s[\"'][\s\S]*?fields:\s*([A-Z_]+)" % name, text)
            if not reg:
                fail(f"dialect.js 找不到 {name} 档的 fields 定义")
                continue
            identifier = reg.group(1)
            arr = re.search(r"const\s+%s\s*=\s*\[([^\]]*)\]" % identifier, text)
            if not arr:
                fail(f"dialect.js 找不到字段常量 {identifier}")
                continue
            count = len([part for part in arr.group(1).split(",") if part.strip()])
            if text[reg.end(): reg.end() + 8].startswith(".concat"):
                count += 1
            notes.append(f"{name} 档字段数 {count}")
            if count != expected:
                fail(f"dialect.js 的 {name} 档字段数 {count} 应为 {expected}，与 UI 卡片数量不符")
    for path, source in sources:
        rel = path.relative_to(BASE).as_posix()
        if rel == "ui/cron/dialect.js":
            continue
        code = strip_js(source)
        for name in DIALECT_NAMES:
            if re.search(r"[!=]==?\s*[\"']%s[\"']" % name, code):
                fail(f"{rel} 出现裸方言字符串比较（{name}）；方言差异必须走访问器契约")


WHITELIST_LINES = [
    re.compile(r'^\s*"(?:source|homepage)"\s*:'),
    re.compile(r"^\[源码仓库\]\(https://github\.com/"),
    re.compile(r"^\s*uses:\s*\S*plugin-release-reusable\.yml@[0-9a-f]{40}\s*$"),
]
PATH_PREFIXES = {
    "ui", "assets", "tests", "docs", "dist", "node_modules", "src", "bin", "backend",
    "http:", "https:", "actions", "RUNNER_TEMP",
    "Asia", "America", "Europe", "Australia", "Pacific", "Africa", "Atlantic",
    "Indian", "Arctic", "Antarctica", "Etc",
}
FILE_SUFFIXES = (".js", ".css", ".html", ".json", ".svg", ".mjs", ".py", ".yml", ".yaml", ".md", ".toml", ".txt", ".dbxp")
IGNORE_REFS = {
    "Area/City", "MON/FRI", "SUN/SAT", "N/A", "n/a", "JS/TS", "Not/AZone",
    "Spring/Unix", "Unix/Spring", "assert/strict", "owner/repo", "cronstrue/locales",
    "actions/checkout", "actions/setup-node", "actions/setup-python",
    "actions/upload-artifact", "actions/download-artifact",
    "dbx-app/plugin-cli", "RUNNER_TEMP/store-candidate",
    "refs/tags", "refs/heads",
}
REPO_REF = re.compile(r"(?<![\w./-])([A-Za-z0-9][A-Za-z0-9_.-]*)/([A-Za-z0-9][A-Za-z0-9_.-]*)(?![\w/])")
BORROW = re.compile(r"(?:借鉴|参考自|移植自|clone\s*自|灵感来自|抄自|源自)[^\n]{0,60}?[A-Za-z][A-Za-z0-9._-]{2,}")
LOCAL_PATH = re.compile(r"(?<![A-Za-z0-9])[A-Za-z]:[\\/]|/Users/|/home/")


def scan_provenance(path: Path, text: str) -> None:
    rel = path.relative_to(BASE).as_posix()
    for number, line in enumerate(text.splitlines(), 1):
        if any(rule.match(line) for rule in WHITELIST_LINES):
            continue
        where = f"{rel}:{number}"
        if "github.com/" in line:
            fail(f"{where} 出现未列入白名单的仓库链接")
        if LOCAL_PATH.search(line):
            fail(f"{where} 出现本机绝对路径")
        if BORROW.search(line):
            fail(f"{where} 出现借鉴措辞 + 拉丁标识符")
        for match in REPO_REF.finditer(line):
            left, right, token = match.group(1), match.group(2), match.group(0)
            if left in PATH_PREFIXES or right.endswith(FILE_SUFFIXES) or token in IGNORE_REFS:
                continue
            if len(right) <= 2 or right.isupper() or (len(right) <= 3 and right.islower()):
                continue
            fail(f"{where} 出现 owner/repo 形态标识 {token}")


def check_error_codes(sources: list[tuple[Path, str]]) -> None:
    """⑩ 错误码→文案：引擎发出的每个 code 都必须在两份字典有 msg.<code>。

    错码文案 key 是动态拼接（msg. + code），静态的 i18n 引用扫描看不到；
    新增码忘补文案会把字面 key 泄露到界面。此项补齐该盲区。
    """
    patterns = [
        r'makeIssue\(\s*"([A-Z][A-Z0-9_]+)"',
        r'code:\s*"([A-Z][A-Z0-9_]+)"',
        r'error\s*=\s*"([A-Z][A-Z0-9_]+)"',
        r'unsupported\s*=\s*"([A-Z][A-Z0-9_]+)"',
    ]
    codes: set[str] = set()
    for path, source in sources:
        rel = path.relative_to(BASE).as_posix()
        if not rel.startswith("ui/cron/"):
            continue
        code_text = strip_js(source)
        for pattern in patterns:
            for match in re.finditer(pattern, code_text):
                codes.add(match.group(1))
    i18n_source = strip_js(read(UI / "i18n.js"))
    zh = locale_keys(i18n_source, "zh-CN")
    en = locale_keys(i18n_source, "en")
    missing = sorted(
        code for code in codes
        if (zh is None or "msg." + code not in zh) or (en is None or "msg." + code not in en)
    )
    for code in missing:
        fail(f"错误码 {code} 缺少 msg.{code} 文案键（会泄露字面 key 到界面）")
    notes.append(f"错误码文案：引擎 {len(codes)} 个码均已有 msg. 键" if not missing else f"错误码文案：引擎 {len(codes)} 个码")

def check_provenance() -> None:
    targets: list[Path] = []
    for folder in ["ui", "tests", "assets", ".github/workflows"]:
        base = BASE / folder
        if base.is_dir():
            targets += sorted(p for p in base.rglob("*") if p.is_file())
    for name in ROOT_FILES:
        path = BASE / name
        if path.is_file():
            targets.append(path)
    for path in targets:
        if path.suffix.lower() in {".png", ".jpg", ".dbxp", ".zip"}:
            continue
        try:
            scan_provenance(path, read(path))
        except UnicodeDecodeError:
            fail(f"{path.relative_to(BASE)} 不是 UTF-8 文本")
    notes.append(f"出处禁令：扫描 {len(targets)} 个文件")


def main() -> int:
    html_path = UI / "index.html"
    if not html_path.is_file():
        print("FAIL 缺少 ui/index.html")
        return 1
    html = read(html_path)
    sources = [(p, read(p)) for p in js_files()]
    by_rel = {p.relative_to(BASE).as_posix(): text for p, text in sources}

    for path in sorted(p for p in UI.rglob("*") if p.is_file() and p.suffix in {".js", ".css", ".html"}):
        check_encoding(path)

    check_dom(html, sources)
    check_dangling(html, sources)
    check_duplicates(sources)
    check_forbidden(sources)
    check_bridge(by_rel)
    check_i18n(html, sources)
    check_i18n_duplicates(strip_js(read(UI / "i18n.js")))
    check_hardcoded_chinese(sources)
    check_dialect_contract(html, sources)
    check_error_codes(sources)
    check_provenance()

    for note in notes:
        print("OK  " + note)
    if problems:
        for problem in problems:
            print("FAIL " + problem)
        print(f"\n{len(problems)} 处问题")
        return 1
    print("前端静态闸门全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
