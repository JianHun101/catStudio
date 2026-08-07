import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { writeFileSync } from 'node:fs'
// 纯函数（不碰文件）静态导入；文件操作函数经动态导入拿独立隔离目录实例（见下）
import { isRestartRequestContent, extractRestartReason } from './restart-request.js'
import type { RestartRequestFile } from './restart-request.js'

// ─── 重启请求识别契约（行首命中兼容 + 嵌中命中）──────
// 第六次行首事故根治：agent 回复天然带叙述前文（「收到…请求」合并为一条消息），
// 行首 startsWith 与真实产出模式不匹配——识别放宽为「包含【重启请求】原因：」即命中。

describe('isRestartRequestContent', () => {
  it('嵌中命中：叙述 + 「：【重启请求】原因：」合并消息 → true（agent 真实产出模式）', () => {
    expect(isRestartRequestContent('收到。先自查链路：【重启请求】原因：服务器卡了')).toBe(true)
    expect(extractRestartReason('收到。先自查链路：【重启请求】原因：服务器卡了')).toBe(
      '服务器卡了'
    )
  })

  it('行首「【重启请求】原因：」依然命中（不回归）', () => {
    expect(isRestartRequestContent('【重启请求】原因：测试重启')).toBe(true)
    expect(extractRestartReason('【重启请求】原因：测试重启')).toBe('测试重启')
  })

  it('行首不带原因壳（「【重启请求】重启」）仍命中——行首兼容语义保留', () => {
    expect(isRestartRequestContent('【重启请求】重启')).toBe(true)
    expect(extractRestartReason('【重启请求】重启')).toBe('重启')
  })

  it('复盘文字「【重启请求】嵌在长汇报中间」不含「原因：」→ 不误触发', () => {
    expect(isRestartRequestContent('上次把【重启请求】嵌在长汇报中间，识别失败了')).toBe(false)
  })

  it('非重启消息 → 不命中', () => {
    expect(isRestartRequestContent('你好，处理完了')).toBe(false)
    expect(extractRestartReason('你好，处理完了')).toBe('用户请求')
  })

  it('reason 缺省兜底：空原因 / 原因壳后无内容 → 用户请求', () => {
    expect(extractRestartReason('【重启请求】原因：')).toBe('用户请求')
    expect(extractRestartReason('【重启请求】原因：   ')).toBe('用户请求')
  })

  it('reason 只取到段落行尾（下个换行为止）', () => {
    expect(extractRestartReason('【重启请求】原因：卡住了\n继续汇报其他事')).toBe('卡住了')
  })

  // ─── 契约归一化（『重启请求』≡【重启请求】）──────
  // 6231ec9 防复述抢占把 seed-data prompt 的重启格式改成『』（直角引号），识别层仍是【】
  // （方括号）——契约漂移导致 LLM 照 prompt 输出『』时按钮不出现（运行时断链事故）。
  // 归一化后两写法等价；防复述语义（复盘文字不误触发）经下面用例钉死。

  it('嵌中『重启请求』（prompt 教的写法）命中 + reason 提取（归一化后与【】等价）', () => {
    expect(isRestartRequestContent('收到。先自查链路：『重启请求』原因：服务器卡了')).toBe(true)
    expect(extractRestartReason('收到。先自查链路：『重启请求』原因：服务器卡了')).toBe(
      '服务器卡了'
    )
  })

  it('行首『重启请求』命中（含不带原因壳，行首兼容语义对齐）', () => {
    expect(isRestartRequestContent('『重启请求』原因：测试重启')).toBe(true)
    expect(extractRestartReason('『重启请求』原因：测试重启')).toBe('测试重启')
    expect(isRestartRequestContent('『重启请求』重启')).toBe(true)
    expect(extractRestartReason('『重启请求』重启')).toBe('重启')
  })

  it('防复述语义钉死：复盘文字「用『重启请求』四字即可」不误触发（无原因：连续串）', () => {
    expect(isRestartRequestContent('讨论重启机制时用『重启请求』四字即可')).toBe(false)
    // 『原因：』壳拆开叙述（「四字 + 」间隔，仿 seed-data prompt 句式、『』在句中）
    // 同样不构成「【重启请求】原因：」连续串 → 不误触发
    expect(isRestartRequestContent('重启请求格式为『重启请求』四字 + 『原因：』壳')).toBe(false)
    // 无原因壳时 after 原样返回是既有语义（与「【重启请求】重启 → 重启」等价，『』不例外）
    expect(extractRestartReason('讨论重启机制时用『重启请求』四字即可')).toBe('四字即可')
  })

  // ─── 容错三件套（2026-08-07 店长触发失败根治）──────
  // 事故：店长发「重启请求 原因：xxx」——裸四字（无『』）+ 空格，识别完全不命中。
  // 识别层对 LLM 产出方差放宽容忍（标记无括号 / 空格 / 半角冒号），防下次再漏。

  it('容错①：标记与原因壳之间有空格 → 命中（自然行文会加空格）', () => {
    expect(isRestartRequestContent('收到。先自查链路：【重启请求】 原因：服务器卡了')).toBe(true)
    expect(extractRestartReason('收到。先自查链路：【重启请求】 原因：服务器卡了')).toBe(
      '服务器卡了'
    )
  })

  it('容错②：裸四字「重启请求」无括号 → 命中（prompt「四字」表述诱导省略括号的真实失败模式）', () => {
    expect(isRestartRequestContent('收到。先自查链路：重启请求 原因：服务器卡了')).toBe(true)
    expect(extractRestartReason('收到。先自查链路：重启请求 原因：服务器卡了')).toBe('服务器卡了')
    expect(isRestartRequestContent('重启请求原因：测试')).toBe(true)
    expect(extractRestartReason('重启请求原因：测试')).toBe('测试')
  })

  it('容错③：半角冒号「原因:」→ 命中（与 extractRestartReason 的 [:：] 对齐，消除识别/提取双契约）', () => {
    expect(isRestartRequestContent('【重启请求】原因: 测试')).toBe(true)
    expect(extractRestartReason('【重启请求】原因: 测试')).toBe('测试')
  })

  it('防复述扩展：间隔词打断「重启请求…原因：」连续串 → 不误触发', () => {
    expect(isRestartRequestContent('上次说了重启请求格式为【重启请求】四字 + 原因：壳')).toBe(false)
  })

  it('复述抢占残余面（已知限制，prompt 缓解）：完整叙述「重启请求 原因：」会命中——代价不对称接受', () => {
    // 误触发 = 气泡按钮可见可取消 + TTL 10 分钟；漏触发 = 用户手动重启（本次事故代价更高）
    expect(isRestartRequestContent('上次重启请求 原因：服务器卡了，批准后重启完成')).toBe(true)
  })
})

