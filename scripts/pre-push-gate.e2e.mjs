#!/usr/bin/env node
/**
 * pre-push 审查门禁（T-O）· CLI 级 e2e —— 自包含、可进 CI。
 *
 * 为什么必须**真 git push**：门禁的输入是 git 在 stdin 逐行传的
 * `<local ref> <local sha> <remote ref> <remote sha>`。把 hook 当纯函数喂字符串，
 * 测的是"我以为 git 会传什么"；只有真 push 才验得了「审计对象 == 执行对象」这件事。
 * 旧实现正是没读 stdin（换判据面）才让「HEAD 停在已审点 + 推未审 sha」整条放行。
 *
 * 区分性：非贪婪要求——每个场景同时跑**两份 hook**：
 *   - current = 工作区 `.husky/pre-push`（被测对象，真身，非副本）
 *   - legacy  = 改动前那份 hook 的逐字副本，**按 blob sha 内容寻址**取
 * 打印对照表；标注为 discriminator 的场景断言两者**结论相反**——
 * 「新实现必拦」若在旧实现下也拦，那条断言什么都没证明（恒真门）。
 *
 * 隔离：全部临时目录落在 os.tmpdir()，仓库树零残留（曾把 e2e 临时目录落在仓库根）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(SCRIPTS_DIR, '..')
const HOOKS_CURRENT = join(REPO_ROOT, '.husky')

const TEST_BASE = mkdtempSync(join(tmpdir(), 'catstudy-prepush-e2e-'))

// 崩溃路径也要收：末段的显式 cleanup 只在跑到底时执行，中途 uncaught 会留下
// 一整个 fixture 根（实测踩过一次——首次调试崩溃就残留了一个）。exit 钩子在
// uncaught exception 之后仍会跑，且与显式 cleanup 幂等（force + recursive）。
process.on('exit', () => {
  try {
    rmSync(TEST_BASE, { recursive: true, force: true })
  } catch {}
})

// ─── 计数与断言 ──────────────────────────────────────────────

let passed = 0
let failed = 0
const failures = []

function assert(cond, msg) {
  if (cond) {
    passed++
  } else {
    failed++
    failures.push(msg)
    console.error(`  ❌ ${msg}`)
  }
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex').slice(0, 12)
}

// ─── git 执行：git 环境变量必须清干净 ────────────────────────
// 从 git hook 内嵌跑（或 CI 里带 GIT_DIR）时，残留的 GIT_DIR/GIT_WORK_TREE 会让
// 临时仓库的 git 命令指向宿主仓库。清掉才保证每个 fixture 是它自己。

const GIT_ENV = { ...process.env }
delete GIT_ENV.GIT_DIR
delete GIT_ENV.GIT_WORK_TREE
delete GIT_ENV.GIT_INDEX_FILE
delete GIT_ENV.GIT_COMMON_DIR

/** 空 hooks 目录：临时仓库里的 `git commit` 会触发**真 pre-commit**（`npx lint-staged`
 *  + 全量 pnpm test）——那是宿主仓库的钩子，在 fixture 里必炸且与本票无关。
 *  除 push 外一律用 `-c core.hooksPath=<空目录>` 压掉；push 才放真钩子上场。 */
const NO_HOOKS_DIR = join(TEST_BASE, 'no-hooks')
mkdirSync(NO_HOOKS_DIR, { recursive: true })

