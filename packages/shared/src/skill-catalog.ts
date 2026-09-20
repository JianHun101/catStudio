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
 * **顺序即目录序**，逐字照搬自 `scripts/mcp-server-utils.mjs`（2026-09-20 搬迁，
 * 零行为变化）。
 *
 * 前 9 条 = 流程链段（顺序即链序）：wayfinder 起图 → grilling/to-spec → spec-gate →
 * to-tickets → implement → quality-gate → request-review → receive-review，外加会话压缩
 * session-handoff（目录由交付单 B 从 handoff 重命名落地——清单先行，readSkill 读缺返回
 * 错误文本）。request-review 于 2026-09-10 回流（ADR 0014 §5 修订：post-commit hook 不再
 * 机械投递，请求审查改由 Agent 自行发起；范围收窄——技能正文零路由，递送语义仍归状态机
 * FLOW_MAIN_CHAIN，见 execution/flow-state.ts）。
 *
 * 后 2 条 = 非流程链补充（判据只有「猫可自取范围」一条）：
 * - `wayfinder`——**排除口径翻转**：原按「disable-model-invocation 是设计」排除，与
 *   `skills/manifest.yaml` 头部与 `skills/BOOTSTRAP.md` 明写的「disable-model-invocation 是
 *   上游来源标记，本仓库不构成访问约束」自相矛盾（ADR 0014 §6 白名单判据重构：MCP 白名单 =
 *   访问约束 / 该字段 = 来源标记，两层互不代偿）。本次按后者落到实处，撤销排除——
 *   该字段只标记「上游不打算被模型自动唤起」，不构成本仓库的可读范围约束。
 * - `design-taste-frontend`——外部设计品味判据（`Leonxlnx/taste-skill` 逐字 vendor，
 *   provenance 见 `skills-lock.json`），供前端改动自查取用；与流程链无关。
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
]

/** 技能名 → 一句话说明（catalog 清单，read_skill 描述 + list_skills 共用同一本）。 */
export const SKILL_CATALOG: Record<string, string> = {
  grilling: '压测计划/需求：用提问把粗糙计划压出可证伪需求理解',
  'to-spec': '把 grilling 出的需求写成可证伪 spec',
  'spec-gate': '需求进实施前的自查门（可证伪性/契约/验收，前半个门）',
  'to-tickets': '把 spec 拆成工单',
  implement: '按 spec/工单实施，产出满足验收的代码',
  'quality-gate': '代码提交审查前的自查门（后半个门）',
  'request-review': '发起审查请求前的门槛与轮次规则（BLOCKED 六条 / 同型 audit / ≥3 轮升级）',
  'receive-review': '接收并处理审查反馈（P1/P2/P3 分类）',
  'session-handoff': '会话压缩交接（跨会话把上下文传给下一棒）',
  wayfinder: '大块模糊工作先起图：勘察拆票成共享地图，逐票收敛到路径清晰',
  'design-taste-frontend':
    '前端设计品味判据（排版/间距/动效/状态/AI-tells/pre-flight，外部 vendor）',
}
