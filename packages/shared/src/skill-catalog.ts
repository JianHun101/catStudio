/**
 * 技能白名单与一句话目录 —— **单一真相源**。
 *
 * 消费者两个方向，都从这里取值：
 * - `scripts/mcp-server-utils.mjs`（MCP server 进程：`read_skill` 白名单强校验 +
 *   描述文案）——静态 import 本文件，靠 Node 原生类型剥离（纯 `export const` 可擦除）；
 * - `packages/server`（发现面注入：技能目录段拼进 system prompt）——经
 *   `@cat-study/shared` 门面 re-export 取用。
 *
 * 本文件**必须保持零 import 的叶子**：`scripts/*.mjs` 走原生类型剥离直连本文件，
 * 不能经 `packages/shared/src/index.ts`——index 用 `export * from './types.js'` 这类
 * `.js` 说明符，plain node 不做 `.js` → `.ts` 重写，且 `schemas.js` 会拉进 zod。
 *
 * `SKILL_WHITELIST` 的判据是「猫可自取的技能正文范围」（访问约束），不是「流程链
 * 有哪些段」——两者此前恰好重合，加入 `design-taste-frontend` 后不再重合。
 *
 * **顺序即目录序**：下方 `SKILL_CATALOG` 由 `scripts/skills-gen-catalog.mjs` 按本白名单
 * 顺序生成，文案取自各 `skills/<name>/SKILL.md` 的 frontmatter（不再是手抄）。
 *
 * 前 9 条 = 流程链段（顺序即链序）：grilling/to-spec → spec-gate →
 * to-tickets → implement → quality-gate → request-review → receive-review，外加会话压缩
 * session-handoff（目录由交付单 B 从 handoff 重命名落地——清单先行，readSkill 读缺返回
 * 错误文本）。request-review 于 2026-09-10 回流（ADR 0014 §5 修订：post-commit hook 不再
 * 机械投递，请求审查改由 Agent 自行发起；范围收窄——技能正文零路由，递送语义仍归状态机
 * FLOW_MAIN_CHAIN，见 execution/flow-state.ts）。
 *
 * 后 4 条 = 非流程链补充（判据只有「猫可自取范围」一条）：
 * - `wayfinder`——**排除口径翻转**：原按「disable-model-invocation 是设计」排除，与
 *   `skills/manifest.yaml` 头部与 `skills/BOOTSTRAP.md` 明写的「disable-model-invocation 是
 *   上游来源标记，本仓库不构成访问约束」自相矛盾（ADR 0014 §6 白名单判据重构：MCP 白名单 =
 *   访问约束 / 该字段 = 来源标记，两层互不代偿）。本次按后者落到实处，撤销排除——
 *   该字段只标记「上游不打算被模型自动唤起」，不构成本仓库的可读范围约束。
 * - `design-taste-frontend`——外部设计品味判据（`Leonxlnx/taste-skill` 逐字 vendor，
 *   provenance 见 `skills-lock.json`），供前端改动自查取用；与流程链无关。
 * - `writing-for-agents`——「为 agent 写文档」的元参考（上游 vendor，provenance 见
 *   `skills-lock.json`）：写/改技能正文、`AGENTS.md`、`CLAUDE.md` 时取用；与流程链无关。
 *   2026-09-21 纳入：该技能正文原本自己就带一处「猫读不到的兄弟文件指针」
 *   （`SKILL-MECHANICS.md`——`readSkill` 只读 `SKILL.md`），而它自己的判据写明这种情形
 *   正解是 inline；本条落地时把该兄弟文件并进 `SKILL.md`（见该目录）。
 * - `unslop`——去 AI 味判据（`cursor/plugins` 的 `pstack/skills/unslop` 中文翻译，
 *   provenance 见 `skills-lock.json`）：任何产出文本的改写自查取用；与流程链无关。
 */
export const SKILL_WHITELIST: readonly string[] = [
  'grilling',
  'to-spec',
  'spec-gate',
  'to-tickets',
  'implement',
  'quality-gate',
  'request-review',
  'receive-review',
  'session-handoff',
  'wayfinder',
  'design-taste-frontend',
  'writing-for-agents',
  'unslop',
]

