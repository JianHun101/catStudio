/**
 * 飞轮扫描器测试（票庚 S1–S13）。
 *
 * 测试面刻意选「真实路径」，不用手搓代理面（票丁 B9 教训）：
 *   - **真实 git 仓库**（tmp 里 `git init` + commit）→ `git hash-object` 判据是真的
 *   - **真实迁移路径**（`createTestDb()` 造老库 → `initDb()` 跑生产同一条 additive 迁移）
 *   - **真实切片器**（票丙 `segmentDocument`）与**真实仓储**（票己/庚 `chunks.ts`）
 *   - 只有**嵌入**是 stub（票丁 sidecar 的传输层另有 `embedding-client.test.ts` 覆盖；
 *     本票要验的是「嵌入失败时一行不写」，不是 HTTP）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  SCAN_PREFIXES,
  SKIP_REASONS,
  RETIRED_STATUSES,
  TOMBSTONE_ANCHOR,
  parseFrontmatter,
  classifyDocument,
  collectCandidatePaths,
  cleanGitEnv,
  gitHashObject,
  runScan,
  summaryLine,
  main,
} from './scan.mjs'

import { createTestDb, listenFetchable } from '../../packages/server/src/test-helpers.js'
import { setDb, resetDb, getDb, initDb } from '../../packages/server/src/db/index.js'
import {
  initRepository,
  chunks as chunksRepo,
} from '../../packages/server/src/db/repository/index.js'
import { segmentDocument } from '../../packages/server/src/memory/flywheel/segment.js'
import { vectorToBlob } from '../../packages/server/src/memory/index.js'
import { EmbeddingClient } from '../../packages/server/src/memory/embedding-client.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// ─── 夹具 ─────────────────────────────────────────────

/** 与生产侧同款环境净化：pre-commit 钩子会注入 GIT_DIR/GIT_INDEX_FILE，
 *  不剔则 `git -C <tmp>` 被劫持到外层仓库（实测：钩子内跑本测试必炸） */
function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: cleanGitEnv() })
}

function initGitRepo(root) {
  git(root, ['init', '-q'])
  // 关掉行尾转换：否则 Windows 下每条 git 调用都刷 "LF will be replaced by CRLF" 噪声，
  // 且 blob SHA 会随全局 autocrlf 漂移（判据要的是**内容**指纹，与平台无关）
  git(root, ['config', 'core.autocrlf', 'false'])
  git(root, ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '-A'])
  git(root, ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'])
}

/** 造 frontmatter 文本（受支持子集：标量 + 单层映射列表） */
function fm(fields) {
  const lines = []
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${k}: []`)
        continue
      }
      lines.push(`${k}:`)
      for (const item of v) {
        if (typeof item === 'string') {
          lines.push(`  - ${item}`)
          continue
        }
        const entries = Object.entries(item)
        lines.push(`  - ${entries[0][0]}: ${entries[0][1]}`)
        for (const [ik, iv] of entries.slice(1)) lines.push(`    ${ik}: ${iv}`)
      }
      continue
    }
    lines.push(`${k}: ${v}`)
  }
  return lines.join('\n')
}

/** 一份合格结晶件（字段可覆盖） */
function doc({ title = '测试件', section = '一节', body = '这是一段测试正文。', ...fields } = {}) {
  const meta = {
    type: 'decision',
    date: '2026-09-12',
    status: 'accepted',
    evidence: [{ kind: 'commit', ref: 'abc1234' }],
    ...fields,
  }
  return `---\n${fm(meta)}\n---\n\n# ${title}\n\n## ${section}\n\n${body}\n`
}

function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf8')
  }
}

/** 确定性 512 维 one-hot（同一文本 ⇒ 同一向量；不同文本大概率不同位） */
function vecFor(text) {
  const h = createHash('sha256').update(text).digest()
  const v = new Array(512).fill(0)
  v[h[0] % 512] = 1
  return v
}

/** 嵌入 stub：默认成功；`fail` 给原因码时整批失败（票丁 EmbedResult 形态） */
function stubEmbed(fail = null) {
  return {
    async embedMany(texts) {
      if (fail) return texts.map(() => ({ ok: false, reason: fail }))
      return texts.map((t) => ({ ok: true, vector: vecFor(t) }))
    },
  }
}

function deps(embed = stubEmbed()) {
  return {
    repo: chunksRepo,
    segment: segmentDocument,
    embed,
    hashObject: (rel) => gitHashObject(root, rel),
    toBlob: vectorToBlob,
  }
}

const countOf = (sql) => getDb().prepare(sql).get().c

// ─── 生命周期 ──────────────────────────────────────────

let root

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-scan-'))
  setDb(createTestDb())
  initDb()
  initRepository(getDb())
})

afterEach(() => {
  resetDb()
  fs.rmSync(root, { recursive: true, force: true })
})

function scan(opts = {}) {
  const { embed, ...rest } = opts
  return runScan({ root, ...deps(embed), ...rest })
}

// ─── S1 白名单 ─────────────────────────────────────────

