/**
 * createPr — 提 git PR 薄封装（gh pr create）。
 *
 * 归宿：git/ 目录（与 push-state.ts / diff-collector.ts 同属「push/PR 工作流」地盘）。
 * 只做「提 pr」这一件事：校验前置（gh 已 auth + 分支已 push origin）→ 执行 gh pr create。
 * 不改内部审查链（post-commit 质量关）、不动 .push-gate 核心门禁、不重写收口流程
 * （新开发流程未定——AC 证据化等属于未来流程，本模块不含任何 PR body 的 AC checklist）。
 *
 * 失败语义：不静默——四种失败原因（no-main-root / not-authed / branch-not-pushed /
 * create-failed）均返回 { ok: false, reason, error }，error 透传命令 stderr
 * （gh 未授权、分支未 push、gh 非零退出都能据此定位）。
 *
 * execFile 参数数组（禁 shell）——git/gh 参数全部走 argv，无 shell 注入面。
 * cwd 固定主仓库根（getMainRepoRoot——任何位置调用均安全，与 gitPushOriginDev 同款）。
 */

import {
  execFile,
  type ExecFileException,
  type ExecFileOptionsWithStringEncoding,
} from 'node:child_process'
import { getMainRepoRoot, cleanGitEnv } from '../llm/git-utils.js'
import { createLogger } from '../logger.js'

const log = createLogger('create-pr')

/** gh/git 命令超时（gh pr create / auth status 含网络往返，15s 给足余量） */
const GH_TIMEOUT_MS = 15_000

/**
 * execFile promise 包装——不依赖 util.promisify 的 promisify.custom 隐式行为
 * （mock 的 execFile 无该属性，promisify 会退回「只 resolve 第一个结果参数」，
 * 拿不到 { stdout, stderr } 对象）。显式包装在任何实现下行为一致。
 * opts 钉死 encoding: 'utf8'（ExecFileOptionsWithStringEncoding），输出统一 string。
 */
function execFileP(
  cmd: string,
  args: string[],
  opts: ExecFileOptionsWithStringEncoding
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      opts,
      (err: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => {
        if (err) {
          err.stdout = String(stdout)
          err.stderr = String(stderr)
          reject(err)
        } else {
          resolve({ stdout: String(stdout), stderr: String(stderr) })
        }
      }
    )
  })
}

/** createPr 入参——head 分支必须已 git push origin <head>（本模块不代推，只校验前置） */
export interface CreatePrInput {
  /** 目标分支（PR merge 进谁）；默认 dev */
  base?: string
  /** 源分支（feature/session 分支） */
  head: string
  /** PR title */
  title: string
  /** PR body；可选——缺省不传 --body（不注入任何 AC checklist） */
  body?: string
}

export type CreatePrResult =
  | { ok: true; number: number; url: string }
  | {
      ok: false
      reason: 'no-main-root' | 'not-authed' | 'branch-not-pushed' | 'create-failed'
      error: string
    }

/** 归一 execFile 错误：优先 stderr（gh/git 报错主体在 stderr），
 *  其次 stdout（gh auth status 未登录提示走 stdout），最后 err.message（ENOENT 等） */
function extractErr(err: any): string {
  const stderr = err?.stderr && String(err.stderr).trim()
  if (stderr) return stderr
  const stdout = err?.stdout && String(err.stdout).trim()
  if (stdout) return stdout
  return err?.message || 'unknown error'
}

/**
 * 创建 PR（核心）。三步：
 * ① gh auth status —— 未授权 → not-authed（前置拦截，不走到 pr create 才报）
 * ② git ls-remote --exit-code origin <head> —— 远端无该分支 → branch-not-pushed
 * ③ gh pr create --base <base> --head <head> --title <title> [--body <body>] --json number,url
 *    → 解析结构化 JSON 得 { number, url }（避免手工正则解析 URL）。
 * gh pr create 对同 head 分支已存在的 PR 会复用并输出已有 PR 的 URL（幂等）。
 */
export async function createPr(input: CreatePrInput): Promise<CreatePrResult> {
  const mainRoot = getMainRepoRoot()
  if (!mainRoot) {
    return {
      ok: false,
      reason: 'no-main-root',
      error: '无法定位主仓库根（getMainRepoRoot 返回 null）',
    }
  }
  const { base = 'dev', head, title, body } = input

  try {
    await execFileP('gh', ['auth', 'status'], {
      cwd: mainRoot,
      env: cleanGitEnv(),
      timeout: GH_TIMEOUT_MS,
      encoding: 'utf8',
    })
  } catch (err: any) {
    log.error('gh not authed', { error: err?.message })
    return { ok: false, reason: 'not-authed', error: extractErr(err) }
  }

  try {
    await execFileP('git', ['ls-remote', '--exit-code', 'origin', head], {
      cwd: mainRoot,
      env: cleanGitEnv(),
      timeout: GH_TIMEOUT_MS,
      encoding: 'utf8',
    })
  } catch (err: any) {
    log.error('head branch not pushed', { head, error: err?.message })
    return { ok: false, reason: 'branch-not-pushed', error: extractErr(err) }
  }

  const args = ['pr', 'create', '--base', base, '--head', head, '--title', title]
  if (body) args.push('--body', body)
  args.push('--json', 'number,url')

  let stdout: string
  try {
    const res = await execFileP('gh', args, {
      cwd: mainRoot,
      env: cleanGitEnv(),
      timeout: GH_TIMEOUT_MS,
      encoding: 'utf8',
    })
    stdout = res.stdout
  } catch (err: any) {
    log.error('gh pr create failed', { base, head, error: err?.message })
    return { ok: false, reason: 'create-failed', error: extractErr(err) }
  }

  try {
    const parsed = JSON.parse(stdout) as { number?: unknown; url?: unknown }
    if (typeof parsed.number !== 'number' || typeof parsed.url !== 'string') {
      throw new Error('unexpected shape')
    }
    log.info('PR created', { number: parsed.number, url: parsed.url, base, head })
    return { ok: true, number: parsed.number, url: parsed.url }
  } catch {
    return {
      ok: false,
      reason: 'create-failed',
      error: `gh 输出无法解析为 { number, url }: ${stdout.trim()}`,
    }
  }
}
