/**
 * diff-collector — 对话内 diff 采集测试。
 *
 * 真实临时 git 仓库（git-utils.test.ts 同款范式）：beforeAll chdir(tmp) +
 * 动态 import——collectCommitDiffs 内部 getCwd() 每次调用动态取（不随模块
 * 加载冻结），chdir 后所有 git 操作自然落在临时仓库。
 *
 * 覆盖：命中 commit 采集 / 无 commit → null / 非仓库 → null / 多 commit
 * 合并（每文件一块）/ 单文件 200 行截断 + 标记 / 总 500 行截断 /
 * parseMessageExtra 版本契约（v!==1 丢弃、损坏 JSON 丢弃）。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const origCwd = process.cwd()
let tmp: string
let notRepo: string
let diffCollector: typeof import('./diff-collector.js')

/** 清理 git 环境变量（与 diff-collector.ts / git-utils.test.ts 同款——
 *  worktree commit 注入的 GIT_DIR 会劫持 cwd 探测） */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_INDEX_FILE
  delete env.GIT_WORK_TREE
  delete env.GIT_PREFIX
  return env
}

function git(cmd: string): string {
  return execSync(`git ${cmd}`, {
    cwd: tmp,
    env: cleanGitEnv(),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

/** 写文件 + git add -A + 带 catstudy [uuid] 标记的 commit */
function commitMarked(uuid: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(resolve(tmp, path), content, 'utf-8')
  }
  git('add -A')
  git(`commit -m "catstudy [${uuid}] fix: test"`)
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'diff-collector-test-'))
  // 非仓库目录必须是独立目录——git 会向上找父目录 .git，
  // tmp 内的子目录依然能命中 tmp 仓库（首版测试此处踩坑）
  notRepo = mkdtempSync(join(tmpdir(), 'diff-collector-notrepo-'))
  execSync('git init', { cwd: tmp, env: cleanGitEnv(), stdio: 'ignore' })
  execSync('git config user.name test', { cwd: tmp, env: cleanGitEnv(), stdio: 'ignore' })
  execSync('git config user.email test@test.local', {
    cwd: tmp,
    env: cleanGitEnv(),
    stdio: 'ignore',
  })
  // 初始 commit（后续 commit 才有 diff 基线）
  writeFileSync(resolve(tmp, 'base.txt'), 'base\n', 'utf-8')
  git('add -A')
  git('commit -m init')
  process.chdir(tmp)
  diffCollector = await import('./diff-collector.js')
})

afterAll(() => {
  process.chdir(origCwd)
  rmSync(tmp, { recursive: true, force: true })
})