describe('S1 白名单', () => {
  beforeEach(() => {
    writeFiles(root, {
      'docs/adr/a.md': doc({ title: 'ADR 甲' }),
      'docs/lessons/b.md': doc({ title: '经验 乙' }),
      'docs/plans/c.md': doc({ title: '规格 丙', status: 'final' }),
      'docs/plans/d.md': doc({ title: '规格 丁', status: 'active' }),
      'docs/run/e.md': doc({ title: '在飞 戊' }),
      'docs/research/f.md': doc({ title: '研究 己' }),
      'docs/sessions/g.md': doc({ title: '会话 庚' }),
    })
    initGitRepo(root)
  })

  it('白名单常量与票面逐字一致', () => {
    expect(SCAN_PREFIXES).toEqual(['docs/adr/', 'docs/lessons/', 'docs/plans/'])
  })

  it('只有三前缀内且 status 合格者入库；run/research/sessions 零行', () => {
    return scan().then((report) => {
      expect(collectCandidatePaths(root)).toEqual([
        'docs/adr/a.md',
        'docs/lessons/b.md',
        'docs/plans/c.md',
        'docs/plans/d.md',
      ])
      expect(report.inserted).toBe(3)
      expect(chunksRepo.listChunkDocPaths()).toEqual([
        'docs/adr/a.md',
        'docs/lessons/b.md',
        'docs/plans/c.md',
      ])
      expect(report.skipped).toEqual([
        {
          path: 'docs/plans/d.md',
          reason: SKIP_REASONS.PLAN_NOT_CRYSTALLIZED,
          detail: 'status=active',
        },
      ])
    })
  })

  it('docs/plans/ 只放行 final / closed', () => {
    const ok = (status) =>
      classifyDocument({ path: 'docs/plans/x.md', content: doc({ status }) }).ok
    expect(ok('final')).toBe(true)
    expect(ok('closed')).toBe(true)
    expect(ok('active')).toBe(false)
    expect(ok('')).toBe(false)
  })

  it('旧中文态已出值域（反对照：值域不是宽放行）', () => {
    const ok = (status) =>
      classifyDocument({ path: 'docs/plans/x.md', content: doc({ status }) }).ok
    // 改前这四个里前三个曾是「结晶态/合法态」；统一英文后一律拒——
    // 若哪天有人把中文词加回白名单当兼容别名，本用例必红。
    expect(ok('已定稿')).toBe(false)
    expect(ok('已收口')).toBe(false)
    expect(ok('在飞')).toBe(false)
    expect(ok('进行中')).toBe(false)
    // 对照：同批新词必须放行（证本用例不是「恒假门」）
    expect(ok('final')).toBe(true)
    expect(ok('closed')).toBe(true)
  })
})

// ─── S2 fail-closed 不静默 ─────────────────────────────

describe('S2 fail-closed 不静默', () => {
  it('缺 frontmatter / 缺 type / evidence 空数组 ⇒ 零行且在 skipped[] 里逐个列名', async () => {
    writeFiles(root, {
      'docs/adr/ok.md': doc({ title: '合格件' }),
      'docs/adr/no-fm.md': '# 没有 frontmatter 的件\n\n## 一节\n\n正文。\n',
      'docs/adr/no-type.md': `---\ndate: 2026-09-12\nevidence:\n  - kind: commit\n    ref: abc1234\n---\n\n# 无 type\n\n## 一节\n\n正文。\n`,
      'docs/adr/empty-evidence.md': doc({ title: '空证据', evidence: [] }),
    })
    initGitRepo(root)

    const report = await scan()
    expect(report.inserted).toBe(1)
    expect(chunksRepo.listChunkDocPaths()).toEqual(['docs/adr/ok.md'])
    expect(report.skipped).toEqual([
      { path: 'docs/adr/empty-evidence.md', reason: SKIP_REASONS.EMPTY_EVIDENCE },
      { path: 'docs/adr/no-fm.md', reason: SKIP_REASONS.NO_FRONTMATTER },
      { path: 'docs/adr/no-type.md', reason: SKIP_REASONS.MISSING_TYPE },
    ])
  })

  it('未闭合 frontmatter 判为「无 frontmatter」（与切片侧 stripFrontmatter 同判）', () => {
    const content = '---\ntype: decision\n\n# 没闭合\n'
    expect(parseFrontmatter(content).present).toBe(false)
    expect(classifyDocument({ path: 'docs/adr/x.md', content }).reason).toBe(
      SKIP_REASONS.NO_FRONTMATTER
    )
  })
})

// ─── S3 幂等 ───────────────────────────────────────────

describe('S3 幂等', () => {
  it('连扫两次：第二次 inserted=0 / updated=0 / 行数不变', async () => {
    writeFiles(root, { 'docs/adr/a.md': doc() })
    initGitRepo(root)

    const first = await scan()
    expect(first.inserted).toBeGreaterThan(0)
    const rows = countOf('SELECT COUNT(*) c FROM chunks')
    const fts = countOf('SELECT COUNT(*) c FROM chunks_fts')
    const vec = countOf('SELECT COUNT(*) c FROM chunk_vectors')

    const second = await scan()
    expect(second.inserted).toBe(0)
    expect(second.updated).toBe(0)
    expect(second.skipped).toEqual([{ path: 'docs/adr/a.md', reason: SKIP_REASONS.UNCHANGED }])
    expect(countOf('SELECT COUNT(*) c FROM chunks')).toBe(rows)
    expect(countOf('SELECT COUNT(*) c FROM chunks_fts')).toBe(fts)
    expect(countOf('SELECT COUNT(*) c FROM chunk_vectors')).toBe(vec)
  })
})

// ─── S4 增量是 SHA 不是 mtime ──────────────────────────

