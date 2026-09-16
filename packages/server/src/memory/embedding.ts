/**
 * 本地嵌入模块 —— 客户端代理。
 *
 * **模型不再跑在主进程里**：本模块只负责把请求转给独立 sidecar
 * （`scripts/flywheel/embed-server.mjs`，见 `embedding-client.ts`），
 * 并保留对外的两个导出名（`isMemoryEnabled` / `embedText`）。
 *
 * 换返回形态（票丁契约 ①）：`embedText` 返回 `{ ok:true, vector }` /
 * `{ ok:false, reason }` —— **不再用空数组表失败**。「未启用」（`not-enabled`）
 * 与「失败」（其余五种 reason）因此可区分。
 *
 * 环境变量:
 *   MEMORY_ENABLED         — 'false' 禁用全部记忆功能（不 spawn sidecar，零开销）
 *   MEMORY_EMBEDDING_MODEL — 模型名（**sidecar** 读；主进程以 /health 回报为权威）
 */

import { getDb } from '../db/index.js'
import { createLogger } from '../logger.js'
import { messageOf } from '../utils.js'
import { EmbeddingClient, type EmbedResult, type EmbeddingStatus } from './embedding-client.js'

const log = createLogger('memory:embedding')

let client: EmbeddingClient | null = null

function getClient(): EmbeddingClient {
  if (!client) {
    client = new EmbeddingClient({ expectedDim: resolveStoredVectorDim })
  }
  return client
}

/** 嵌入是否全局启用（口径不变：只认显式 'false'） */
export function isMemoryEnabled(): boolean {
  return getClient().isEnabled()
}

/**
 * 将文本转为向量嵌入。
 *
 * 失败返回 `{ ok:false, reason }`，调用方按 reason 分流（不再有空数组歧义）。
 * 首次调用会触发 sidecar 冷启动（含模型加载，上限见 `PROBE_TIMEOUT_MS`）。
 */
export async function embedText(text: string): Promise<EmbedResult> {
  return getClient().embed(text)
}

/** 嵌入链当前状态（供检索面打降级标记；不触发 I/O） */
export function getEmbeddingStatus(): EmbeddingStatus {
  return getClient().status()
}

/**
 * 启动 sidecar 并预热（server 启动时调用，fire-and-forget）。含维度自检：
 * sidecar 回报维度 ≠ 库内向量维度 ⇒ 直接报错并拒绝嵌入路径（Decisions 16 护栏②），
 * 不让 `vec_distance_cosine` 在查询期才炸成「记忆突然搜不到」。
 */
export async function startEmbeddingSidecar(): Promise<void> {
  if (!isMemoryEnabled()) {
    log.info('记忆功能未启用（MEMORY_ENABLED=false），嵌入 sidecar 不启动')
    return
  }
  const status = await getClient().warmup()
  if (status.ok) {
    // port = 握手回报的真实监听端口（票辰）：动态分配时它是唯一可观测的地址来源，
    // 不再需要 netstat 去捞
    log.info('嵌入 sidecar 就绪', { model: status.model, dim: status.dim, port: status.port })
  } else {
    log.error('嵌入 sidecar 未就绪，记忆链降级', { reason: status.reason })
  }
}

/**
 * 关停 sidecar（server shutdown 调用；只杀本进程 spawn 的实例）。
 *
 * 票巳 (a)：**必须留下回收行**——这是「回收有没有发生」的唯一可判面（票丁 OQ4 的
 * 判定规则正是「关停后无回收行 ⇒ 出票」，而原实现只有 `client?.stop()` 零日志，
 * 关停链在日志上等于不存在）。`port` 取自 `StopReceipt` = **握手真值**，非 env 反推。
 *
 * `killedChild:false` 不是噪声：它把「日志没打」与「确实无进程可回收」（未启用 /
 * 从未 spawn / sidecar 已自退）区分开——这正是 OQ4 当年判不出来的那一格。
 */
export function stopEmbeddingSidecar(): void {
  const receipt = client?.stop()
  client = null
  log.info('嵌入 sidecar 关停', {
    port: receipt?.port,
    killedChild: receipt?.killedChild ?? false,
  })
}

/** 仅在测试中使用：替换单例客户端（null = 复位，下次调用重建） */
export function __setEmbeddingClientForTest(next: EmbeddingClient | null): void {
  client = next
}

/**
 * 库内已存向量的维度（维度自检的比对基准）。
 *
 * 读 `chunk_vectors`（vec0，段三索引）与 `knowledge` 里第一条非空向量的长度 ——
 * 与落库格式同源（f32 ⇒ 字节数 / 4；vec0 的 `embedding` 列读出仍是 f32 BLOB，
 * 实测 `length()` = 2048 ⇒ 512）。无向量（全新库）或 DB 未就绪 ⇒ null = 跳过自检。
 * 只读，不建表、不写表。
 *
 * 两个来源**各自独立 try**：`chunk_vectors` 是后加的（存量库要重启才建），它缺席
 * 不该把 `knowledge` 的自检一起拖没。`memories` 已随段三接线下线，不再参与。
 */
export function resolveStoredVectorDim(): number | null {
  const readDim = (sql: string): number | null => {
    try {
      const row = getDb().prepare(sql).get() as { dim: number } | undefined
      const dim = Number(row?.dim)
      return Number.isFinite(dim) && dim > 0 ? dim : null
    } catch (err: any) {
      log.warn('读取库内向量维度失败，跳过该来源', { error: messageOf(err) })
      return null
    }
  }
  return (
    readDim('SELECT length(embedding) / 4 AS dim FROM chunk_vectors LIMIT 1') ??
    readDim(
      'SELECT length(embedding) / 4 AS dim FROM knowledge WHERE embedding IS NOT NULL LIMIT 1'
    )
  )
}
