/**
 * `node-version-guard.mjs` 测试 —— 被测面 = 「Node 运行时下限」这一个口径，
 * 分五组（票 §7-3 / §7-4 / §7-5）：
 *
 * 1. 版本比较纯函数边界
 * 2. 拒绝路径（出口注入 + 工具面清单防漂移）
 * 3. **接线面**静态断言 —— 防「纯函数绿但没接上线」。本单最容易假绿的地方是
 *    `mcp-server.mjs` 把守卫 import 写对、却让 utils 保持**静态** import：
 *    ESM 先加载完整个模块图再求值，`.ts` 的 ERR_UNKNOWN_FILE_EXTENSION 抛在
 *    加载阶段 ⇒ 守卫顶层永远轮不到执行，而所有纯函数单测照样全绿。
 * 4. 端到端真跑 —— 拒绝路径**真**启动一次真实入口（`--import` data: URL 伪造
 *    `process.versions.node`，不落临时文件），并有一条正向对照证明不误伤正常启动
 * 5. 口径一致性静态断言 —— `engines.node` ↔ README 三处 ↔ `.husky/commit-msg`
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MIN_NODE_VERSION,
  GUARD_EXIT_CODE,
  parseSemver,
  compareSemver,
  isSupportedNodeVersion,
  buildUnsupportedMessage,
  assertNodeVersion,
} from './node-version-guard.mjs'
import { MCP_TOOLS } from './mcp-server-utils.mjs'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(SCRIPTS_DIR, '..')

/** 读仓库内文件（测试只读源，不改） */
function readRepo(...segments) {
  return readFileSync(resolve(ROOT, ...segments), 'utf8')
}

/** 源码里某片段所在行号（1 起）；找不到返回 -1 */
function lineOf(source, needle) {
  const lines = source.split('\n')
  const index = lines.findIndex((line) => line.includes(needle))
  return index === -1 ? -1 : index + 1
}

