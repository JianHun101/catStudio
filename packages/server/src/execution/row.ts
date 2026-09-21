/**
 * Execution — DB row → 领域对象映射（第 3 刀从 socketio.ts 迁出，只搬不改）。
 *
 * 行映射收口（opencode 报告 #4：rowToAgent/toAgentConfig 近重复）另开单，
 * 本文件先承接既有 rowToAgent——connector/recovery/serial 三方共用。
 *
 * T-1 起另承接 `isAgentAuthoredTrigger`（`messages.role` → 触发者是不是猫）。它
 * 放这里的理由**不是**「属于行映射」，而是**本文件是叶**——只有两个 `import type`
 * （类型导入运行时擦除），任何模块 import 本文件都**不构成模块环**。
 * 该判据原在 `serial.ts`，被 `ingest.ts` 引用后当场闭合出两个环（`F1` 审查实测，
 * 父提交 0 环；**圈口径**，两条同属一个 5 节点强连通分量——计数单位见票单 §十）：
 * `serial→flow-advance→ingest→serial` 与
 * `worktree-fanin→ingest→serial→reply→worktree-fanin`。三个消费方
 * （`serial.ts` / `ingest.ts` / `recovery.ts`）本来就都在 import 本文件，搬过来
 * 一条新边都不用加，环全部消失（值导入边 310 → 回到 309）。
 * ⚠️ **绝对边数随检测器口径浮动，承重读数是增量**（F8 审查项）：同一棵树实测
 * 「排除 `*.test.ts`」= 309 / 310 条，「含 `*.test.ts`」= 640 / 647 条——两套口径
 * 都对，拿绝对数跟别人对的账必然对不上。要复现的是 **±1 的增量**（本笔 = −1）。
 * ⚠️ 别把它搬回 `serial.ts`，也别在本文件加**值导入**——叶属性是这次搬家的唯一
 * 依据，破了它环就会重新长出来（`pnpm lint` 只跑 tsc，没有环检测守卫）。
 */

import type { AgentConfig } from '@cat-study/shared'
import type { AgentRow } from '../db/repository/index.js'

/** DB row (snake_case) → AgentConfig (camelCase) */
export function rowToAgent(row: AgentRow): AgentConfig {
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    systemPrompt: row.system_prompt,
    llmProvider: row.llm_provider,
    llmModel: row.llm_model,
    llmApiKey: row.llm_api_key,
    llmBaseUrl: row.llm_base_url || undefined,
    effortLevel: (row.effort_level || undefined) as AgentConfig['effortLevel'],
    llmMaxTokens: row.llm_max_tokens, // 迁移 DEFAULT 2048 回填存量行；透传点据此决定是否传 ChatOptions.maxTokens
    llmTemperature: row.llm_temperature,
    llmEnvExtra: row.llm_env_extra, // 迁移 DEFAULT '{}' 回填存量行；registry 构造时宽容解析
    // 老库迁移默认 'unknown'（不在 AgentRole 里）——白名单对未知角色放行
    role: (row.role || undefined) as AgentConfig['role'],
  }
}

/**
 * 触发行是否由 agent 发出——**本判据在全仓只有这一处定义**（T-1）。
 *
 * 为什么不各处直接写 `role === 'agent'`：判据有**两个**真实构造点
 * （`serial.ts` 的 `buildTriggerMsg` 与 `drainQueuedCommand` 的 `queuedTrigger`
 * ——后者直接喂 `executeOneAgent`、**不经** `execute()`，故 reply 侧读到的就是
 * 它自己算的那一份），各写一份就是两份判据——今天同形，明天只改一处（例如把
 * `system` 通告也算进来）就悄悄分叉，而分叉的表现是「同一类触发，两条路径行为
 * 不同」，排查时没有任何报错指向它。
 *
 * 不认 `authorName`（被 `resolveRolePlaceholders` 复用，语义会漂）、不认 content
 * 里的 @（路由元数据答的是「要叫谁」，不是「谁在说」）。
 */
export function isAgentAuthoredTrigger(role: string | null | undefined): boolean {
  return role === 'agent'
}