/**
 * 技能名 → 一句话目录（read_skill 描述 + list_skills + system prompt 发现面共用同一本）。
 *
 * **下方标记块由 `scripts/skills-gen-catalog.mjs` 从 13 份 SKILL.md frontmatter 生成，
 * 勿手改**——改技能目录请改 `skills/<name>/SKILL.md` 的 description / triggers，再跑
 * `node scripts/skills-gen-catalog.mjs`。`--check` 是幂等门（漂移即红）。
 *
 * 生成值形态：`<是什么>｜何时：<Use when>｜触发：<triggers>`。frontmatter 是唯一源，
 * 本文件只保留白名单（人写）与生成块（机器写）。
 */
// ── BEGIN GENERATED SKILL_CATALOG（scripts/skills-gen-catalog.mjs 生成，勿手改；改 skills/<name>/SKILL.md 后重跑）
export const SKILL_CATALOG: Record<string, string> = {
  grilling:
    "压测计划/需求：用提问把粗糙计划压出可证伪需求理解｜何时：the user wants to stress-test a plan before building, or uses any 'grill' trigger phrases.｜触发：压测需求、质疑计划、层层追问、方案评审、需求澄清",
  'to-spec':
    '把 grilling 出的需求写成可证伪 spec｜何时：a requirement or a grilled plan needs to be written up as a spec before tickets are cut.｜触发：写成规格、整理需求、规格文档、需求落稿、归纳结论',
  'spec-gate':
    '需求进实施前的自查门（可证伪性/契约/验收，前半个门）｜何时：requirements or a spec is ready and needs a falsifiability + contract-lock check before tickets are cut or code is built.｜触发：需求自查、规格检查、开工前检查、可证伪性、契约锁定',
  'to-tickets':
    '把 spec 拆成工单｜何时：a spec or plan is settled and needs to be broken into tracer-bullet tickets with blocking edges.｜触发：拆票、工单拆分、任务切分、依赖排序、实施计划',
  implement:
    '按 spec/工单实施，产出满足验收的代码｜何时：the requirements are settled and the work is ready to build, ideally with a spec and one ticket in a fresh session.｜触发：按票实施、写代码、落地改动、执行工单、编码实现',
  'quality-gate':
    '代码提交审查前的自查门（后半个门）｜何时：a code change is finished and needs a self-check before review.｜触发：提交前自查、质量门、代码检查、审查前检查、完成度核对',
  'request-review':
    '发起审查请求前的门槛与轮次规则（BLOCKED 六条 / 同型 audit / ≥3 轮升级）｜何时：a code change has passed self-check and you are about to request review.｜触发：发起审查、请求审查、审查门槛、提交审查、轮次规则',
  'receive-review':
    "接收并处理审查反馈（P1/P2/P3 分类）｜何时：another agent's review feedback arrives after a code review.｜触发：处理反馈、审查反馈、返工、修复确认、逐项回应",
  'session-handoff':
    '会话压缩交接（跨会话把上下文传给下一棒）｜何时：work crosses sessions, another agent needs your context, or you are handing a task to a fresh session.｜触发：会话交接、上下文压缩、交接文档、换会话、任务转交',
  wayfinder:
    '大块模糊工作先起图：勘察拆票成共享地图，逐票收敛到路径清晰｜何时：a chunk of work is too large for one agent session and the route to the destination is still foggy.｜触发：模糊需求、大块工作、勘察拆票、路线图、逐票收敛',
  'design-taste-frontend':
    '前端设计品味判据（排版/间距/动效/状态/AI-tells/pre-flight，外部 vendor）｜何时：building or redesigning a landing page, portfolio, or visual frontend and the result must not look templated.｜触发：前端设计、界面品味、视觉打磨、排版间距、改版评审',
  'writing-for-agents':
    '为 agent 写文档的元参考（指针措辞/信息层级/剪枝；写技能与 AGENTS.md 时取用）｜何时：creating or editing a skill, or modifying AGENTS.md or CLAUDE.md.｜触发：写给智能体、文档规范、技能编写、指针措辞、信息层级',
  unslop:
    '去 AI 味判据（AI 痕迹清单/改写自查；任何产出文本取用，外部 vendor 中文翻译）｜何时：any text is about to be delivered and must be checked for AI writing tells. Must always apply.｜触发：去 AI 味、文本改写、痕迹清理、自然表达、润色',
}
// ── END GENERATED SKILL_CATALOG