describe('S4 增量判据是 blob SHA 不是 mtime', () => {
  it('只动 mtime（内容不变）⇒ 仍 skipped: unchanged', async () => {
    writeFiles(root, { 'docs/adr/a.md': doc() })
    initGitRepo(root)
    await scan()

    const abs = path.join(root, 'docs/adr/a.md')
    const future = new Date(Date.now() + 86_400_000)
    fs.utimesSync(abs, future, future)

    const report = await scan()
    expect(report.inserted).toBe(0)
    expect(report.skipped).toEqual([{ path: 'docs/adr/a.md', reason: SKIP_REASONS.UNCHANGED }])
  })

  it('内容变了（blob SHA 变）⇒ 重写，且旧代行被物理删', async () => {
    writeFiles(root, { 'docs/adr/a.md': doc({ body: '第一版正文。' }) })
    initGitRepo(root)
    const first = await scan()
    expect(first.inserted).toBe(1)

    writeFiles(root, { 'docs/adr/a.md': doc({ body: '第二版正文。' }) })
    const second = await scan()
    expect(second.inserted).toBe(1)
    expect(second.orphansDeleted).toBe(1)

    const bodies = getDb()
      .prepare('SELECT body FROM chunks')
      .all()
      .map((r) => r.body)
    expect(bodies).toEqual(['第二版正文。'])
    // 三表同步收缩（旧代不留 FTS / 向量僵尸行）
    expect(countOf('SELECT COUNT(*) c FROM chunks_fts')).toBe(1)
    expect(countOf('SELECT COUNT(*) c FROM chunk_vectors')).toBe(1)
  })
})

// ─── S5 孤儿物理删（三表） ─────────────────────────────

describe('S5 孤儿物理删', () => {
  it('删源文件重扫 ⇒ 该 doc_path 在三张表均 0 行', async () => {
    writeFiles(root, {
      'docs/adr/gone.md': doc({ title: '将被删除' }),
      'docs/adr/kept.md': doc({ title: '留下' }),
    })
    initGitRepo(root)
    await scan()
    expect(countOf('SELECT COUNT(*) c FROM chunks')).toBe(2)

    fs.rmSync(path.join(root, 'docs/adr/gone.md'))
    const report = await scan()

    expect(report.orphansDeleted).toBe(1)
    expect(countOf(`SELECT COUNT(*) c FROM chunks WHERE doc_path = 'docs/adr/gone.md'`)).toBe(0)
    expect(
      countOf(`SELECT COUNT(*) c FROM chunks_fts f JOIN chunks c ON c.rowid = f.rowid
               WHERE c.doc_path = 'docs/adr/gone.md'`)
    ).toBe(0)
    expect(countOf(`SELECT COUNT(*) c FROM chunks WHERE doc_path = 'docs/adr/kept.md'`)).toBe(1)
    expect(countOf('SELECT COUNT(*) c FROM chunks_fts')).toBe(1)
    expect(countOf('SELECT COUNT(*) c FROM chunk_vectors')).toBe(1)
  })

  it('件被改成不合格（丢掉 frontmatter）⇒ 其旧行也算孤儿，物理删', async () => {
    writeFiles(root, { 'docs/adr/a.md': doc() })
    initGitRepo(root)
    await scan()
    expect(countOf('SELECT COUNT(*) c FROM chunks')).toBe(1)

    writeFiles(root, { 'docs/adr/a.md': '# 退化成没有 frontmatter 的件\n' })
    const report = await scan()
    expect(report.skipped).toEqual([{ path: 'docs/adr/a.md', reason: SKIP_REASONS.NO_FRONTMATTER }])
    expect(report.orphansDeleted).toBe(1)
    expect(countOf('SELECT COUNT(*) c FROM chunks')).toBe(0)
  })
})

// ─── S6 嵌入失败不写脏行 ───────────────────────────────

describe('S6 嵌入失败不写脏行', () => {
  it('sidecar 失败 ⇒ 该件零行 + errors[] 含 reason（无半截行）', async () => {
    writeFiles(root, {
      'docs/adr/a.md': doc({ title: '会失败', body: '正文甲。' }),
      'docs/adr/b.md': doc({ title: '也会失败', body: '正文乙。' }),
    })
    initGitRepo(root)

    const report = await scan({ embed: stubEmbed('request-timeout') })
    expect(report.inserted).toBe(0)
    expect(countOf('SELECT COUNT(*) c FROM chunks')).toBe(0)
    expect(countOf('SELECT COUNT(*) c FROM chunks_fts')).toBe(0)
    expect(countOf('SELECT COUNT(*) c FROM chunk_vectors')).toBe(0)
    expect(report.errors).toHaveLength(2)
    expect(report.errors.every((e) => e.reason === 'embed-failed')).toBe(true)
    expect(report.errors.map((e) => e.detail)).toContain('request-timeout')
  })

  it('嵌入未启用（not-enabled）⇒ 整轮中止，且不删任何孤儿行', async () => {
    writeFiles(root, {
      'docs/adr/a.md': doc({ body: '第一版正文。' }),
      'docs/adr/b.md': doc({ title: '乙' }),
    })
    initGitRepo(root)
    await scan() // 先正常入库两件
    const before = countOf('SELECT COUNT(*) c FROM chunks')
    expect(before).toBe(2)

    // 制造孤儿（b 消失）+ 让 a 需要重扫（否则 a 会走 unchanged 跳过、根本到不了嵌入那步，
    // 整轮中止就无从触发——「中止」的触发面是「有一个件真要写」）
    fs.rmSync(path.join(root, 'docs/adr/b.md'))
    writeFiles(root, { 'docs/adr/a.md': doc({ body: '第二版正文。' }) })

    const report = await scan({ embed: stubEmbed('not-enabled') })

    expect(report.aborted).toEqual({ reason: 'not-enabled', at: 'docs/adr/a.md' })
    expect(report.orphansDeleted).toBe(0)
    // ⚠️ 中止轮次**不删行**：此刻删孤儿 = 在「本轮根本没写成」时丢数据
    expect(countOf('SELECT COUNT(*) c FROM chunks')).toBe(before)
  })
})

