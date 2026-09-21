/**
 * 服务端跨模块共享常量（单源）。
 */

/**
 * 「未配置真实 API Key」的占位符哨兵。
 *
 * 语义 = **从未配过 key**（seed 在无 DS_KEY 时把本值写进库），不是用户的选择。
 * 故 key 自愈链认它、补它（`db/repository/agents.ts` 的 `upsertAgent` 条件补写与
 * `healPlaceholderApiKeys`）；而空串 `''` 是用户**显式清空**（= 停跑意图），
 * 任何自愈路径都不许碰——两者语义相反，勿混为一谈。
 *
 * ⚠️ 值是与**存量数据**的契约：库里既有的占位符行就是这个字面量，
 * 改这个值 = 存量行认不出来 = 自愈静默失效。守卫见 `constants.test.ts`。
 *
 * 消费方 4 处（本值单源，勿再散写字面量）：
 *   - `seed-data.ts::buildDemoAgents` 无 key 时写入
 *   - `execution/serial.ts::agentHasUsableApiKey` no-key 守卫
 *   - `llm/dsh.ts` / `llm/opencode.ts` 适配器占位符守卫（与本地认证哨兵 `'local'` 并列判断）
 */
export const PLACEHOLDER_API_KEY = 'sk-your-api-key-here'
