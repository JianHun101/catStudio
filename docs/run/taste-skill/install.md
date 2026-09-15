# taste skill 安装（票 A · flash猫）

> 状态：票 A 已收口（PR #80 → dev `d192df9`）。§3 豁免**已获店长裁决批准**，§7.2 空口径**已随票 C 清除**——本档为在飞留痕，口径已上浮 `skills/BOOTSTRAP.md`「同步溯源」。

## 0. 结论

- 本仓此前**没有** taste skill（`skills/` 28 目录无 taste；上游 `mattpocock/skills` 全树也没有）——店长侦察结论复现一致。
- 来源 = 第三方仓 `Leonxlnx/taste-skill` 的 `skills/taste-skill/SKILL.md`，**逐字 vendor** 到 `skills/design-taste-frontend/SKILL.md`（目录名/前端名保持上游 `design-taste-frontend`，未动 frontmatter）。
- 白名单常量 `FLOW_CHAIN_SKILLS` → **`SKILL_WHITELIST`**，加 `wayfinder` + `design-taste-frontend` 两条目；同步 `SKILL_CATALOG`（两处键必须一致，有冻结用例钉住）。
- **装完不用重启**：MCP server 每次执行 spawn，取会话 worktree 的 `scripts/mcp-server.mjs`，白名单改动下一次执行即生效；影响面仅本会话。

## 1. 来源与版本锚点

| 项                 | 值                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 仓库               | `https://github.com/Leonxlnx/taste-skill`                                                                                    |
| commit             | `ccbc15639c97057cbfcf32ecebc38ef716e4bb37`（2026-08-24，`docs: refine Kimi feature and sponsor layout (#102)`）              |
| 上游路径           | `skills/taste-skill/SKILL.md`                                                                                                |
| 本仓落点           | `skills/design-taste-frontend/SKILL.md`                                                                                      |
| frontmatter `name` | `design-taste-frontend`（== 目录名，满足三方一致校验硬要求）                                                                 |
| 许可证             | 店长口径称 MIT；**本单未独立核验**——探针 clone 是 blob:none 部分克隆，`git show HEAD:LICENSE` 需回源拉取而当前无网。留 §7 OQ |

- 该仓 `skills/` 下另有 `taste-skill-v1/`、`gpt-tasteskill/`，**未取**——本单只取店长点名的 `taste-skill/SKILL.md`。
- vendor 文件内零 `refs/*.md` 引用（不影响 `mcp-server.test.js` 的 F1「引用 ref 零路由」枚举面）。

## 2. vendor 口径与 sha256 读数

口径 = **LF 内容逐字节一致**（与 `skills-lock.json` 既有 20 条同口径：hash 取「按 LF 的内容」的 sha256）。

```
上游  git -C <probe> show HEAD:skills/taste-skill/SKILL.md | sha256sum
      aa194351b246b8b4799099d4ed7b033d29eab6e6e3d58d8d2172978be7b3ec89  -
本仓  sha256sum skills/design-taste-frontend/SKILL.md
      aa194351b246b8b4799099d4ed7b033d29eab6e6e3d58d8d2172978be7b3ec89  skills/design-taste-frontend/SKILL.md
```

**两侧一致**；`1206` 行 / `87253` 字节。落盘方式为 `git show … > 文件`（不经编辑器、不做换行/编码转换）。

`skills-lock.json` 新增条目（§5）的 `computedHash` 即上述读数，`source: Leonxlnx/taste-skill`、`skillPath: skills/taste-skill/SKILL.md`。

## 3. ⚠️ 出派活单文件清单的改动：`.prettierignore` 加一行（需店长裁决）

### 事实

1. `.lintstagedrc` 首条是 `"*": "prettier --ignore-unknown --write"`。
2. `node_modules/lint-staged/lib/matchFiles.js:16` 是 `matchBase: !pattern.includes('/')`——`"*"` 不含 `/` ⇒ `matchBase: true` ⇒ **匹配任意层级 basename**，`skills/**/*.md` 同样被扫。这不是推测，是 lint-staged 17.0.8 的源码行为。
3. **上游 taste 正文不是 prettier 不动点**：实测 `prettier` 3.9.5 对该文件产出 `934` 行差异（表格对齐、`*` 列表符 → `-`、`*强调*` → `_强调_`、补空行），产出 sha256 = `a7194e24…` ≠ 上游 `aa194351…`。
4. 既有 27 个技能全是 prettier 不动点（`prettier(LF 化当前文件) == git blob` 对 tdd/grilling/code-review 逐条成立），所以本仓**从没遇到过**这个冲突——`skills-lock.json` 的 `hashSemantics` 早就写了「vendor 内容可能因 prettier 归一化而与上游不同」，但那是一条**从未被触发的**预案。

⇒ 若放任钩子跑，提交进去的内容**必然**不等于上游，票单验收「vendor 文件与上游同口径 sha256 一致」直接不成立。