// ─── S7 不写 MD ────────────────────────────────────────

describe('S7 只读 MD', () => {
  it('跑完 git status --porcelain -- *.md 输出为空', async () => {
    writeFiles(root, { 'docs/adr/a.md': doc() })
    initGitRepo(root)
    await scan()
    expect(git(root, ['status', '--porcelain', '--', '*.md'])).toBe('')
  })
})

// ─── S8 reindex 可重建 ─────────────────────────────────

describe('S8 reindex 可重建', () => {
  it('同输入连续两次 reindex ⇒ chunks 按身份键排序后逐列相等', async () => {
    writeFiles(root, {
      'docs/adr/a.md': doc({ title: '甲', body: '正文甲。' }),
      'docs/adr/b.md': doc({
        title: '乙',
        body: '正文乙。',
        evidence: [{ kind: 'file', ref: 'AGENTS.md' }],
      }),
    })
    initGitRepo(root)

    const snapshot = async () => {
      chunksRepo.deleteChunksByDocPaths(chunksRepo.listChunkDocPaths())
      const report = await scan()
      expect(report.aborted).toBeNull()
      return getDb()
        .prepare(
          `SELECT doc_path, section_anchor, content_hash, origin_id, type, status, date,
                  evidence, part_index, part_total, hard_cut, body, breadcrumb
           FROM chunks ORDER BY doc_path, section_anchor, content_hash`
        )
        .all()
    }

    const first = await snapshot()
    const second = await snapshot()
    expect(first.length).toBeGreaterThan(0)
    expect(second).toEqual(first)
  })
})

// ─── S9 启动不阻塞 ─────────────────────────────────────

describe('S9 失败不阻塞（server 启动面）', () => {
  it('index.ts 的启动 spawn 包在 try/catch 里、失败只记 log（源码断言）', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'packages/server/src/index.ts'), 'utf8')
    // 断言「有这段接线」+「它不抛」——server 启动链上不可有未捕获的 spawn 异常
    expect(src).toContain('spawnFlywheelScan')
    const body = src.slice(src.indexOf('function spawnFlywheelScan'))
    expect(body.slice(0, body.indexOf('\n}'))).toMatch(/try\s*{[\s\S]*catch/)
  })

  it('git 不可用（hashObject 抛错）⇒ 记 errors[]、不抛未捕获异常、不写行', async () => {
    writeFiles(root, { 'docs/adr/a.md': doc() })
    initGitRepo(root)
    const report = await scan({
      hashObject: () => {
        throw new Error('git not found')
      },
    })
    expect(report.errors).toEqual([
      { path: 'docs/adr/a.md', reason: 'hash-failed', detail: 'git not found' },
    ])
    expect(countOf('SELECT COUNT(*) c FROM chunks')).toBe(0)
    expect(summaryLine(report)).toContain('errors=1')
  })
})

// ─── S10 真实仓库全量 ──────────────────────────────────

describe('S10 真实工作区全量', () => {
  it('每个白名单件要么产出、要么被逐个列名跳过——无静默丢弃', async () => {
    const walked = collectCandidatePaths(REPO_ROOT)
    // 真实仓库此刻必须确实有候选件，否则这条用例会「空集全绿」
    expect(walked.length).toBeGreaterThan(0)

    const report = await runScan({
      root: REPO_ROOT,
      repo: chunksRepo,
      segment: segmentDocument,
      embed: stubEmbed(),
      hashObject: (rel) => gitHashObject(REPO_ROOT, rel),
      toBlob: vectorToBlob,
    })

    const produced = chunksRepo.listChunkDocPaths()
    const skippedPaths = report.skipped.map((s) => s.path)

    // 划分不变式：走到的每一件**恰好**落进「产出 ∪ 跳过」之一（不重不漏）
    expect(report.scanned).toBe(walked.length)
    expect([...produced, ...skippedPaths].sort()).toEqual(walked)
    // 产出面非空 + 每件产出都是本次真的写进去的（inserted 按**片**计，故不逐件相等）
    expect(produced.length).toBeGreaterThan(0)
    expect(report.inserted + report.updated).toBeGreaterThanOrEqual(produced.length)
    expect(report.errors).toEqual([])
    expect(report.aborted).toBeNull()

    // 每条跳过都带非空 reason（「跳过永不是静默的」）
    expect(report.skipped.every((s) => typeof s.reason === 'string' && s.reason !== '')).toBe(true)
    // 稳定事实抽查：门牌 README 无 frontmatter；票卯 回填后 docs/plans 已产出
    expect(skippedPaths).toContain('docs/lessons/README.md')
    expect(produced).toContain('docs/plans/review-chain-anchor.md')
    // 票戊回填过 frontmatter 的 ADR 必须真的进去了
    expect(produced).toContain('docs/adr/0007-external-tool-form-selection-checklist.md')
  })
})

