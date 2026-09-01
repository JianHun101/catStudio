/**
 * 对话内 diff 采集 — 富文本块通道。
 *
 * 猫的回复 content 只写摘要，diff 正文由 server 自动从 git 反查 commit 采集，
 * 随消息 extra 列持久化 + 广播。extra 独立列——永不进 LLM 上下文
 * （上下文构建只消费 content 列，见 socketio.ts runAgentReply 的 llmMessages 构建）。
 *
 * 失败语义：git 调用失败/超时/查不到 commit → 静默返回 null，不阻塞回复
 * （同 memory 嵌入的 fire-and-forget 语义）。
 *
 * execFile 参数数组（禁 shell）——git 参数全部走 argv，无 shell 注入面。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { createLogger } from '../logger.js'
import type { MessageExtra, RichBlock } from '@cat-study/shared'

const log = createLogger('diff-collector')

const execFileAsync = promisify(execFile)

/** git 命令超时（5s）——超时静默跳过，不阻塞回复 */
const GIT_TIMEOUT_MS = 5000
/** 单文件 diff 行数上限（含 hunk 头与上下文行） */
const MAX_DIFF_LINES_PER_FILE = 200
/** 全部文件 diff 总行数上限 */
const MAX_DIFF_LINES_TOTAL = 500
/** 截断标记（前端渲染为独立提示行） */
export const TRUNCATED_MARKER = '[diff 过长已截断]'

/**
 * 动态获取当前工作目录。
 *
 * 为什么不用模块级 `const CWD = resolve(process.cwd())`：模块级捕获在
 * vitest worker 中会被模块缓存锁死为「首次加载时」的 cwd——全量测试时
 * 若本模块被其他路径先 import，CWD 会指向真实仓库。每次调用动态取，
 * 测试在 chdir(tmp) 后调用即落在临时仓库（git-utils.test.ts 同款教训）。
 */
function getCwd(): string {
  return resolve(process.cwd())
}

/**
 * 清理 git 环境变量，恢复「按 cwd 探测」语义。
 * worktree 内 commit 时 git 会向 hook 注入绝对 GIT_DIR（.git 是文件指针），
 * env 劫持优先级高于 cwd 探测——不清理则 execFile 的 cwd 失效、
 * git 命令落真实仓库（git-utils.ts 同款，店长 2026-08-09 实测实锤）。
 */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_INDEX_FILE
  delete env.GIT_WORK_TREE
  delete env.GIT_PREFIX
  return env
}

/** 跑一条 git 只读命令；失败/超时 reject（由调用方决定静默语义） */
async function runGit(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: getCwd(),
    env: cleanGitEnv(),
    timeout: GIT_TIMEOUT_MS,
    encoding: 'utf8',
    // 大 diff 放宽 maxBuffer——截断在输出解析层做（500 行上限）
    maxBuffer: 8 * 1024 * 1024,
  })
  return stdout
}

/**
 * 从文件级 diff 段提取路径。
 * - 普通/新增文件：取 `+++ b/<path>`
 * - 删除文件（`+++ /dev/null`）：取 `--- a/<path>`（diff 内容仍可看删除行）
 * - 二进制（Binary files ... differ，无 ---/+++ 行）：返回 null 跳过
 */
function extractFilePath(section: string): string | null {
  const added = section.match(/^\+\+\+ b\/(.+)$/m)
  if (added) return added[1].trim()
  const removed = section.match(/^--- a\/(.+)$/m)
  if (removed && section.includes('+++ /dev/null')) return removed[1].trim()
  return null
}

/** 块累计器（跨 commit/diff 段共享截断状态——多段拼接时总行数上限全局生效） */
interface BlockAccumulator {
  blocks: RichBlock[]
  totalLines: number
  totalTruncated: boolean
}

/**
 * 把一段 unified diff 文本（含 `diff --git` 头）按文件切块追加到累计器。
 * 截断逻辑（200/500 行）——collectCommitDiffs 的唯一 diff 切块管线。
 */
function appendDiffText(acc: BlockAccumulator, text: string): void {
  const sections = text.split(/^diff --git /m).slice(1)
  for (const section of sections) {
    if (acc.totalTruncated) break
    const filePath = extractFilePath(section)
    if (!filePath) continue // 二进制等无路径段 → 跳过

    const lines = section.trimEnd().split('\n')
    const remaining = MAX_DIFF_LINES_TOTAL - acc.totalLines
    let kept = lines
    let blockTruncated = false
    if (lines.length > remaining) {
      // 总上限只够当前块一部分 → 截断 + 后续文件不再出现
      kept = lines.slice(0, Math.max(remaining, 1))
      blockTruncated = true
      acc.totalTruncated = true
    }
    if (kept.length > MAX_DIFF_LINES_PER_FILE) {
      kept = kept.slice(0, MAX_DIFF_LINES_PER_FILE)
      blockTruncated = true
    }
    acc.totalLines += kept.length
    acc.blocks.push({
      id: `diff-${acc.blocks.length + 1}`,
      kind: 'diff',
      v: 1,
      filePath,
      diff: kept.join('\n') + (blockTruncated ? `\n${TRUNCATED_MARKER}` : ''),
    })
  }
}

/**
 * 按 `catstudy [uuid]` 反查 commit 并采集文件级 diff，转为富文本块。
 *
 * @param uuid 触发消息 id（commit message 携带 `catstudy [uuid]` 标记，
 *             post-commit hook 据此投递审查链——diff 采集复用同一锚点）
 * @returns RichBlock[]（每文件一块）；查不到 commit / 全为二进制 / 失败 → null
 */
export async function collectCommitDiffs(uuid: string): Promise<RichBlock[] | null> {
  if (!uuid) return null

  // ① 反查 commit（--all 覆盖未推送分支；uuid 是 hex+连字符，无正则特殊字符，
  //    直接 --grep 匹配 commit message 中的 catstudy [uuid] 标记）
  let shasText: string
  try {
    shasText = await runGit(['log', '--all', `--grep=${uuid}`, '--pretty=%H'])
  } catch (err: any) {
    log.warn('git log failed (diff skipped)', { uuid, error: err?.message })
    return null
  }
  const shas = shasText
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  if (shas.length === 0) {
    log.info('no commit found for uuid (diff skipped)', { uuid })
    return null
  }

  // ② 多 commit 合并：逐个取文件级 diff，按文件聚合（每文件一块）
  const acc: BlockAccumulator = { blocks: [], totalLines: 0, totalTruncated: false }

  for (const sha of shas) {
    let text: string
    try {
      // --format= 去掉 commit 头，只留文件 diff 体
      text = await runGit(['show', '--unified=3', '--no-color', '--format=', sha, '--'])
    } catch (err: any) {
      log.warn('git show failed (diff skipped for commit)', {
        uuid,
        sha,
        error: err?.message,
      })
      continue
    }
    appendDiffText(acc, text)
  }

  return acc.blocks.length > 0 ? acc.blocks : null
}

/**
 * 解析 messages.extra 列 JSON（SESSION_HISTORY 恢复用）。
 * 版本契约：rich.v !== 1 → 整体丢弃返回 undefined（前端纯文本回退）。
 */
export function parseMessageExtra(json: string | null): MessageExtra | undefined {
  if (!json) return undefined
  try {
    const parsed = JSON.parse(json) as MessageExtra
    if (parsed?.rich?.v !== 1 || !Array.isArray(parsed.rich.blocks)) return undefined
    return parsed
  } catch {
    return undefined
  }
}