### 处置

`.prettierignore` 追加（第 5–9 行）：

```
# 逐字 vendor 的外部技能正文（上游镜像目录）：prettier 会重排 markdown 表层
# （表格对齐 / `*` 列表符 → `-` / `*强调*` → `_强调_` / 补空行），使内容与上游不再
# 逐字节一致——而本仓对该目录的验收判据正是「与上游 sha256 一致」。
# 故本目录不由本仓格式化；要改内容请改上游后重新 vendor（口径见 docs/run/taste-skill/install.md）。
skills/design-taste-frontend/
```

实测豁免生效：`prettier --ignore-unknown --write skills/design-taste-frontend/SKILL.md` 后 sha256 **仍是** `aa194351…`。

### 为什么先斩后奏

- 这是**唯一**能让票单验收成立的做法：另一条路是接受 prettier 归一化，那要改写验收口径（改成「与 prettier(上游) 一致」），两者只能二选一，没有第三条。
- 选择「保住字面验收」而非「保住既有格式化惯例」，因为「逐字 vendor」是店长在票单里写了两次的判据（`逐字落盘`＋`sha256 一致`）。
- 影响面**恰好等于本单新增的那个目录**：`skills/design-taste-frontend/` 是本单新建，ignore 它不改变任何既有文件的格式化行为；其余 27 个技能不进 ignore，惯例不变。
- **可逆**：删掉这 5 行 + 重跑 prettier + 更新 lock 里的 `computedHash`，一步回退。
- 归类上不属于「跨组件边界/共享层」的越界：本单本来就改了 `scripts/mcp-server-utils.mjs`、`skills/manifest.yaml` 这类仓库治理文件，`.prettierignore` 与它们同类。

**若店长否决**：改走「归一化」口径——删 ignore 行 → `prettier --write` → lock 的 `computedHash` 改 `a7194e24…`（= prettier(上游) 的 sha256，仍是「同口径」意义上的可对账值）→ 本档 §2 口径改写。

### 裁决（已落）

**店长批准豁免**，且独立复现判据（绕开本仓 ignore，走 `prettier --stdin-filepath`）：产出 `a7194e24…` ≠ 上游原文 `aa194351…`，确认上游正文**不是** prettier 不动点。裁决理由：**判据面必须与被判面同面**——验收判据是「与上游逐字节一致」，存储面就不能再过格式化器；否则等于把「与上游一致」降级成「与 prettier(上游) 一致」，日后跟上游对账得先复现**我们的** prettier 版本 + 配置，成本从一条 `sha256sum` 涨成「跑 prettier 3.9.5」。**不切归一化口径。**

**口径已上浮 `skills/BOOTSTRAP.md`「同步溯源」**（持久约定：逐字 vendor 的外部技能正文目录必须进 `.prettierignore`）。本档不再是口径载体——`docs/run/` 活收口即清，把口径挂在注定被清的档上必烂（这正是 §7.1 的成因）。

## 4. 白名单改名 + 两条目（含 wayfinder 口径翻转）

`scripts/mcp-server-utils.mjs`：

- `FLOW_CHAIN_SKILLS` → **`SKILL_WHITELIST`**（第 271 行）。改名理由：该清单的判据是「猫可自取的技能正文范围（访问约束）」，不是「流程链有哪些段」——两者此前恰好重合，加 `design-taste-frontend` 后不再重合，旧名名不副实。
- 新增两条目（第 281–282 行）：`wayfinder`、`design-taste-frontend`；`SKILL_CATALOG`（第 286 行）同步补两条一句话说明（第 296–298 行）——`Object.keys(SKILL_CATALOG)` 必须逐项等于 `SKILL_WHITELIST`，有冻结用例。
- **wayfinder 排除口径翻转的依据**：原注释写「wayfinder 排除（disable-model-invocation 是设计）」，但 `skills/manifest.yaml` 头部与 `skills/BOOTSTRAP.md` 都明写「`disable-model-invocation` 是上游来源标记，本仓库不构成访问约束」（ADR 0014 §6 白名单判据重构：MCP 白名单 = 访问约束 / 该字段 = 来源标记，两层互不代偿）。**同一份仓库里两个相反口径**，本次统一到后者，撤销排除。新注释已把这条依据写进代码（第 246–270 行）。
- 连带把 `read_skill`/`list_skills` 与 `validateReadSkillParams` 的文案从「流程链」改成「技能白名单」（**旧名在 `scripts/` 与 `packages/` 下已 grep 归零**，故注释里也不复写旧常量名，只留「旧名见 git 历史」）。

`scripts/mcp-server.test.js` 跟改：