// ─── S11 / S12 / S13（补钉 G1–G4） ────────────────────

describe('S11 关键词通道真能命中（G1/G2）', () => {
  it('写入后按正文词能 MATCH 到；且 chunks_fts.content 已是 bigram 串 ≠ 原文', async () => {
    writeFiles(root, { 'docs/adr/a.md': doc({ body: '扫描器关键词通道的命中用例。' }) })
    initGitRepo(root)
    await scan()

    const hits = chunksRepo.searchChunksByKeyword('关键词', 10)
    expect(hits).toHaveLength(1)

    const row = getDb().prepare('SELECT content FROM chunks_fts').get()
    expect(row.content).not.toContain('扫描器关键词通道的命中用例')
    expect(row.content.split(' ').length).toBeGreaterThan(5)
  })
})

describe('S12 向量行真写进去了（G3）', () => {
  it('写入后向量通道能召回该片', async () => {
    const content = doc({ body: '扫描器向量通道的召回用例。' })
    writeFiles(root, { 'docs/adr/a.md': content })
    initGitRepo(root)
    await scan()

    const seg = segmentDocument({ path: 'docs/adr/a.md', content }).segments[0]
    const hits = chunksRepo.searchChunksByVector(vectorToBlob(vecFor(seg.text)), 10, 1.5)
    expect(hits).toHaveLength(1)
    expect(hits[0].body).toContain('扫描器向量通道的召回用例')
  })

  it('反例：vec0 主键不传 BigInt 会被拒（写入侧 G3 的由来）', async () => {
    writeFiles(root, { 'docs/adr/a.md': doc() })
    initGitRepo(root)
    await scan()

    const { id } = getDb().prepare('SELECT id FROM chunks').get()
    expect(() =>
      getDb()
        .prepare('INSERT INTO chunk_vectors (chunk_id, embedding) VALUES (?, ?)')
        .run(id, vectorToBlob(vecFor('x')))
    ).toThrow(/integer/i)
  })
})

// ─── C3 扫描器端口隔离（票辰） ─────────────────────────

describe('C3 扫描器端口隔离可证伪', () => {
  /**
   * **承重用例**：删掉 `main()` 里那行 `process.env.EMBED_SIDECAR_PORT = '0'`，本用例必红。
   *
   * 判据面 = `main()` 跑完后进程 env 里的值。这不是「读源码猜行为」——它就是
   * sidecar 子进程**实际继承到的**值（`defaultSpawn` 不传 `env`，子进程继承父进程 env）。
   * 两条到达扫描器的通道（server 启动 spawn / 手动 `pnpm flywheel:scan`）都必经 `main()`。
   */
  it('main() 把 EMBED_SIDECAR_PORT 压成 0（删掉覆盖行 ⇒ 本用例变红）', async () => {
    // 反例面：模拟「.env 里配了固定端口」——两条通道拿到的初始值都长这样
    process.env.EMBED_SIDECAR_PORT = '9999'
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-scan-empty-'))
    try {
      const code = await main(['--root', emptyRoot]) // 空 root ⇒ 零候选 ⇒ 不触发嵌入/spawn
      expect(code).toBe(0)
      expect(process.env.EMBED_SIDECAR_PORT).toBe('0')
    } finally {
      delete process.env.EMBED_SIDECAR_PORT
      fs.rmSync(emptyRoot, { recursive: true, force: true })
    }
  })
})

describe('S13 evidence 往返（G4）', () => {
  it('真实 ADR frontmatter ⇒ evidence 列为 {kind, ref} 对象数组 JSON，读回可解出字段', async () => {
    const rel = 'docs/adr/0007-external-tool-form-selection-checklist.md'
    const content = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')

    const cls = classifyDocument({ path: rel, content })
    expect(cls.ok).toBe(true)
    expect(cls.meta.evidence).toEqual([
      { kind: 'commit', ref: 'd555732' },
      { kind: 'file', ref: 'AGENTS.md' },
    ])

    writeFiles(root, { [rel]: content })
    initGitRepo(root)
    await scan()

    const row = getDb().prepare('SELECT evidence FROM chunks WHERE doc_path = ? LIMIT 1').get(rel)
    const parsed = JSON.parse(row.evidence)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed[0].kind).toBe('commit')
    expect(parsed[0].ref).toBe('d555732')
  })
})

// ─── P1-A 墓碑切片（C1 闸 / C2 形态 / 自检）──────────────

/** 退役件：`status` + `verdict` 由用例给，其余字段与 `doc()` 同款 */
function retiredDoc({ status = 'superseded', verdict, ...fields } = {}) {
  return doc({
    title: 'C3 出站总线方案',
    section: '决策',
    body: '这段正文**不该**进索引——退役件只留结论。',
    status,
    verdict,
    ...fields,
  })
}

