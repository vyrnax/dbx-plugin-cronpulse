# CronPulse 项目协作约定

本文件是本项目的工作约定，不进入发行包。所有改动都必须先跑通本文末尾的闸门清单。

## 1. 不可推翻的技术决定

- 纯前端、零运行时依赖、完全离线；发行形态是单个 `universal` `.dbxp`。
- `ui/` 一律传统 `<script>`，按 `index.html` 的加载顺序把导出挂到全局 `CP`（`window.CP = window.CP || {}`，每文件 `CP.cron = CP.cron || {}`）。不使用 ESM、不使用 `import()`、不引入框架与构建步骤。
- 核心引擎自研，只依据各方言官方规范；任何第三方调度库只出现在 `devDependencies` 与差分测试里，不进入发行代码。
- 方言差异只走 `ui/cron/dialect.js` 的访问器契约：`getFields()` / `fieldIndexOf()` / `allows()` / `dowBase()` / `dayMatch()` / `normalizeDow()` / `normalizeMonth()` / `macroTable()` / `stepForms()`。其它模块禁止裸方言字符串比较（`_domcheck.py` ⑨ 会判 FATAL）。新增方言 = 一个 spec + 一次 `register()`，不修改解析、校验、预测、描述、转换与构建器分支。
- 方言表以注册表 + 工厂函数实现，不用 class 继承；派生字段由 `fields` 计算，`selfCheck` 在模块加载时执行，矛盾 spec 立即抛错。
- 星期编号两套基准是唯一真源：Unix / Spring 为 `0-7`（0 与 7 都是周日），Quartz 为 `1-7`（1 是周日）。Spring 的 `5L` 等价于 Quartz 的 `6L`。
- `dom` / `dow` 同时受限时：Unix 取并集，Spring / Quartz 取交集且 Quartz 应恰有一个 `?`。
- 夏令时默认 `skip`（缺失时刻该日无命中），可切 `shift`（顺延到间隙末端）；秋季重复时刻取较早 UTC 实例；被跳过的调度点仍单独列一行灰字。
- 预览默认 10 条、可选 20 / 50、硬上限 200；向前扫描 5 年无命中即熔断；解析防抖 ≤ 120 ms，所有控件变化走同一条 `recompute()`。
- 身份固定：`id=com.vyrnax.cronpulse`、`publisher=vyrnax`、中文名 `Cron表达式生成器`、英文名 `CronPulse`、许可 Apache-2.0；最低宿主 `dbx >= 0.6.21`、`host_api = 1`；权限只有 `host.storage`。

## 2. 宿主与沙箱铁律

- `await window.dbxPlugin.ready` 之后才读 `locale` / `theme` / `capabilities`；`ready` 的 resolve 值不是 API。
- 沙箱是 opaque origin：禁用浏览器持久化 API；一切持久化走 `host.storage`，且必须先探 `capabilities.storage`。能力缺失时降级为内存态并给一次性提示，功能不缩水。单值 256 KiB、整库 1 MiB，写入前主动裁剪。
- 禁 `fetch` / `XMLHttpRequest` / CDN / `alert` / `confirm` / `prompt` / 对不可信内容用 `innerHTML`；提示一律自绘 toast 或 inline。
- 主题与语言跟随宿主：CSS 只用 `--color-*` / `--radius-*` / `--font-*`（含 `--font-mono` 与 `theme.editor.fontSize`）；监听 `dbx-plugin-env`，主题变化后重新 `getComputedStyle` 并整帧重绘 canvas，不缓存配色常量。
- 所有 DOM 取值经 `$()` 封装并允许返回 `null`，禁止对结果直接链式取属性（切页签后节点消失会连坐整页）。
- 单一 `t(key, params)` 文案出口，`ui/i18n.js` 是唯一文案源；`zh-CN` 与 `en` 键集合必须完全一致，其它 locale 回退 `en`。
- 前端文件 UTF-8 无 BOM、LF 行尾；中文落盘后做一次往返校验，杜绝乱码与替换字符。

## 3. 清单与发布链路

- manifest 每层 `additionalProperties: false`，多一个字段会在安装期整包被拒且只报第一个错；`menus` 贡献点只有 `type/id/items`，`menuItem` 必填 `location/command/group/order`；不为 `menus` 写本地化条目。
- `command` 的 `presentation` 是 `action` 对象内的字符串字段，不是贡献点顶层对象。
- `ui.entry` 写 `ui/index.html`（`ui.root` 为 `ui` 时不是 `index.html`）；路径全部相对包根，不含 `..`、反斜杠或重复斜杠。
- `dbx-plugin.toml` 无 `[backend]` 段，`[package].include` 只含 `assets` 与 `ui`。
- 官方 reusable workflow 必须 pin 到固定 commit，绝不写浮动或失效 ref；`build-matrix` 只有一个 `universal` 条目；`go-version` 与 `rust-toolchain` 传空串跳过原生工具链；CLI 版本 `0.1.9`。
- Release 必须非 draft、非 prerelease：预发布会被商店发现流程直接跳过。tag 白名单正则、tag 与 `manifest.version` 对齐、`GITHUB_REF` 守卫三项缺一不可。
- 元数据上传用 `find -name '*.artifact.json'`，禁止 bash glob（平铺 artifact + 未开 globstar 会展开成空，导致 Release 缺元数据）。
- 商店候选文件由 CI 从 run artifact 生成；`release-candidates.json` 必须下载到仓库外，否则工作树变脏，provenance 闸门失败。首个 Release 由 Actions 从 tag 构建，禁止上传本地产物。候选 PR 不含二进制、源码副本、私钥、未签名 URL 或伪造的 `verified`。
- 上架前 publisher 文件已存在，无需重复提交；商店目录文件与索引永不手工编辑；候选 PR 在签名前保持待签状态属正常。