// ─── createRestartRequest 覆盖判定（TTL 覆盖语义）──────
// 覆盖判定 = 「不存在（含损坏）或已过期 → 覆盖」；未过期才保留跳过——含未过期
// pending（同一时间一个生效请求是设计，正在等用户确认的请求不应被新请求顶掉）。
// 隔离目录：本组用例不复用 socketio.test.ts 的共享目录（node_modules/.cache/
// restart-test）——全量并行时两文件用例交错互删同一文件是竞态根源（existsSync
// 通过后文件可能已被对方 afterEach 删掉）。vi.resetModules + vi.stubEnv 让本组
// 用例每次加载独立目录（node_modules/.cache/restart-test-create）的模块实例，
// 与共享目录物理隔离；纯函数用例（isRestartRequestContent 等）不碰文件，不受影响。

const ISOLATED_DIR = 'node_modules/.cache/restart-test-create'

function makeRequest(overrides: Partial<RestartRequestFile> = {}): RestartRequestFile {
  const now = Date.now()
  return {
    messageId: 'msg-test-1',
    sessionId: 'sess-test-1',
    reason: '测试请求',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 10 * 60 * 1000).toISOString(),
    state: 'confirmed',
    ...overrides,
  }
}

describe('createRestartRequest', () => {
  let api: typeof import('./restart-request.js')

  beforeEach(async () => {
    vi.resetModules()
    vi.stubEnv('RESTART_FILES_DIR', ISOLATED_DIR)
    api = await import('./restart-request.js')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    try {
      api.removeRestartRequest()
    } catch {}
  })

  it('文件不存在 → 写入并返回 true', () => {
    expect(api.createRestartRequest(makeRequest())).toBe(true)
    expect(api.readRestartRequest()?.messageId).toBe('msg-test-1')
  })

  it('未过期请求已存在（含 pending）→ 返回 false 跳过，保留首个（同一时间一个生效请求是设计）', () => {
    expect(api.createRestartRequest(makeRequest({ messageId: 'first', state: 'pending' }))).toBe(
      true
    )
    // 新 pending 请求顶不掉未过期的 pending
    expect(api.createRestartRequest(makeRequest({ messageId: 'second', state: 'pending' }))).toBe(
      false
    )
    // confirmed 也顶不掉未过期的 pending（正在等用户确认的请求是权威）
    expect(api.createRestartRequest(makeRequest({ messageId: 'third', state: 'confirmed' }))).toBe(
      false
    )
    expect(api.readRestartRequest()?.messageId).toBe('first')
  })

  it('已过期请求 → 返回 true 覆盖写入（TTL 覆盖语义）', () => {
    const stale = makeRequest({ messageId: 'stale', state: 'pending' })
    stale.createdAt = new Date(Date.now() - 11 * 60 * 1000).toISOString()
    stale.expiresAt = new Date(Date.now() - 60 * 1000).toISOString()
    expect(api.createRestartRequest(stale)).toBe(true)
    expect(api.createRestartRequest(makeRequest({ messageId: 'fresh' }))).toBe(true)
    expect(api.readRestartRequest()?.messageId).toBe('fresh')
  })

  it('损坏文件已存在 → 返回 true 覆盖写入', () => {
    writeFileSync(api.RESTART_REQUEST_FILE, 'not-json{{{')
    expect(api.createRestartRequest(makeRequest({ messageId: 'fixed' }))).toBe(true)
    expect(api.readRestartRequest()?.messageId).toBe('fixed')
  })
})