function git(repo, args, { noHooks = true } = {}) {
  const full = noHooks
    ? ['-c', `core.hooksPath=${NO_HOOKS_DIR.replace(/\\/g, '/')}`, ...args]
    : args
  return execFileSync('git', full, {
    cwd: repo,
    encoding: 'utf-8',
    env: GIT_ENV,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

let remoteSeq = 0
const repos = []

/** 造一个全新工作仓库 + 空的 bare remote，`core.hooksPath` 指向给定 hook 目录。 */
function newRepo(hooksDir) {
  const repo = mkdtempSync(join(TEST_BASE, 'wt-'))
  repos.push(repo)
  const remote = join(TEST_BASE, `remote-${remoteSeq++}.git`)
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 'prepush-e2e@catstudy.local'])
  git(repo, ['config', 'user.name', 'prepush-e2e'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  // 绝对路径，正斜杠——Windows 下 git 接受 D:/... 形态
  git(repo, ['init', '-q', '--bare', remote.replace(/\\/g, '/')])
  git(repo, ['remote', 'add', 'origin', remote.replace(/\\/g, '/')])
  git(repo, ['config', 'core.hooksPath', hooksDir.replace(/\\/g, '/')])
  // hook 阻断时会调 `node scripts/handoff-gen.mjs --gate-deliver`；stub 掉，
  // 让输出确定（本 e2e 不测补投逻辑，那是 handoff-gen.e2e.mjs 的面）。
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  writeFileSync(join(repo, 'scripts', 'handoff-gen.mjs'), 'process.exit(0)\n')
  return repo
}

function commitFile(repo, name, content, msg) {
  writeFileSync(join(repo, name), content, 'utf-8')
  git(repo, ['add', name])
  git(repo, ['commit', '-q', '-m', msg])
  return git(repo, ['rev-parse', 'HEAD']).trim()
}

function writeGate(repo, sha) {
  writeFileSync(join(repo, '.push-gate'), `${sha}\n`, 'utf-8')
}

/** 跑一次真 push，返回 { code, out }（out = stdout+stderr 合并）。 */
function tryPush(repo, refspecs, opts = {}) {
  const args = ['push']
  if (opts.noVerify) args.push('--no-verify')
  args.push('origin', ...refspecs)
  try {
    // noHooks:false —— 本 e2e 的被测对象就是钩子本身，这里必须放真钩子上场
    const out = git(repo, args, { noHooks: false })
    return { code: 0, out }
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      out: `${err.stdout || ''}${err.stderr || ''}`,
    }
  }
}

/** 直跑 hook（stdin 关闭）——测「无 refspec 回落 HEAD」那条分支。 */
function runHookDirect(repo, hooksDir) {
  const hookPath = join(hooksDir, 'pre-push')
  try {
    const out = execFileSync('sh', [hookPath], {
      cwd: repo,
      encoding: 'utf-8',
      env: GIT_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out }
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      out: `${err.stdout || ''}${err.stderr || ''}`,
    }
  }
}

/** 阻断判据：**非零退出且输出带门禁拒绝标记**。两条标记各有来路——
 *  「推送阻断」= refspec 未审；「.push-gate 内容无效」= 门禁前置拦下。
 *  不能只判 code !== 0：推送因网络/权限失败同样非零，那是假绿门。 */
const BLOCK_MARKERS = ['推送阻断', '.push-gate 内容无效']
const isBlocked = (r) => r.code !== 0 && BLOCK_MARKERS.some((m) => r.out.includes(m))
const isAllowed = (r) => r.code === 0

// ─── legacy 副本：按**内容寻址**取改动前那一份（T-O 复审 必改 1）────
//
// 原实现取 `git show HEAD:.husky/pre-push`——**HEAD 是可变 ref，而本提交自己就
// 移动了它** ⇒ 取回来的是 current 自己，两份 hook 逐字相同：两条自证断言翻红、
// 三条区分性场景退化成「同结论」（实测 HEAD 在本提交上跑出 19 passed / 5 failed）。
// 基线挂在会动的东西上 = 交付物自带一套在 HEAD 上跑红的测试，文件头自称的
// 「自包含、可进 CI」也不成立。改按 blob sha：该对象躺在改动前的 commit 里，
// 与 HEAD / 分支指向哪里无关（`git show <blob>` 对任意可达对象均有效）。
const LEGACY_HOOK_BLOB = '3c9dd3cb96c384efefcd2aa8007740b016544db0' // T-O 改动前的 .husky/pre-push

const legacyDir = mkdtempSync(join(TEST_BASE, 'legacy-hooks-'))
const currentHookContent = readFileSync(join(HOOKS_CURRENT, 'pre-push'), 'utf-8')
let legacyHookContent
try {
  legacyHookContent = execFileSync('git', ['show', LEGACY_HOOK_BLOB], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: GIT_ENV,
  })
} catch (err) {
  // 取不到就**明确报错**，不要静默退化成空串——那会让两条自证断言以「兜住了」
  // 的姿态翻红，掩盖真实原因（对象被 gc / 仓库不完整）。
  console.error(`  ❌ 无法取出 legacy 基线 blob ${LEGACY_HOOK_BLOB}`)
  console.error(`     ${String(err.stderr || err.message).trim()}`)
  console.error('     该 blob = T-O 改动前的 .husky/pre-push；若已被 gc，改用当次 commit 定位。')
  process.exit(1)
}
writeFileSync(join(legacyDir, 'pre-push'), legacyHookContent, { mode: 0o755 })

console.log('📦 pre-push 审查门禁 e2e（T-O）')
console.log('')
console.log(`  仓库根:      ${REPO_ROOT}`)
console.log(`  临时根:      ${TEST_BASE}`)
console.log(`  current hook: ${HOOKS_CURRENT}/pre-push  sha256:${sha256(currentHookContent)}`)
console.log(
  `  legacy  hook: blob ${LEGACY_HOOK_BLOB.slice(0, 12)}（改动前那份）  sha256:${sha256(legacyHookContent)}`
)
console.log('')

// 副本必须**真是**改动前那份——否则「区分性」是在跟自己的影子比。
// 这一条同时证明本单确实改了 hook（没改 = 无从谈区分性）。
assert(
  currentHookContent !== legacyHookContent,
  'legacy 副本应与 current hook 不同（否则本单没改 hook，区分性无从谈起）'
)
// legacy 副本必须走旧逻辑：旧实现无条件 `HEAD_SHA=$(git rev-parse HEAD)`。
assert(
  legacyHookContent.includes('HEAD_SHA=$(git rev-parse HEAD)') &&
    !legacyHookContent.includes('PUSH_SPECS'),
  'legacy 副本应含旧实现的 HEAD 判据（`HEAD_SHA=$(git rev-parse HEAD)`）且不含新实现的 stdin 解析'
)

// ─── 场景 ────────────────────────────────────────────────────
//
// 每个场景自建仓库（互不污染），签名 (hooksDir) => {code, out}。
// expect: 'block' | 'allow'；discriminator: true = 断言 legacy 与 current 结论相反。

const SCENARIOS = [
  {
    id: '1',
    desc: '缺 .push-gate → 拦',
    expect: 'block',
    run: (hooks) => {
      const repo = newRepo(hooks)
      commitFile(repo, 'a.txt', '1', 'c1')
      return tryPush(repo, ['HEAD:refs/heads/main'])
    },
  },
  {
    id: '2',
    desc: '推的正是 .push-gate 那一笔 → 放行',
    expect: 'allow',
    run: (hooks) => {
      const repo = newRepo(hooks)
      const c1 = commitFile(repo, 'a.txt', '1', 'c1')
      writeGate(repo, c1)
      return tryPush(repo, ['HEAD:refs/heads/main'])
    },
  },
  {
    id: '3',
    desc: '★区分性：HEAD 停在已审点，推**另一个未审 sha** → 拦',
    expect: 'block',
    discriminator: true,
    // 旧实现只读 HEAD：HEAD == .push-gate ⇒ exit 0 整条放行（本票靶心）。
    run: (hooks) => {
      const repo = newRepo(hooks)
      const c1 = commitFile(repo, 'a.txt', '1', 'c1')
      const c2 = commitFile(repo, 'a.txt', '2', 'c2')
      // 从 c1 分叉出一条未审支线（与 c2 无祖先关系）
      git(repo, ['checkout', '-q', '-b', 'feat', c1])
      const cFeat = commitFile(repo, 'feat.txt', 'x', 'feat: 未审')
      git(repo, ['checkout', '-q', c2]) // HEAD 回到已审点（detached，与 .push-gate 同值）
      writeGate(repo, c2)
      return tryPush(repo, [`${cFeat}:refs/heads/feat`])
    },
  },
  {
    id: '4',
    desc: '★区分性：一次推多 refspec（一审一未审）→ 拦',
    expect: 'block',
    discriminator: true,
    run: (hooks) => {
      const repo = newRepo(hooks)
      const c1 = commitFile(repo, 'a.txt', '1', 'c1')
      const c2 = commitFile(repo, 'a.txt', '2', 'c2')
      git(repo, ['checkout', '-q', '-b', 'feat', c1])
      const cFeat = commitFile(repo, 'feat.txt', 'x', 'feat: 未审')
      git(repo, ['checkout', '-q', c2])
      writeGate(repo, c2)
      // 一审（c2）一未审（cFeat）在同一条命令里——只看 HEAD 会漏掉后者
      return tryPush(repo, ['HEAD:refs/heads/main', `${cFeat}:refs/heads/feat`])
    },
  },
  {
    id: '5',
    desc: '★区分性：reset/rebase 后无祖先关系 → 拦（旧实现 exit 0）',
    expect: 'block',
    discriminator: true,
    run: (hooks) => {
      const repo = newRepo(hooks)
      const c1 = commitFile(repo, 'a.txt', '1', 'c1')
      const c2 = commitFile(repo, 'a.txt', '2', 'c2')
      writeGate(repo, c2)
      // reset 回去再造一笔（rebase 形态：新 sha 与已审线无祖先关系）
      git(repo, ['reset', '-q', '--hard', c1])
      const c2b = commitFile(repo, 'a.txt', '2-rebased', 'c2 (rebased)')
      assert(c2b !== c2, 'rebase 场景应产出与 c2 不同的新 sha')
      return tryPush(repo, ['HEAD:refs/heads/main'])
    },
  },
  {
    id: '6',
    desc: '阳性对照：推**已审历史的子集**（落后分支，如 main）→ 放行',
    expect: 'allow',
    // 这是新实现引入的**显式**判据（旧实现走「历史不一致 exit 0」放行，理由不同）。
    // 无此条会掉进「无祖先关系」被误拦 ⇒ 误拦的压力把人推向 --no-verify。
    run: (hooks) => {
      const repo = newRepo(hooks)
      const c1 = commitFile(repo, 'a.txt', '1', 'c1')
      commitFile(repo, 'a.txt', '2', 'c2')
      const c3 = commitFile(repo, 'a.txt', '3', 'c3')
      writeGate(repo, c3) // 已审点 = c3（模拟 dev），推 c1（模拟落后的 main）
      return tryPush(repo, [`${c1}:refs/heads/main`])
    },
  },
  {
    id: '7',
    desc: '逃生口：--no-verify 仍绕过 → 放行',
    expect: 'allow',
    run: (hooks) => {
      const repo = newRepo(hooks)
      const c1 = commitFile(repo, 'a.txt', '1', 'c1')
      commitFile(repo, 'a.txt', '2', 'c2')
      writeGate(repo, c1) // c2 未审
      return tryPush(repo, ['HEAD:refs/heads/main'], { noVerify: true })
    },
  },
  {
    id: '8',
    desc: '★区分性：删除远端 ref + HEAD 未审 → 放行（无对象可审，不回落 HEAD）',
    expect: 'allow',
    discriminator: true,
    // 删除 ref 是**一行合法 refspec**（local sha 全 0），无对象可审 ⇒ 放行，
    // 与 HEAD 的审查状态无关。旧实现不读 stdin ⇒ 落 HEAD 回落分支，按 HEAD
    // 判成「有未审 commit」拦下（实测复现）。
    // 原 fixture 把 HEAD 摆在 gate 上，测到的是回落的**幸运路径**、不是本场景
    // 自称的那条 ⇒ 假绿；故 HEAD 必须离 gate 一格。
    run: (hooks) => {
      const repo = newRepo(hooks)
      const c1 = commitFile(repo, 'a.txt', '1', 'c1')
      const c2 = commitFile(repo, 'a.txt', '2', 'c2')
      // 先把 feat 推上去（绕过门禁），再删
      tryPush(repo, [`${c1}:refs/heads/feat`], { noVerify: true })
      writeGate(repo, c1) // 已审点 = c1；HEAD = c2 **未审**
      return tryPush(repo, [':refs/heads/feat'])
    },
  },
  {
    id: '9',
    desc: '无 stdin（人工直跑 hook）→ 回落 HEAD 校验：未审 → 拦',
    expect: 'block',
    run: (hooks) => {
      const repo = newRepo(hooks)
      const c1 = commitFile(repo, 'a.txt', '1', 'c1')
      commitFile(repo, 'a.txt', '2', 'c2')
      writeGate(repo, c1)
      return runHookDirect(repo, hooks)
    },
  },
  {
    id: '10',
    desc: '.push-gate 内容非法（非 40 位 hex）→ 拦',
    expect: 'block',
    run: (hooks) => {
      const repo = newRepo(hooks)
      commitFile(repo, 'a.txt', '1', 'c1')
      writeFileSync(join(repo, '.push-gate'), 'not-a-sha\n', 'utf-8')
      return tryPush(repo, ['HEAD:refs/heads/main'])
    },
  },
  {
    id: '11',
    desc: '★区分性：删除远端 ref 与未审 refspec 同推 → 拦（删除不掩盖未审）',
    expect: 'block',
    discriminator: true,
    // 一行删除 + 一行未审：删除被放行**不等于**整条推送放行。
    run: (hooks) => {
      const repo = newRepo(hooks)
      const c1 = commitFile(repo, 'a.txt', '1', 'c1')
      const c2 = commitFile(repo, 'a.txt', '2', 'c2')
      git(repo, ['checkout', '-q', '-b', 'feat', c1])
      const cFeat = commitFile(repo, 'feat.txt', 'x', 'feat: 未审')
      git(repo, ['checkout', '-q', c2])
      tryPush(repo, [`${c1}:refs/heads/doomed`], { noVerify: true })
      writeGate(repo, c2) // HEAD == gate（旧实现据此放行）
      return tryPush(repo, [':refs/heads/doomed', `${cFeat}:refs/heads/feat`])
    },
  },
  {
    id: '12',
    desc: '回归对照：删除远端 ref + HEAD 已审 → 放行（结论与 HEAD 审查状态无关）',
    expect: 'allow',
    run: (hooks) => {
      const repo = newRepo(hooks)
      const c1 = commitFile(repo, 'a.txt', '1', 'c1')
      const c2 = commitFile(repo, 'a.txt', '2', 'c2')
      tryPush(repo, [`${c1}:refs/heads/feat`], { noVerify: true })
      writeGate(repo, c2) // 已审点 == HEAD
      return tryPush(repo, [':refs/heads/feat'])
    },
  },
]

// ─── 跑场景 ──────────────────────────────────────────────────

const rows = []
for (const sc of SCENARIOS) {
  const legacy = sc.run(legacyDir)
  const current = sc.run(HOOKS_CURRENT)
  rows.push({ ...sc, legacy, current })

  const want = sc.expect === 'block' ? isBlocked : isAllowed
  const legacySame = sc.expect === 'block' ? isBlocked(legacy) : isAllowed(legacy)

  assert(
    want(current),
    `场景 ${sc.id}（${sc.desc}）：current 应 ${sc.expect}，实得 code=${current.code}`
  )
  if (sc.discriminator) {
    assert(
      !legacySame,
      `场景 ${sc.id}（${sc.desc}）：legacy 旧实现应与新实现**结论相反**（区分性），实得同结论`
    )
  } else {
    assert(legacySame, `场景 ${sc.id}（${sc.desc}）：legacy 应同为 ${sc.expect}（回归对照）`)
  }
  console.log(`  ${sc.id}: ${sc.desc} ✅`)
}

// ─── 近因对照：必改 2 的「现状必红」自证 ──────────────────────
//
// legacy 列是**改动前（pre-T-O）**那份 hook。它在「删 ref + HEAD 未审」下也拦，
// 但拦的理由不同（压根不读 stdin、纯按 HEAD 判）——所以 legacy 列证明的是
// 「本票整体改了行为」，**不证明**「计数拆分这一处修的是真缺口」。
// 故补一份**直接父提交**的 hook（T-O 首版，含回落 bug）作近因基线：
// 它必须在该场景**拦**，否则复审要求的「现状必红」不成立。

const NEAR_CAUSE_HOOK_BLOB = '64ab61e681cc5a052b2edcdf68f1a95febf62815' // T-O 首版（含回落 bug）
const nearCauseDir = mkdtempSync(join(TEST_BASE, 'nearcause-hooks-'))
const nearCauseHookContent = execFileSync('git', ['show', NEAR_CAUSE_HOOK_BLOB], {
  cwd: REPO_ROOT,
  encoding: 'utf-8',
  env: GIT_ENV,
})
writeFileSync(join(nearCauseDir, 'pre-push'), nearCauseHookContent, { mode: 0o755 })

// 近因基线必须**真是**近因：既不等于远因 legacy、也不等于 current，
// 且含 T-O 首版的 stdin 解析、不含本笔新引入的 saw_refspec。
assert(
  nearCauseHookContent !== legacyHookContent && nearCauseHookContent !== currentHookContent,
  '近因基线应既不等于 pre-T-O legacy、也不等于 current（否则它证明不了「这一处修复」）'
)
assert(
  nearCauseHookContent.includes('PUSH_SPECS') && !nearCauseHookContent.includes('saw_refspec'),
  '近因基线应含 T-O 首版的 stdin 解析、且不含本笔新引入的 saw_refspec'
)

const sc8 = SCENARIOS.find((s) => s.id === '8')
const nearCause8 = sc8.run(nearCauseDir)
const row8 = rows.find((r) => r.id === '8')
assert(
  isBlocked(nearCause8),
  '必改 2·近因对照：T-O 首版在「删远端 ref + HEAD 未审」下应 **拦**（= 现状必红）；实得放行'
)
assert(isAllowed(row8.current), '必改 2·近因对照：本笔修复后同场景应 **放行**；实得拦')
console.log('')
console.log(
  `  必改 2 近因对照（删远端 ref + HEAD 未审）：` +
    `T-O 首版(blob ${NEAR_CAUSE_HOOK_BLOB.slice(0, 12)})=${isBlocked(nearCause8) ? '拦' : '放行'}` +
    ` / 本笔=${isAllowed(row8.current) ? '放行' : '拦'}`
)

// ─── 对照表 ──────────────────────────────────────────────────

// 不用花框表格：CJK 是双宽字符，`padEnd` 按码点数补空格 ⇒ 中英混排必然错位，
// 要修就得引一个显示宽度库。改成「结论在前、逐行缩进」，零对齐依赖。
console.log('')
console.log(
  `  区分性对照（legacy = blob ${LEGACY_HOOK_BLOB.slice(0, 12)} 改动前实现 / current = 工作区实现）：`
)
for (const r of rows) {
  const cell = (x) => (isBlocked(x) ? '拦' : x.code === 0 ? '放行' : `非零(code=${x.code})`)
  console.log(
    `    ${String(r.id).padStart(2)}. legacy=${cell(r.legacy)} / current=${cell(r.current)}` +
      `${r.discriminator ? '  ★ 结论相反（区分性成立）' : ''}  — ${r.desc}`
  )
}

// ─── Cleanup ─────────────────────────────────────────────────

rmSync(TEST_BASE, { recursive: true, force: true })
if (existsSync(TEST_BASE)) {
  console.error(`  ⚠️  临时目录未删净: ${TEST_BASE}`)
}

// ─── 结果汇总 ────────────────────────────────────────────────

console.log('')
console.log('═'.repeat(50))
console.log(`  ${passed} passed, ${failed} failed, ${passed + failed} total`)
console.log('═'.repeat(50))

if (failed > 0) {
  console.error('')
  console.error('失败项：')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