describe('P1-A C1 写入口闸：退役件缺 verdict 拒入库', () => {
  it('superseded 无 verdict ⇒ skipped: missing-verdict，库里零行', async () => {
    writeFiles(root, {
      'docs/adr/retired-no-verdict.md': retiredDoc(),
      'docs/adr/ok.md': doc({ title: '合格件' }),
    })
    initGitRepo(root)

    // ⚠️ 先按**旧机制**（无 C1 闸时）的样子铺 2 行正文片：跳过件不进 `produced`，
    // 于是它落进孤儿差集被**物理删**（不是「留着但挡住」）。这是本闸的连带后果，
    // 与「退役正文片不该被猫读到」同向；P1-B 的 0013 对账据此可预期为「0 行 → 重扫后 1 行」。
    for (const [i, anchor] of ['## 决策', '## 背景'].entries()) {
      chunksRepo.upsertChunk({
        docPath: 'docs/adr/retired-no-verdict.md',
        sectionAnchor: anchor,
        contentHash: `old${i}`,
        originId: 'blob-old',
        type: 'decision',
        status: 'superseded',
        partIndex: 1,
        partTotal: 1,
        body: '旧机制切出来的退役正文。',
        breadcrumb: 'docs/adr/retired-no-verdict.md > C3 出站总线方案 > 决策',
      })
    }

    const report = await scan()
    expect(report.skipped).toContainEqual({
      path: 'docs/adr/retired-no-verdict.md',
      reason: SKIP_REASONS.MISSING_VERDICT,
      detail: 'status=superseded',
    })
    // 拒得干净：不是「跳过了但留下半截」，是一个片都没有
    expect(chunksRepo.getChunksByDocPath('docs/adr/retired-no-verdict.md')).toEqual([])
    expect(report.orphansDeleted).toBe(2)
    expect(countOf('SELECT COUNT(*) c FROM chunks_fts')).toBe(
      countOf('SELECT COUNT(*) c FROM chunks')
    )
  })

  it('verdict 为空串 / 纯空白同样拒（与 evidence 同一条「空 = 缺」的判据）', async () => {
    writeFiles(root, {
      'docs/adr/blank.md': `---\ntype: decision\ndate: 2026-09-12\nstatus: deprecated\nverdict: "   "\nevidence:\n  - kind: commit\n    ref: abc1234\n---\n\n# 空 verdict\n\n## 一节\n\n正文。\n`,
    })
    initGitRepo(root)

    expect(
      classifyDocument({
        path: 'docs/adr/blank.md',
        content: fs.readFileSync(path.join(root, 'docs/adr/blank.md'), 'utf8'),
      })
    ).toEqual({ ok: false, reason: SKIP_REASONS.MISSING_VERDICT, detail: 'status=deprecated' })
  })

  it('非退役件不要求 verdict（闸只对退役态开）', () => {
    expect(classifyDocument({ path: 'docs/adr/a.md', content: doc() }).ok).toBe(true)
  })
})