// ─────────────────────────────────────────────────────────────
describe('版本比较纯函数', () => {
  it('parseSemver：三段解析 + 前后缀容忍 + 不可解析返回 null', () => {
    expect(parseSemver('22.18.0')).toEqual([22, 18, 0])
    expect(parseSemver('v24.14.0')).toEqual([24, 14, 0])
    // 预发布/构建后缀忽略（22.18.0-rc.1 按 22.18.0 判）
    expect(parseSemver('24.0.0-nightly20250101')).toEqual([24, 0, 0])
    expect(parseSemver('22.18.0+build.7')).toEqual([22, 18, 0])
    expect(parseSemver('22.18')).toBeNull()
    expect(parseSemver('not-a-version')).toBeNull()
    expect(parseSemver(undefined)).toBeNull()
    expect(parseSemver(null)).toBeNull()
  })

  it('compareSemver：数值比较（不是字符串比较）', () => {
    // 字符串比较会把 '22.9.0' 判成大于 '22.18.0' —— 这条钉的就是这个陷阱
    expect(compareSemver('22.9.0', '22.18.0')).toBe(-1)
    expect(compareSemver('22.18.0', '22.18.0')).toBe(0)
    expect(compareSemver('24.14.0', '22.18.0')).toBe(1)
    expect(compareSemver('22.17.9', '22.18.0')).toBe(-1)
    expect(() => compareSemver('bogus', '22.18.0')).toThrow()
  })

  it('isSupportedNodeVersion：边界三例（票 §7-4）+ 大版本跨越 + 不可解析判拒', () => {
    expect(isSupportedNodeVersion('22.17.9')).toBe(false)
    expect(isSupportedNodeVersion('22.18.0')).toBe(true)
    expect(isSupportedNodeVersion('24.14.0')).toBe(true)
    expect(isSupportedNodeVersion('22.18.1')).toBe(true)
    expect(isSupportedNodeVersion('23.0.0')).toBe(true) // 23 > 22.18，不因「奇偶」判拒
    // fail-closed：认不出版本时放行 = 退回本守卫要防的「静默哑掉」
    expect(isSupportedNodeVersion('(读不到)')).toBe(false)
    // 当前运行版本必然受支持（否则本测试进程早就被顶层自检杀掉了）
    expect(isSupportedNodeVersion(process.versions.node)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────
describe('拒绝路径', () => {
  it('不满足下限 → 写 stderr + 以 GUARD_EXIT_CODE 退出', () => {
    const written = []
    const exits = []
    const passed = assertNodeVersion({
      version: '22.17.9',
      stderr: { write: (chunk) => written.push(chunk) },
      exit: (code) => exits.push(code),
    })

    expect(passed).toBe(false)
    expect(exits).toEqual([GUARD_EXIT_CODE])
    expect(exits[0]).not.toBe(0) // 非 0 —— harness 才判得出失败
    const text = written.join('')
    expect(text).toContain(`需要 Node >= ${MIN_NODE_VERSION}`)
    expect(text).toContain('22.17.9')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('满足下限 → 不写 stderr、不退出', () => {
    const written = []
    const exits = []
    const passed = assertNodeVersion({
      version: '24.14.0',
      stderr: { write: (chunk) => written.push(chunk) },
      exit: (code) => exits.push(code),
    })

    expect(passed).toBe(true)
    expect(exits).toEqual([])
    expect(written).toEqual([])
  })

  it('文案列全「哪些工具面会死」，且与 MCP_TOOLS 逐名一致（加工具不改文案即变红）', () => {
    const message = buildUnsupportedMessage('22.17.9')
    expect(MCP_TOOLS.length).toBeGreaterThan(0)
    for (const tool of MCP_TOOLS) {
      expect(message, `守卫文案漏了工具面 ${tool.name}`).toContain(tool.name)
    }
  })
})

// ─────────────────────────────────────────────────────────────
describe('接线面（防「纯函数绿但没接上线」）', () => {
  it('守卫是 mcp-server.mjs 的第一条 import，且排在 utils 之前', () => {
    const source = readRepo('scripts', 'mcp-server.mjs')
    const guardLine = lineOf(source, "import './node-version-guard.mjs'")
    const utilsLine = lineOf(source, "await import('./mcp-server-utils.mjs')")

    expect(guardLine, 'mcp-server.mjs 里找不到守卫 import').toBeGreaterThan(0)
    expect(utilsLine, 'mcp-server.mjs 里找不到对 utils 的引用').toBeGreaterThan(0)
    expect(guardLine).toBeLessThan(utilsLine)

    // 「第一条」= 它之前没有任何 import 语句（顺序错了 = 守卫被别的 import 抢先）
    const firstImport = source
      .split('\n')
      .map((line, index) => ({ text: line.trim(), no: index + 1 }))
      .find(({ text }) => /^import[\s'"]/.test(text))
    expect(firstImport?.no).toBe(guardLine)
  })

  it('utils 走**动态** import（改回静态 ⇒ 守卫永不执行，加载期就死于 .ts）', () => {
    const source = readRepo('scripts', 'mcp-server.mjs')
    expect(source).toMatch(/await import\('\.\/mcp-server-utils\.mjs'\)/)
    // 静态形态若回归，守卫的接线就是假的 —— 这条与上一条共同构成「真接上线」判据
    expect(source).not.toMatch(/from\s+'\.\/mcp-server-utils\.mjs'/)
  })

  it('守卫模块零依赖（尤其不含 .ts 引入）——否则自己就是故障点', () => {
    const guardSource = readRepo('scripts', 'node-version-guard.mjs')
    expect(guardSource).not.toMatch(/\.ts['"]/)
    const importLines = guardSource
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^import[\s'"(]/.test(line))
    expect(importLines).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────
describe('端到端：真跑 MCP server 入口', () => {
  const SERVER_ENTRY = resolve(SCRIPTS_DIR, 'mcp-server.mjs')
  const INIT_LINE =
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'node-version-guard.test', version: '0' },
      },
    }) + '\n'

  /** 用 `--import` 的 data: URL 预载脚本伪造 `process.versions.node`（不落临时文件） */
  function spawnWithFakedNodeVersion(version) {
    const stub =
      `data:text/javascript,Object.defineProperty(process.versions,'node',` +
      `{value:'${version}',configurable:true,writable:true})`
    return spawnSync(process.execPath, ['--import', stub, SERVER_ENTRY], {
      input: '',
      encoding: 'utf8',
      timeout: 30_000,
    })
  }

  it('伪造 Node 22.17.9 启动真实入口 → exit 1 + stderr 全套诊断 + stdout 零输出', () => {
    const result = spawnWithFakedNodeVersion('22.17.9')

    expect(result.status).toBe(GUARD_EXIT_CODE)
    expect(result.stderr).toContain(`需要 Node >= ${MIN_NODE_VERSION}`)
    expect(result.stderr).toContain('22.17.9')
    expect(result.stderr).toContain('post_message') // 「哪些工具面会死」
    expect(result.stderr).toContain('ERR_UNKNOWN_FILE_EXTENSION') // 说清根因
    expect(result.stdout).toBe('') // 一个 JSON-RPC 字节都不该吐给 harness
  })

  it('对照：不伪造版本 → initialize 握手成功（守卫不误伤正常启动）', () => {
    const result = spawnSync(process.execPath, [SERVER_ENTRY], {
      input: INIT_LINE,
      encoding: 'utf8',
      timeout: 30_000,
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('"serverInfo"')
    expect(result.stdout).toContain('"catstudy"')
    expect(result.stderr).not.toContain('拒绝启动')
  })
})

// ─────────────────────────────────────────────────────────────
/**
 * 口径一致性（票 §7-5）：全仓「Node 版本下限」复述面共 5 处，全部必须等于
 * `package.json` 的 `engines.node` 下限。锚是**显式**的——格式漂移会让锚失配、
 * 测试变红，这正是有意的（宁可挡提交，也不静默漏检）。
 *
 * 面的来源：票 §3-3 扫出 4 处（README ×3 + .husky/commit-msg）；第 5 处
 * `CONTRIBUTING.md` 是 README 门面重写时新增的复述面——**新增复述面必须同批入锚**，
 * 否则「全仓一致」这个断言在新增的那一刻就不成立了（审查 P2-2 实证：
 * 改 CONTRIBUTING 字面量 → 本组不红）。
 * 真空性反对照：改其中任一处版本字面量 → 本组必红（实测见交付说明）。
 */
describe('口径一致性（防再度漂移）', () => {
  /** 声明面：唯一真相源 */
  const DECLARATION = {
    file: 'package.json',
    label: 'engines.node',
    pattern: /"node"\s*:\s*">=\s*(\d+\.\d+\.\d+)"/,
  }
  /** 复述面：文档/注释里的下限声称（票 §3-3 扫出的 4 处 + README 重写新增的 CONTRIBUTING.md） */
  const CLAIMS = [
    {
      file: 'README.md',
      label: '依赖表',
      pattern: /\[Node\.js\]\(https:\/\/nodejs\.org\/\)\s*\|\s*>=\s*(\d+\.\d+\.\d+)/,
    },
    {
      file: 'README.md',
      label: '安装命令注释',
      pattern: /node --version\s*#\s*确认\s*>=\s*(\d+\.\d+\.\d+)/,
    },
    {
      file: 'README.md',
      label: '技术栈表',
      pattern: /\|\s*运行时\s*\|\s*Node\.js\s*(\d+\.\d+\.\d+)\+/,
    },
    {
      file: 'CONTRIBUTING.md',
      label: '环境准备注释',
      pattern: /Node\.js\s*>=\s*(\d+\.\d+\.\d+)/,
    },
    {
      file: '.husky/commit-msg',
      label: 'node:sqlite 注释',
      pattern: /Node\s*≥\s*(\d+\.\d+\.\d+)/,
    },
  ]

  function extract({ file, label, pattern }) {
    const matched = pattern.exec(readRepo(...file.split('/')))
    expect(matched, `${file} 的「${label}」锚失配——口径面或格式已漂移，请同步本测试`).not.toBeNull()
    return matched[1]
  }

  it('package.json 声明了 engines.node（下限纯声明，不满足时 pnpm WARN 不阻断）', () => {
    const declared = extract(DECLARATION)
    expect(parseSemver(declared)).not.toBeNull()
    // 守卫常量与声明同源：两处真相漂移 ⇒ 守卫按旧值拦人 / 放过
    expect(MIN_NODE_VERSION).toBe(declared)
  })

  it.each(CLAIMS)('$file · $label 的下限字面量 == engines 声明', (claim) => {
    expect(extract(claim)).toBe(MIN_NODE_VERSION)
  })
})