- 冻结数组 `SKILL_WHITELIST` 定死 **11** 条（第 654 行起），**删掉 `expect(...).not.toContain('wayfinder')`**，改为正向 `toContain('wayfinder')` + `toContain('design-taste-frontend')`，并把口径翻转的理由写在断言旁。
- 反例集（第 481 行）原含 `wayfinder`，现已是白名单成员 ⇒ 移除，改以 `prototype` 补位（`code-review`/`tdd` 仍在）。
- 其余 `FLOW_CHAIN_SKILLS` 引用（导入、全放行用例、铁律 token 用例、listSkills 用例）随名改；无逻辑变化。

## 5. 改动文件清单

| 文件                                    | 改动                                                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `skills/design-taste-frontend/SKILL.md` | 新增（逐字 vendor，§2）                                                                                                      |
| `skills/manifest.yaml:255`              | 新增条目 `source: external` / `category: '外部技能'`，**不声明 use_when/not_for**（走新 skill 准入语义）；上方加一行来源注释 |
| `skills-lock.json:16`                   | 新增条目（source / sourceType / skillPath / computedHash）                                                                   |
| `skills/BOOTSTRAP.md:19,43,45,48`       | 计数 27→28 顶级、external 8→9；清单加名；加来源说明行                                                                        |
| `scripts/mcp-server-utils.mjs`          | 常量改名 + 两条目 + 注释重写（§4）                                                                                           |
| `scripts/mcp-server.test.js`            | 冻结数组/反例集/引用随改（§4）                                                                                               |
| `.prettierignore:5-9`                   | 新增豁免（**§3，需裁决**）                                                                                                   |
| `docs/run/taste-skill/install.md`       | 本档                                                                                                                         |

未动：`skills/design-taste-frontend/SKILL.md` 的上游 frontmatter（含 `name`）；其余 27 个技能；`packages/**` 任何代码。

## 6. 验收读数

| 验收项                                          | 读数                                                                                                 | 结果 |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---- |
| `node scripts/skills-check-manifest.mjs`        | `28/28 全覆盖，frontmatter 全部合法，source 标记全部有效，use_when/not_for 一致性 23/23`，exit **0** | ✅   |
| `node scripts/skills-check-mount.mjs --check`   | `⏸️ 挂载位不存在（CI/新机器属预期）` → `✅ 幂等跳过（28 个 skill 仅单源校验）`，exit **0**           | ✅   |
| `pnpm test`                                     | `Test Files 116 passed (116) / Tests 2346 passed (2346)`，exit **0**                                 | ✅   |
| `pnpm lint`                                     | `✅ 类型检查通过（3 个包）`，exit **0**                                                              | ✅   |
| `grep -rn FLOW_CHAIN_SKILLS scripts/ packages/` | 无命中（exit 1）                                                                                     | ✅   |
| vendor sha256 与上游一致                        | 两侧均 `aa194351…7b3ec89`                                                                            | ✅   |
| prettier 不动 vendor 文件                       | `--write` 后 sha256 不变                                                                             | ✅   |

## 7. 观察项 / OQ（非阻塞，交店长裁）

1. **[已裁 · 批准豁免]** `.prettierignore` 一行 —— 详见 §3「裁决（已落）」；口径已上浮 `skills/BOOTSTRAP.md`「同步溯源」。
2. **[已裁 · 删句] `skills/.sync-provenance.json` 是个空口径** —— 改前 `BOOTSTRAP.md:61/63` 写「同步来源/版本记录在 `skills/.sync-provenance.json`」＋「无来源登记 → `skills-check-manifest.mjs` 红示拦截」，但实测两者都不存在：① `skills-check-manifest.mjs` 只校验 `source` 取值合法性，**没有任何** provenance 校验代码；② 该 json 文件不存在，全仓 `grep sync-provenance` 只命中 `.gitignore:13` 与 BOOTSTRAP 自身，**没有生成器**。**店长裁决：不建生成器、不建校验器**——lock 已提供 `source`/`skillPath`/`computedHash` 可对账记录，再引一套运行时 json 就是造出第二个真相源（两份漂移后没有裁决依据）；真要准入闸，正确形态是「check-manifest 校验 lock 条目完整性」，属另一票。已随票 C 删除 BOOTSTRAP 两句、同口径改 `manifest.yaml:12`、删 `.gitignore:13` 占位行——「准入无自动拦截」成为**明示现状**，靠审查人比对 lock 条目。**本档是全仓唯一保留 `sync-provenance` 字样的地方**，它记载的正是该缺口本身。
3. **许可证未核验** —— §1；如需确证，联网后 `git -C <probe> show HEAD:LICENSE`（或换完整克隆）即可，一次命令的事。
4. **上游 §0 适配风险留给票 B** —— 正文首行自述「Not dashboards, not data tables, not multi-step product UI」，而评估页/设置页正是产品 UI；harness 假设 React/Tailwind/Motion，本仓是 Vue3 + 手写 CSS。票 B 的「判据适用性映射」是正解，本档不重复论证。
