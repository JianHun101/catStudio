/**
 * 探针实例禁恢复开关（票 `docs/run/probe-no-resume/`）。
 *
 * ## 为什么需要它
 *
 * 真机自证的标准口径是「worktree 自起 vite + 自有 server 探针实例（自有端口）+
 * 无头 Edge CDP」。但**只读意图的探针实例在本仓并不只读**：启动序列会捡起库里的
 * in-flight 执行（`server_restart` / `running` 行）→ 真实恢复执行 → spawn 真 CLI、
 * cwd 落在工作树里，产生真实副作用。此前靠实施者手工压制（副本库先摘掉
 * `server_restart`/`running` 行 + 清空 API key），漏一步就出事——本开关把这层
 * 压制从「每次自觉」变成「一条环境变量」。
 *
 * ## 契约（开启时）
 *
 * - **恢复面**：`execution/recovery.ts` 三条启动恢复路径（interrupted / queued /
 *   静默丢重放）整体不捡行；`index.ts` 的 `fixStuckExecutionLogs()` 同批跳过——
 *   它把 `running` 行改写成 `failed/server_restart`，是恢复链的**前置步骤**，
 *   探针实例不该动副本库这一行。
 * - **spawn 面**：`execution/serial.ts` 的两个执行入口（`executeAgentsSerial` /
 *   `execute`）整体拒绝执行 —— 仓内**所有** CLI 执行与常驻子进程
 *   （llama-server / ollama serve / codex-proxy）的 spawn 都在适配器内、只经这两个
 *   入口到达，故一处闸即覆盖整面；启动期的飞轮扫描器 spawn 同批跳过。
 * - **唯一 spawn 豁免 = 嵌入 sidecar**（`memory/embedding.ts` 的
 *   `startEmbeddingSidecar`）：检索链没有它只会静默返回空向量，且它只监听
 *   127.0.0.1、不写库。
 *
 * 闸门**不静默**：每处跳过各记一条带路径名的 warn，探针启动日志里能逐条读出
 * 「哪些面被压住了」——静默压制正是本票要消灭的形态。
 *
 * ## 不覆盖（票面边界：只收「恢复 + spawn」，不做通用只读模式）
 *
 * - HTTP / socket 写口照常：探针实例上的前端操作仍会落库，但落的是**探针自己的**
 *   库（`db/index.ts` 按 `NODE_ENV` 解析库文件，worktree 自带
 *   `packages/server/data/`，天然隔离）。
 * - 启动清理（`deleteGhostExecutionLogs`）与一次性历史迁移照常——它们不是 in-flight
 *   恢复路径。
 * - OneBot 出站按 `ONEBOT_ENABLED` 照常（默认 `false` 时不订阅，零开销）。
 *
 * ## 取值口径
 *
 * **显式开启**（`1` / `true`，大小写与首尾空白不敏感），**不是**全仓宽松惯例的
 * `!== 'false'`——理由同 `memory/index.ts` 的 `isMemoryEnabled`：宽松判据会让任何
 * 笔误写法都算「开启」，而本开关误开的后果是**探针实例静默不执行**（比漏开更难
 * 察觉，因为症状是「什么都没发生」）。未设置 / 空串 / 其它值 ⇒ 关闭，正常启动
 * 序列语义零变化。
 *
 * **读在调用点而非模块求值期**：调用点读才能让测试在同一进程内逐用例开关，
 * 且启动序列里各闸门取到的是同一时刻的真值（无缓存分叉）。
 */

/** 开关的环境变量名（导出给 `.env.example` / 文档 / 测试共用，避免字面量散落） */
export const PROBE_MODE_ENV = 'CATSTUDY_PROBE_MODE'

/**
 * 是否为探针实例（显式开启口径，见文件头「取值口径」）。
 *
 * 消费点只读本函数，不各自解析 `process.env`——多处解析就是下一个分歧源。
 */
export function isProbeMode(): boolean {
  const raw = (process.env[PROBE_MODE_ENV] ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true'
}