## 4. 出处与措辞禁令

- 代码、注释、测试、fixture、错误文案、README、提交信息里，一律不得出现任何第三方开源仓库的可识别信息：仓库名、斜杠形式的仓库标识、作者名、本机克隆路径，以及涉及借鉴关系的措辞。只依据公开规范。
- 允许 `依据 Quartz 官方 CronExpression 规范`、`依据 crontab(5) 与 Vixie 语义`、`依据 Spring CronExpression 文档约定` 这类规范出处。
- 仓库链接与斜杠形式标识的白名单是封闭枚举，只有三处：manifest 的 `source` / `homepage`、README 顶部指向本插件仓库的链接、release.yml 中官方 reusable workflow 的 `uses:` 行。新增白名单需先改约定。
- README 不设「鸣谢 / 参考项目」章节。
- 提交信息：简体中文，`feat|fix|release|docs|chore:` 前缀 +「做了什么 —— 为什么」，例 `feat: 方言注册表与星期编号换算 —— 新增方言不再改分支逻辑`。
- `docs/` 与 `PLAN.md` 是本机资料，已由 `.gitignore` 排除，不进版本库、不进包。

## 5. 闸门清单（每次改动后依次跑通）

1. `node --test` —— 单测与差分测试（自动发现 `tests/*.test.mjs`），测试用 `tests/_loader.mjs` 以 `node:vm` 直接跑发行用同一份字节。
2. `python _domcheck.py` —— 十一项静态闸门：悬空属性访问、重复函数声明、关键 id、禁用 API、宿主桥接用法、i18n 双向覆盖、方言联动表、出处禁令、访问器契约、字典重复键、中文硬编码（字典与片段模板除外）。
3. `dbx-plugin package . --target universal --output-dir dist` —— 官方打包，产物是未签名候选。
4. `node _verify.mjs "dist/*.dbxp"` —— 解包一次报完所有结构、清单、权限、路径、版本与出处问题。
5. `node _storecandidate.mjs --allow-unverified` —— 仅本地冒烟，产物不可提交商店。
6. 手工验收：空 / 超长输入、未知时区、条数上限、深浅主题与自定义调色板、双语无残留硬编码、重复打开与切走再回来、缺失持久化能力、开发宿主与真实桌面宿主各跑一遍。前七项的可自动化部分由 `tests/robustness.test.mjs` 固化，真机复验仍须人工执行。

## 6. 生产化补充约定

- 输入硬上限 4096 字符：超出即截断并报 `INPUT_TOO_LONG`，不允许万级 token 拖垮解析、描述或时间预测。
- 启动时探测 `Intl.DateTimeFormat` 对固定时区的能力；缺失时下拉只暴露 UTC 并给一次性提示，引擎 formatter 逐级回退到无时区 formatter 再到纯 UTC 拆分，保证不崩。非法时区名仍一律 `BAD_TIMEZONE`，不静默回退。
- 主题 token 每次变化都重新注入；`theme.editor.fontSize` 与 `fontFamily` 分别落到 `--cp-editor-size` 与 `--cp-mono`，canvas 每次重绘都重新读 `getComputedStyle`，不缓存配色常量。
- `ui/i18n.js` 是唯一中英文案源；发行脚本（字典与片段模板除外）的字符串字面量不得出现中文，开发期异常消息用英文。字典键不得重复，两份字典键集合必须完全一致。
- 代码片段中的生态库名属于产品功能输出，只允许出现在 `ui/snippets.js` 的字符串模板里；注释、其余发行代码与包内文本仍受出处禁令约束。

## 7. 阶段状态

- 阶段 0 地基：本地完成（根文件、清单、UI 骨架、闸门、CI / Release，打包与 dev host 均通过），不 tag。
- 阶段 1 引擎与 MVP：本地代码与测试完成（`ui/cron/*` 全模块、27 条官方 fixture、库差分）；`v0.1.0` tag、CI Release 与商店候选流程属发布动作，按当前约束未执行。
- 阶段 2 构建器与时间轴：本地完成（方言联动、分卡双向同步、canvas、错误定位、预设 chips）。
- 阶段 3 增值：本地完成（互转与兼容矩阵、代码片段、收藏与历史持久化）。
- 阶段 4 生产化：本地可自动化部分完成（文案复查、主题字体 token、异常兜底、健壮性测试、闸门扩至十一项）；真实桌面端手测与 `1.0.0` 上架待发布阶段执行。