describe('P1-A C2 扫描形态：退役件只产一个墓碑片', () => {
  const VERDICT = 'C3 出站总线方案已废弃，2026-09-01 裁定不做'

  it('chunks 行数恒 1、anchor 恒 #tombstone、body == verdict、breadcrumb 指向文档级', async () => {
    writeFiles(root, { 'docs/adr/retired.md': retiredDoc({ verdict: VERDICT }) })
    initGitRepo(root)

    const report = await scan()
    expect(report.errors).toEqual([])
    expect(report.inserted).toBe(1)

    const rows = chunksRepo.getChunksByDocPath('docs/adr/retired.md')
    expect(rows).toHaveLength(1)
    expect(rows[0].section_anchor).toBe(TOMBSTONE_ANCHOR)
    expect(rows[0].body).toBe(VERDICT)
    expect(rows[0].status).toBe('superseded')
    // 文档级面包屑 = `相对路径 > H1`（切片器的面包屑是 `路径 > H1 > H2 > H3`）
    expect(rows[0].breadcrumb).toBe('docs/adr/retired.md > C3 出站总线方案')
    // 正文一个字都没切进来（切片器会给 `## 决策` 出一片；墓碑路径不给）
    expect(rows[0].body).not.toContain('只留结论')
    expect(rows[0].part_index).toBe(1)
    expect(rows[0].part_total).toBe(1)
    // FTS / vec 同样只有一行（三表齐）
    expect(countOf('SELECT COUNT(*) c FROM chunks_fts')).toBe(1)
    expect(countOf('SELECT COUNT(*) c FROM chunk_vectors')).toBe(1)
  })

  it('墓碑片真的进了嵌入面：嵌入调用收到的是 verdict（不是整篇正文）', async () => {
    const seen = []
    const embed = {
      async embedMany(texts) {
        seen.push(...texts)
        return texts.map((t) => ({ ok: true, vector: vecFor(t) }))
      },
    }
    writeFiles(root, { 'docs/adr/retired.md': retiredDoc({ verdict: VERDICT }) })
    initGitRepo(root)

    await scan({ embed })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(`docs/adr/retired.md > C3 出站总线方案\n${VERDICT}`)
  })

  it('改 verdict（内容变了）⇒ 重切，旧片被陈旧代删除清掉', async () => {
    writeFiles(root, { 'docs/adr/retired.md': retiredDoc({ verdict: 'C3 方案已废弃（初版）' }) })
    initGitRepo(root)
    await scan()

    writeFiles(root, { 'docs/adr/retired.md': retiredDoc({ verdict: 'C3 方案已废弃（改后）' }) })
    const second = await scan()
    expect(second.errors).toEqual([])
    const rows = chunksRepo.getChunksByDocPath('docs/adr/retired.md')
    expect(rows.map((r) => r.body)).toEqual(['C3 方案已废弃（改后）'])
  })

  it('自检：库里残留旧正文片（未重切）⇒ 报告报错，不静默', async () => {
    // 形态 = **本机制上线后最容易出的那一种**：文件内容没变（blob SHA 相同 ⇒ 判
    // `unchanged` 跳过、重切路径压根不走），但库里躺着按**旧机制**切出来的正文片。
    // 不变量「恒 == 1」正是为它设的——用「本次刚写进去那行」当判据会看不见它。
    const content = retiredDoc({ verdict: VERDICT })
    writeFiles(root, { 'docs/adr/retired.md': content })
    initGitRepo(root)

    const blob = gitHashObject(root, 'docs/adr/retired.md')
    chunksRepo.upsertChunk({
      docPath: 'docs/adr/retired.md',
      sectionAnchor: '## 决策',
      contentHash: 'stale-hash',
      originId: blob, // ← 当前代：增量判据认为「已扫过」，实际却是旧机制的正文片
      type: 'decision',
      status: 'superseded',
      partIndex: 1,
      partTotal: 1,
      body: '这段正文不该留在库里。',
      breadcrumb: 'docs/adr/retired.md > C3 出站总线方案 > 决策',
    })

    const report = await scan()
    expect(report.skipped).toEqual([
      { path: 'docs/adr/retired.md', reason: SKIP_REASONS.UNCHANGED },
    ])
    expect(report.errors).toEqual([
      {
        path: 'docs/adr/retired.md',
        reason: 'tombstone-invariant',
        detail: 'anchor=## 决策',
      },
    ])
    // ⚠️ 报告报错但不是「静默修好」：本函数只读不写，残留照旧躺着等人处置
    expect(chunksRepo.getChunksByDocPath('docs/adr/retired.md')).toHaveLength(1)
  })

  /** 预置「当前代」的行：增量判据会判 `unchanged` ⇒ 走自检、不走重切 */
  async function seedCurrentGenRows(rows) {
    const blob = gitHashObject(root, 'docs/adr/retired.md')
    for (const [i, r] of rows.entries()) {
      chunksRepo.upsertChunk({
        docPath: 'docs/adr/retired.md',
        originId: blob,
        type: 'decision',
        status: 'superseded',
        partIndex: 1,
        partTotal: 1,
        contentHash: `k${i}`,
        breadcrumb: 'docs/adr/retired.md > C3 出站总线方案',
        ...r,
      })
    }
  }

  it('自检：行数 > 1 ⇒ rows=N（多切了或残留没清）', async () => {
    writeFiles(root, { 'docs/adr/retired.md': retiredDoc({ verdict: VERDICT }) })
    initGitRepo(root)
    await seedCurrentGenRows([
      { sectionAnchor: TOMBSTONE_ANCHOR, body: VERDICT },
      { sectionAnchor: '## 决策', body: '别的东西' },
    ])

    const report = await scan()
    expect(report.errors).toEqual([
      { path: 'docs/adr/retired.md', reason: 'tombstone-invariant', detail: 'rows=2' },
    ])
  })

  it('自检：行数恰好 1 但正文不是 verdict ⇒ body-not-verdict（切了正文）', async () => {
    writeFiles(root, { 'docs/adr/retired.md': retiredDoc({ verdict: VERDICT }) })
    initGitRepo(root)
    await seedCurrentGenRows([{ sectionAnchor: TOMBSTONE_ANCHOR, body: '这段正文不该在库里。' }])

    const report = await scan()
    expect(report.errors).toEqual([
      { path: 'docs/adr/retired.md', reason: 'tombstone-invariant', detail: 'body-not-verdict' },
    ])
  })

  it('自检通过时 errors 为空（不变量真被守住，不是恒报错）', async () => {
    writeFiles(root, { 'docs/adr/retired.md': retiredDoc({ verdict: VERDICT }) })
    initGitRepo(root)
    await seedCurrentGenRows([{ sectionAnchor: TOMBSTONE_ANCHOR, body: VERDICT }])

    const report = await scan()
    expect(report.errors).toEqual([])
    expect(report.skipped).toEqual([
      { path: 'docs/adr/retired.md', reason: SKIP_REASONS.UNCHANGED },
    ])
  })
})

describe('P1-A 退役集合两侧绑死（扫描器声明 ↔ 服务端 SQL 字面量）', () => {
  it('RETIRED_STATUSES / TOMBSTONE_ANCHOR 与 chunks.ts 谓词逐字一致', () => {
    // 判据面与被判面**同面**：读服务端源码里的 SQL 字面量，不是再抄一份常量。
    // 哪边单方面加了状态值 / 改了锚，这里必红——「谓词挡了但标记不出现」那类
    // 半截改动在运行时是**静默**的，只有静态断言拦得住。
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'packages/server/src/db/repository/chunks.ts'),
      'utf8'
    )
    const sql = src.match(/NOT IN \(([^)]*)\)/g) ?? []
    expect(sql.length).toBeGreaterThan(0)
    const fromSql = new Set(sql.flatMap((s) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1])))
    expect([...fromSql].sort()).toEqual([...RETIRED_STATUSES].sort())

    expect(src).toContain(`section_anchor = '${TOMBSTONE_ANCHOR}'`)
  })

  it('导入侧同名常量真的从 chunks.ts 导出（防两处各写一份字面量）', async () => {
    const serverChunks = await import('../../packages/server/src/db/repository/chunks.js')
    expect(serverChunks.TOMBSTONE_ANCHOR).toBe(TOMBSTONE_ANCHOR)
    expect([...serverChunks.RETIRED_STATUSES].sort()).toEqual([...RETIRED_STATUSES].sort())
  })
})

// ─── 票午 · 嵌入超时与批大小解耦（走多批 + 失败重试）─────