describe('collectCommitDiffs', () => {
  it('命中 catstudy [uuid] commit → 每文件一块（路径 + unified diff + 契约字段）', async () => {
    commitMarked('uuid-hit-1', {
      'a.txt': 'line1\nline2\nline3\n',
    })

    const blocks = await diffCollector.collectCommitDiffs('uuid-hit-1')

    expect(blocks).not.toBeNull()
    expect(blocks!.length).toBe(1)
    const block = blocks![0]
    expect(block.kind).toBe('diff')
    expect(block.v).toBe(1)
    expect(block.id).toBe('diff-1')
    expect(block.filePath).toBe('a.txt')
    // unified diff 体：含 ---/+++ 路径行与 hunk 头 + 新增行（新文件 → 0,0 起始）
    expect(block.diff).toContain('@@ -0,0 +1,3 @@')
    expect(block.diff).toContain('+line1')
    expect(block.diff).toContain('+line2')
    expect(block.diff).toContain('+line3')
  })

  it('查不到对应 commit → null', async () => {
    expect(await diffCollector.collectCommitDiffs('no-such-uuid-xyz')).toBeNull()
  })

  it('空 uuid → null', async () => {
    expect(await diffCollector.collectCommitDiffs('')).toBeNull()
  })

  it('非 git 仓库目录 → null（git log 失败静默）', async () => {
    process.chdir(notRepo)
    try {
      expect(await diffCollector.collectCommitDiffs('uuid-hit-1')).toBeNull()
    } finally {
      process.chdir(tmp)
    }
  })

  it('多 commit 合并：每文件一块，id 递增', async () => {
    commitMarked('uuid-multi-1', { 'a.txt': 'aaa\n' })
    commitMarked('uuid-multi-1', { 'b.txt': 'bbb\n' })

    const blocks = await diffCollector.collectCommitDiffs('uuid-multi-1')

    expect(blocks).not.toBeNull()
    expect(blocks!.length).toBe(2)
    const paths = blocks!.map((b) => b.filePath)
    expect(paths).toContain('a.txt')
    expect(paths).toContain('b.txt')
    expect(blocks![0].id).toBe('diff-1')
    expect(blocks![1].id).toBe('diff-2')
  })

  it('单文件 diff 超 200 行 → 截断到 200 行 + 截断标记', async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `old-${i}`)
    commitMarked('uuid-trunc-1', { 'big.txt': lines.join('\n') + '\n' })

    const blocks = await diffCollector.collectCommitDiffs('uuid-trunc-1')

    expect(blocks).not.toBeNull()
    const diff = blocks![0].diff
    const count = diff.split('\n').length
    // 200 内容行 + 截断标记行
    expect(count).toBe(201)
    expect(diff.endsWith(diffCollector.TRUNCATED_MARKER)).toBe(true)
  })

  it('多文件累计超 500 行 → 总行数上限截断', async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `row-${i}`)
    commitMarked('uuid-total-1', { 'f1.txt': lines.join('\n') + '\n' })
    commitMarked('uuid-total-1', { 'f2.txt': lines.join('\n') + '\n' })
    commitMarked('uuid-total-1', { 'f3.txt': lines.join('\n') + '\n' })

    const blocks = await diffCollector.collectCommitDiffs('uuid-total-1')

    expect(blocks).not.toBeNull()
    // 每文件原始 diff ~500 行（250 删 + 250 增 + 头）：
    // f1 截到 200 → 累计 200；f2 截到 200 → 累计 400；f3 只余 100 → 截到 100
    const totalContentLines = blocks!.reduce((sum, b) => {
      const lines2 = b.diff.split('\n')
      const marker = lines2[lines2.length - 1] === diffCollector.TRUNCATED_MARKER
      return sum + lines2.length - (marker ? 1 : 0)
    }, 0)
    expect(totalContentLines).toBe(500)
    // 最后一个块带截断标记（后续文件不再出现）
    expect(blocks![blocks!.length - 1].diff.endsWith(diffCollector.TRUNCATED_MARKER)).toBe(true)
    expect(blocks!.length).toBeLessThanOrEqual(3)
  })

  it('删除文件（+++ /dev/null）→ 取 a/ 侧路径，diff 保留删除行', async () => {
    commitMarked('uuid-del-1', { 'a.txt': 'new-content\n' })
    unlinkSync(resolve(tmp, 'a.txt'))
    git('add -A')
    git('commit -m "catstudy [uuid-del-1] fix: delete a"')

    const blocks = await diffCollector.collectCommitDiffs('uuid-del-1')

    expect(blocks).not.toBeNull()
    expect(blocks![0].filePath).toBe('a.txt')
    expect(blocks![0].diff).toContain('-new-content')
  })
})

describe('parseMessageExtra', () => {
  it('合法 extra JSON → 原样返回', () => {
    const json = JSON.stringify({
      rich: { v: 1, blocks: [{ id: 'diff-1', kind: 'diff', v: 1, filePath: 'a.ts', diff: 'x' }] },
    })
    expect(diffCollector.parseMessageExtra(json)).toEqual({
      rich: { v: 1, blocks: [{ id: 'diff-1', kind: 'diff', v: 1, filePath: 'a.ts', diff: 'x' }] },
    })
  })

  it('版本不符（v=2）→ 整体丢弃 undefined', () => {
    expect(
      diffCollector.parseMessageExtra(JSON.stringify({ rich: { v: 2, blocks: [] } }))
    ).toBeUndefined()
  })

  it('损坏 JSON / null / 结构缺字段 → undefined', () => {
    expect(diffCollector.parseMessageExtra('not-json')).toBeUndefined()
    expect(diffCollector.parseMessageExtra(null)).toBeUndefined()
    expect(diffCollector.parseMessageExtra(JSON.stringify({ other: 1 }))).toBeUndefined()
    expect(
      diffCollector.parseMessageExtra(JSON.stringify({ rich: { v: 1, blocks: 'nope' } }))
    ).toBeUndefined()
  })
})