/** 多节件：n 个 `## 小节` ⇒ n 片（切片器一节一片）——用来把「切批」变成可观测量 */
function multiSectionDoc(n) {
  // evidence 非空是准入硬条件（S2 fail-closed）——缺了它整件会被跳过，根本走不到嵌入
  const meta = {
    type: 'decision',
    date: '2026-09-12',
    status: 'accepted',
    evidence: [{ kind: 'commit', ref: 'abc1234' }],
  }
  const parts = ['---', fm(meta), '---', '', '# 多节件', '']
  for (let i = 1; i <= n; i++) parts.push(`## 第 ${i} 节`, '', `第 ${i} 节的正文。`, '')
  return parts.join('\n')
}

/**
 * 真起一个 127.0.0.1 stub sidecar（/health + /v1/embeddings）。
 * `failFirst` > 0 ⇒ 前 N 次嵌入请求立即回 500（不挂起，无时序竞态）。
 */
async function startEmbedStub({ failFirst = 0 } = {}) {
  let remainingFailures = failFirst
  const hits = { health: 0, embeddings: 0 }
  const batchSizes = []

  const server = createServer((req, res) => {
    if (req.url === '/health') {
      hits.health++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ready: true, model: 'stub', dim: 512 }))
      return
    }
    if (req.url === '/v1/embeddings' && req.method === 'POST') {
      hits.embeddings++
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const input = JSON.parse(Buffer.concat(chunks).toString()).input
        const texts = typeof input === 'string' ? [input] : input
        batchSizes.push(texts.length) // 失败批也记——好断「重试的是同一批」
        if (remainingFailures > 0) {
          remainingFailures--
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, reason: 'boom' }))
          return
        }
        const data = texts.map((t, index) => ({ index, embedding: vecFor(t) }))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ model: 'stub', dim: 512, data }))
      })
      return
    }
    res.writeHead(404).end()
  })

  // 端口必须能被 fetch 触达：`listen(0)` 偶尔分到 WHATWG 禁用端口黑名单里的端口，
  // 那种端口上服务在听、fetch 却永久 `bad port` ⇒ 被测的重试路径吃满超时。见 test-helpers。
  const port = await listenFetchable(server)
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    hits,
    batchSizes,
    close: () => new Promise((r) => server.close(() => r())),
  }
}

describe('票午 切批 + 重试（真链路：真 client + 真 HTTP + 真切片器 + 真库）', () => {
  let stub = null
  let prevEnabled

  beforeEach(() => {
    // 真 client 的启用开关；scripts 项目不预设（只有 server 项目设 false）
    prevEnabled = process.env.MEMORY_ENABLED
    process.env.MEMORY_ENABLED = 'true'
  })

  afterEach(async () => {
    if (stub) {
      await stub.close()
      stub = null
    }
    if (prevEnabled === undefined) delete process.env.MEMORY_ENABLED
    else process.env.MEMORY_ENABLED = prevEnabled
  })

  const chunkCount = (rel) =>
    getDb().prepare('SELECT COUNT(*) c FROM chunks WHERE doc_path = ?').get(rel).c

  it('D4 首败 + 重试成功 ⇒ 该件**完整入库**（不是整件白跑）', async () => {
    stub = await startEmbedStub({ failFirst: 1 })
    const client = new EmbeddingClient({ baseUrl: stub.baseUrl, batchSize: 2 })
    writeFiles(root, { 'docs/adr/multi.md': multiSectionDoc(5) })
    initGitRepo(root)

    const report = await scan({ embed: client })

    expect(report.errors).toEqual([])
    expect(report.inserted).toBe(5) // 5 片全写
    expect(chunkCount('docs/adr/multi.md')).toBe(5)
    // (a) 切批真的生效：整件一次会是 [5]；这里 3 批，首批失败后**重试的是同一批**
    expect(stub.batchSizes).toEqual([2, 2, 2, 1])
    expect(stub.hits.embeddings).toBe(4) // 3 批 + 1 次重试——空转的重试会停在 3
  })

  it('重试也失败 ⇒ 该件一行不写（契约 ①：写库粒度**仍是整件**，重试不改它）', async () => {
    stub = await startEmbedStub({ failFirst: 99 })
    const client = new EmbeddingClient({ baseUrl: stub.baseUrl, batchSize: 2 })
    writeFiles(root, { 'docs/adr/multi.md': multiSectionDoc(5) })
    initGitRepo(root)

    const report = await scan({ embed: client })

    expect(report.errors).toHaveLength(1)
    expect(report.errors[0]).toMatchObject({ path: 'docs/adr/multi.md', reason: 'embed-failed' })
    expect(report.inserted).toBe(0)
    expect(chunkCount('docs/adr/multi.md')).toBe(0) // 半截索引比没索引更坏
  })

  it('承重反例 D1 的扫描器面：批大小 = MAX_BATCH（整件一次）⇒ 请求体骤增', async () => {
    stub = await startEmbedStub()
    const oneShot = new EmbeddingClient({ baseUrl: stub.baseUrl, batchSize: 64 })
    writeFiles(root, { 'docs/adr/multi.md': multiSectionDoc(5) })
    initGitRepo(root)

    await scan({ embed: oneShot })

    // 同一件文档：不切 ⇒ 一个请求装 5 片（票午现状 ① 的形态）；切（batchSize 2）⇒ [2,2,2,1]
    expect(stub.batchSizes).toEqual([5])
  })
})
