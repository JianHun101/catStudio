/**
 * R14a 角标引用探针测试。
 *
 * 三层：
 *   - **纯单元**：注入串拼装 / 指示语插入位置 / `[n]` 解析（判据面三条：代码字面量
 *     [围栏 + 内联码] / 复述指示语）/ 四格归类 / reclassify 重算（幂等 + 透传）
 *     ——喂手搓输入，可穷举、不碰库不碰 LLM；
 *   - **非退化单元**（票面 §八.6 承重）：形状漂移必须**返回显式状态**，不许静默返回
 *     0 字。喂假 adapter 造出「见 chunk 但无 `content`」这种形态，钉住它落
 *     `shape-mismatch` 而**不是** `empty-reply`。仅写注释不算——本仓已踩过一次
 *     （`chunk.text` vs `Chunk.content` ⇒ 四只同形假读数）；
 *   - **契约静态断言（形状规格守卫）**：本探针**自己拼**注入串，而生产是
 *     `renderSections` 拼的。两边一旦漂移，探针照跑、读数看起来完全正常，但
 *     「与生产同形」这条前提**静默失效**——测的就不再是生产会注入的东西。
 *     这是 `.mjs` 探针唯一无法靠类型系统兜住的接缝，故直接读源码断言格式字面量。
 *
 * **不测什么**：`s0`/`s1`/`s2` 三条真实调用链（要真库 + 真 provider key + 真 LLM
 * 往返）——那属「系统级 e2e，手动跑」那一档，不在这里假装绿。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  ECHO_NGRAM,
  MEMORY_BLOCK_HEADER,
  MEMORY_BLOCK_PREFIX,
  QUESTIONS,
  VARIANTS,
  buildMessages,
  buildQuestionInjection,
  classifyReply,
  collectReply,
  extractMarkers,
  fenceRanges,
  inlineCodeRanges,
  instructionEchoRanges,
  reclassifyReport,
  renderMemoryBlock,
  rowToAgentConfig,
  summarize,
  verifyQuestionAnchor,
  withInstruction,
} from './r14a-citation-probe.e2e.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// ─── 注入串形状（票面 §四规格，逐字）─────────────────

describe('注入串形状（票面 §四）', () => {
  it('单节：\\n\\n + 【相关记忆】 + 换行 + `1. 正文`', () => {
    expect(renderMemoryBlock(['甲'])).toBe('\n\n【相关记忆】\n1. 甲')
  })

  it('多节：逐行 `序号. 正文`，序号从 1 连续', () => {
    expect(renderMemoryBlock(['甲', '乙', '丙'])).toBe('\n\n【相关记忆】\n1. 甲\n2. 乙\n3. 丙')
  })

  it('空节集 → 空串（与生产同约定：无命中不注入整块）', () => {
    expect(renderMemoryBlock([])).toBe('')
    expect(withInstruction([], VARIANTS.jia)).toBe('')
  })

  it('前缀常量与头常量与规格字面量一致', () => {
    expect(MEMORY_BLOCK_PREFIX).toBe('\n\n')
    expect(MEMORY_BLOCK_HEADER).toBe('【相关记忆】')
  })

  it('正文含换行时保持原样（生产是 `s.parts.join("\\n")`，不折行）', () => {
    expect(renderMemoryBlock(['上\n下'])).toBe('\n\n【相关记忆】\n1. 上\n下')
  })
})

describe('指示语插入位置（票面 §四：头之后、`1.` 之前）', () => {
  it('甲版插在头与首节之间', () => {
    expect(withInstruction(['甲', '乙'], VARIANTS.jia)).toBe(
      `\n\n【相关记忆】\n${VARIANTS.jia}\n1. 甲\n2. 乙`
    )
  })

  it('乙版同位置（两版只差措辞，不差位置——位置是待观察量，不作第二个自变量）', () => {
    expect(withInstruction(['甲'], VARIANTS.yi)).toBe(`\n\n【相关记忆】\n${VARIANTS.yi}\n1. 甲`)
  })

  it('指示语不含位置要求（句末/词后等字样）', () => {
    for (const [name, text] of Object.entries(VARIANTS)) {
      expect(text, `变体 ${name} 混入了位置要求`).not.toMatch(/句末|词后|结尾|后面加|之前加/)
    }
  })

  it('编号仍是最终位置的 1..n（指示语不占号）', () => {
    const block = withInstruction(['甲', '乙', '丙'], VARIANTS.jia)
    expect(block).toContain('1. 甲')
    expect(block).toContain('3. 丙')
    expect(block).not.toContain('4. ')
  })
})

describe('buildMessages —— 记忆块接在 system prompt 尾部（生产同位置）', () => {
  const sections = [{ text: '甲' }, { text: '乙' }]

  it('system = 原 prompt + 记忆块；user = 问题原文', () => {
    const msgs = buildMessages({ system_prompt: '你是猫' }, '问？', sections, VARIANTS.yi)
    expect(msgs).toHaveLength(2)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content.startsWith('你是猫')).toBe(true)
    expect(msgs[0].content).toContain(withInstruction(['甲', '乙'], VARIANTS.yi))
    expect(msgs[1]).toEqual({ role: 'user', content: '问？' })
  })

  it('prompt 缺失时退化为纯记忆块（不落 "undefined"）', () => {
    const msgs = buildMessages({}, '问？', sections, VARIANTS.yi)
    expect(msgs[0].content.startsWith('\n\n【相关记忆】')).toBe(true)
  })
})

// ─── 判据面（票面 §四三条：代码字面量 / 内联码 / 复述指示语）─────────
//
// 判据按**机制**定义——「**代码字面量不是引用**」，不是按模式名（旧票面写「围栏
// 代码块」，那是模式名）。围栏与内联码是同一机制的两种形态。

describe('代码字面量内的 [n] 不计入（围栏形态）', () => {
  it('围栏区间可被识别（``` 配对）', () => {
    expect(fenceRanges('前 ```js\nlet a=[1]\n``` 后')).toHaveLength(1)
    expect(fenceRanges('无围栏 [1]')).toHaveLength(0)
  })

  it('围栏内的编号单列 inFence，不进 effective', () => {
    const r = extractMarkers('示例：\n```js\nconst a = arr[1]\n```\n见 [2]', VARIANTS.jia)
    expect(r.effective).toEqual([2])
    expect(r.inFence).toEqual([1])
    expect(r.raw).toEqual([1, 2])
  })

  it('围栏**先于**内联码判：单行围栏 ```[1]``` 落 inFence，不落 inCode', () => {
    // 承重：内联正则 `[^`\n]*` 会匹配到 ``` 的前两个反引号。若先判内联码，
    // 这里的 `[1]` 会被 "`[1]`" 这个伪 span 吃掉、记成 inCode ⇒ 判据面串味。
    const r = extractMarkers('```[1]```')
    expect(r.inFence).toEqual([1])
    expect(r.inCode).toEqual([])
    expect(r.effective).toEqual([])
  })
})

describe('代码字面量内的 [n] 不计入（内联码形态）', () => {
  it('内联码区间可被识别，且不把围栏定界符当成内联码', () => {
    expect(inlineCodeRanges('见 `a[1]` 与 [2]')).toHaveLength(1)
    // 围栏定界符的伪匹配必须整条丢弃（否则区间会覆盖 `[1]`）
    expect(inlineCodeRanges('```\ncode\n```')).toEqual([])
  })

  it('内联码内的编号单列 inCode，不进 effective', () => {
    const r = extractMarkers('见 `a[1]` 与 [2]')
    expect(r.inCode).toEqual([1])
    expect(r.effective).toEqual([2])
    expect(r.raw).toEqual([1, 2])
  })

  it('引入注目的实测形态：引用注入原文的 `float[512]` 是内联码，不是越界角标', () => {
    // S2 实测：claude / dsh 各有一只在 q2 输出 `chunk_vectors USING vec0(... float[512])`，
    // `[512]` 出自注入原文（`docs/plans/memory-flywheel.md`，sqlite-vec 列类型）。
    // 这不是「标不存在号」——是**引用原文**。这条钉住它不再被算成 phantom。
    const reply = '全库唯一命中在新表里的是 `chunk_vectors USING vec0(embedding float[512])`。'
    const r = extractMarkers(reply)
    expect(r.inCode).toEqual([512])
    expect(r.effective).toEqual([])
    expect(classifyReply(r.effective, 3, 1).phantom).toBe(false)
    // 但 raw 必须原样留着——真值没有被扫掉，只是分了列
    expect(r.raw).toEqual([512])
  })

  it('真引用写进反引号 ⇒ 仍进 inCode 可见（与 float[512] 不同源，不许静默剔除）', () => {
    const r = extractMarkers('我的答案见 `[2]`。')
    expect(r.inCode).toEqual([2])
    expect(r.effective).toEqual([])
  })

  it('围栏与内联码混排：三类各归各位', () => {
    const text = [
      '先看这条：',
      '```sql',
      'CREATE VIRTUAL TABLE v USING vec0(embedding float[512])',
      '```',
      '再 `见 [1]`，正文见 [2]',
    ].join('\n')
    const r = extractMarkers(text)
    expect(r.inFence).toEqual([512])
    expect(r.inCode).toEqual([1])
    expect(r.effective).toEqual([2])
  })
})

describe('复述指示语 ≠ 标了（甲版指示语自身含字面量 [1]）', () => {
  it('指示语全文照抄时，其中的 [1] 被剔除', () => {
    const r = extractMarkers(`我按这段指示做：${VARIANTS.jia}\n另外见 [3]。`, VARIANTS.jia)
    expect(r.inEcho).toContain(1)
    expect(r.effective).toEqual([3])
  })

  it('乙版的短指示语同样被识别为复述源（判据是公共子串，不是字数）', () => {
    const r = extractMarkers(`（采纳某条时标注其编号，如 [1]。）\n我采纳了 [2]`, VARIANTS.yi)
    expect(r.inEcho).toContain(1)
    expect(r.effective).toEqual([2])
  })

  it('不复述指示语时，[1] 正常计入（防止剔除面过宽把真标注也吃掉）', () => {
    const r = extractMarkers('这条结论来自第 1 节 [1]', VARIANTS.jia)
    expect(r.effective).toEqual([1])
    expect(r.inEcho).toEqual([])
  })

  it('复述区段判据是本模块常量，可被独立复核', () => {
    expect(ECHO_NGRAM).toBeGreaterThanOrEqual(6)
    expect(instructionEchoRanges('完全无关的一句话', VARIANTS.jia)).toEqual([])
  })
})

describe('extractMarkers 基础行为', () => {
  it('取出去重升序的编号，raw 与 effective 都列', () => {
    const r = extractMarkers('见 [2] 与 [1]，另外 [2] 再说一次')
    expect(r.effective).toEqual([1, 2])
    expect(r.raw).toEqual([1, 2])
  })

  it('无标记 → 空数组', () => {
    expect(extractMarkers('这句没有角标').effective).toEqual([])
  })

  it('多位数字也算', () => {
    expect(extractMarkers('见 [10]').effective).toEqual([10])
  })

  it('不误吃合法但非角标的方括号（[abc] / [ ] / 空）', () => {
    expect(extractMarkers('数组 [abc] 与 [] 与 [ 1 ]').effective).toEqual([])
  })
})

// ─── 四格归类（票面 §八.1：各自成列，混标不得互相掩盖）────────

describe('classifyReply —— 四格各自成列、不互斥', () => {
  it('标对：合法号集合含 expectSection', () => {
    const r = classifyReply([2], 3, 2)
    expect(r.correct).toBe(true)
    expect(r.wrongNumber).toBe(false)
    expect(r.phantom).toBe(false)
    expect(r.notMarked).toBe(false)
  })

  it('标错号：标了合法号但不含 expectSection', () => {
    const r = classifyReply([1], 3, 2)
    expect(r.correct).toBe(false)
    expect(r.wrongNumber).toBe(true)
  })

  it('标不存在号：越界单列，**不计入标错号**', () => {
    const r = classifyReply([4], 3, 2)
    expect(r.phantom).toBe(true)
    expect(r.wrongNumber).toBe(false)
    expect(r.correct).toBe(false)
  })

  it('标 0 号同样算越界（编号从 1 起）', () => {
    expect(classifyReply([0], 3, 2).phantom).toBe(true)
  })

  it('不标：一个号都没出现', () => {
    const r = classifyReply([], 3, 2)
    expect(r.notMarked).toBe(true)
    expect(r.correct).toBe(false)
  })

  it('混标（标对 + 越界）时两格**同时**为真——不互相掩盖', () => {
    const r = classifyReply([2, 9], 3, 2)
    expect(r.correct).toBe(true)
    expect(r.phantom).toBe(true)
    expect(r.wrongNumber).toBe(false)
  })
})

// ─── 非退化：形状漂移必须报错（票面 §八.6 承重）──────────

/** 造一个假 adapter——只桩掉最外层 `chatStream`，被测的判定逻辑全真跑 */
function fakeAdapter(chunks) {
  return {
    chatStream: async function* () {
      for (const c of chunks) yield c
    },
  }
}

describe('collectReply —— 形状漂移单列，不得并入「done 但无文本」', () => {
  it('正常：带 content 的 text chunk → ok', async () => {
    const r = await collectReply(
      fakeAdapter([
        { content: '收到', done: false },
        { content: '', done: true },
      ]),
      [],
      {}
    )
    expect(r.status).toBe('ok')
    expect(r.text).toBe('收到')
    expect(r.shapeSample).toEqual(['content', 'done'])
  })

  it('**字段漂移**（chunk 带 text 而非 content）→ shape-mismatch，不是 empty-reply', async () => {
    const r = await collectReply(
      fakeAdapter([
        { text: '收到', done: false },
        { text: '', done: true },
      ]),
      [],
      {}
    )
    expect(r.status).toBe('shape-mismatch')
    expect(r.status).not.toBe('empty-reply')
    expect(r.chunksSeen).toBe(2)
    expect(r.contentChunks).toBe(0)
    // 形状样本要能直接指向漂移字段——否则排查还得回去读探针源码
    expect(r.shapeSample).toEqual(['done', 'text'])
  })

  it('空回复形态（真有 content、真为空）→ empty-reply（**与上一条是两种病**）', async () => {
    const r = await collectReply(
      fakeAdapter([
        { content: '', done: false },
        { content: '   ', done: true },
      ]),
      [],
      {}
    )
    expect(r.status).toBe('empty-reply')
    expect(r.contentChunks).toBe(2)
  })

  it('一个 chunk 都没有 → no-chunks（与 shape-mismatch 分列）', async () => {
    const r = await collectReply(fakeAdapter([]), [], {})
    expect(r.status).toBe('no-chunks')
    expect(r.chunksSeen).toBe(0)
  })

  it('只吐 thinking → 不算可达正文（kind 分面）', async () => {
    const r = await collectReply(
      fakeAdapter([
        { content: '思考中…', kind: 'thinking', done: false },
        { content: '', done: true },
      ]),
      [],
      {}
    )
    expect(r.status).toBe('empty-reply')
    expect(r.thinkingChars).toBe(4)
  })
})

// ─── 问题集：答案锚点机械校验（票面 §七）──────────────────

describe('问题集结构（票面 §七）', () => {
  it('每题都有 answerTokens + answerPosition，且位次各不相同（位次轮转）', () => {
    const positions = new Set()
    for (const q of QUESTIONS) {
      expect(q.answerTokens.length, `${q.id} 缺答案词`).toBeGreaterThan(0)
      expect(q.answerPosition).toBeGreaterThanOrEqual(1)
      expect(q.answerPosition).toBeLessThanOrEqual(q.distractors.length + 1)
      positions.add(q.answerPosition)
    }
    expect(positions.size, '答案节位次没有轮转——读数会绑死在某一个序号上').toBe(QUESTIONS.length)
  })

  it('每题注入 3 节（票面 §四形状规格的注入节数）', () => {
    for (const q of QUESTIONS) expect(q.distractors.length + 1).toBe(3)
  })
})

describe('buildQuestionInjection —— 答案节落在 answerPosition', () => {
  const mkDb = (map) => ({
    prepare: () => ({
      all: (docPath, anchor) => [{ body: map[`${docPath}::${anchor}`] ?? '' }],
    }),
  })

  it('按 answerPosition 插入答案节，其余按声明顺序补齐', () => {
    const db = mkDb({
      'd/a::A': '答案节正文',
      'd/b::B': '干扰一',
      'd/c::C': '干扰二',
    })
    const q = {
      answerSection: { docPath: 'd/a', anchor: 'A' },
      answerTokens: ['答案节正文'],
      answerPosition: 2,
      distractors: [
        { docPath: 'd/b', anchor: 'B' },
        { docPath: 'd/c', anchor: 'C' },
      ],
    }
    const { sections, expectSection } = buildQuestionInjection(db, q)
    expect(expectSection).toBe(2)
    expect(sections.map((s) => s.text)).toEqual(['干扰一', '答案节正文', '干扰二'])
    expect(sections.map((s) => s.isAnswer)).toEqual([false, true, false])
  })

  it('多片节按 part_index 拼回整节（与生产「按节补齐整节」同口径）', () => {
    const db = {
      prepare: () => ({ all: () => [{ body: '上' }, { body: '下' }] }),
    }
    const q = {
      answerSection: { docPath: 'd/a', anchor: 'A' },
      answerTokens: [],
      answerPosition: 1,
      distractors: [],
    }
    expect(buildQuestionInjection(db, q).sections[0].text).toBe('上\n下')
  })
})

describe('verifyQuestionAnchor —— 「只有一个承载节」是可证伪断言', () => {
  const sec = (text, isAnswer = false) => ({ text, isAnswer })

  it('答案词只落在答案节 → ok', () => {
    const r = verifyQuestionAnchor(
      [sec('含 甲 与 乙', true), sec('无关'), sec('也无关')],
      ['甲', '乙']
    )
    expect(r.ok).toBe(true)
    expect(r.hitsPerSection).toEqual([2, 0, 0])
  })

  it('干扰节也答得上 → 不 ok（这题的「标错号」格无信息量）', () => {
    const r = verifyQuestionAnchor([sec('含 甲', true), sec('也含 甲'), sec('无关')], ['甲'])
    expect(r.ok).toBe(false)
    expect(r.problems.join()).toContain('只有一个承载节')
  })

  it('答案词哪节都没有 → 不 ok（词写错了 / 节没被索引）', () => {
    const r = verifyQuestionAnchor([sec('无关'), sec('无关')], ['甲'])
    expect(r.ok).toBe(false)
    expect(r.problems.join()).toContain('没有任何一节')
  })

  it('答案词部分命中（只中一半）不算承载节', () => {
    const r = verifyQuestionAnchor([sec('只含 甲'), sec('无关')], ['甲', '乙'])
    expect(r.ok).toBe(false)
  })
})

// ─── 汇总口径（§六：分母必须写）────────────────────────

describe('summarize —— 四格各自成列 + 分母', () => {
  const run = (over) => ({
    provider: 'claude',
    variant: 'jia',
    status: 'ok',
    correct: false,
    wrongNumber: false,
    phantom: false,
    notMarked: false,
    ...over,
  })

  it('分母 n = 该格全部尝试数（含失败态），不是「成功数」', () => {
    const s = summarize([
      run({ correct: true }),
      run({ status: 'shape-mismatch' }),
      run({ status: 'error' }),
    ])
    expect(s['claude|jia'].n).toBe(3)
    expect(s['claude|jia'].ok).toBe(1)
    expect(s['claude|jia'].shapeMismatch).toBe(1)
    expect(s['claude|jia'].error).toBe(1)
  })

  it('按 provider|variant 分格，互不混算', () => {
    const s = summarize([run({ correct: true }), run({ variant: 'yi', notMarked: true })])
    expect(s['claude|jia'].correct).toBe(1)
    expect(s['claude|yi'].notMarked).toBe(1)
    expect(s['claude|yi'].correct).toBe(0)
  })

  it('含代码字面量角标的行**成列计数**（不是被过滤掉的垃圾）', () => {
    const s = summarize([run({ markersInCode: [512] }), run({ markersInCode: [] }), run({})])
    expect(s['claude|jia'].withMarkersInCode).toBe(1)
  })
})

// ─── reclassify：判据面变了，派生字段重算（票面 §八 验收 9）──────────

describe('reclassifyReport —— 用同一个 classifyReply 重算，零 LLM 调用', () => {
  const instructions = { jia: VARIANTS.jia, yi: VARIANTS.yi }

  const baseRun = (over) => ({
    provider: 'claude',
    agent: 'ds猫',
    model: 'deepseek-flash',
    questionId: 'q2-visual-subspace',
    variant: 'jia',
    expectSection: 1,
    sectionCount: 3,
    status: 'ok',
    replyChars: 0,
    shapeSample: null,
    elapsedMs: 1234,
    markersRaw: [],
    markers: [],
    markersInFence: [],
    markersInEcho: [],
    inRange: [],
    outOfRange: [],
    correct: false,
    wrongNumber: false,
    phantom: false,
    notMarked: false,
    reply: '',
    repeat: 1,
    ...over,
  })

  const wrap = (runs) => ({
    ok: true,
    mode: 's2',
    ranAt: '2026-09-23T00:00:00.000Z',
    n: 5,
    variants: ['jia'],
    instructions,
    questionSet: [],
    providers: [],
    runs,
    summary: summarize(runs),
  })

  it('把「标不存在号」订正成「代码字面量」：真值不经 LLM 重跑即改判', () => {
    const stale = baseRun({
      reply: '全库唯一命中在 `chunk_vectors USING vec0(embedding float[512])`。',
      markersRaw: [512],
      markers: [512],
      outOfRange: [512],
      phantom: true,
    })
    const next = reclassifyReport(wrap([stale]), { from: 'old.json', at: 'T1' })
    const r = next.runs[0]
    expect(r.markersInCode).toEqual([512])
    expect(r.markers).toEqual([])
    expect(r.phantom).toBe(false)
    expect(r.markersRaw).toEqual([512]) // 原始读数原样留着，只是分了列
    expect(next.summary['claude|jia'].phantom).toBe(0)
    expect(next.summary['claude|jia'].withMarkersInCode).toBe(1)
  })

  it('幂等：对已重算的产物再重算 ⇒ runs 与 summary 逐字段相等（连 JSON 文本都同）', () => {
    const once = reclassifyReport(wrap([baseRun({ reply: '见 `[1]` 与 [2]', notMarked: true })]), {
      from: 'a.json',
      at: 'T1',
    })
    const twice = reclassifyReport(once, { from: 'b.json', at: 'T2' })
    expect(twice.runs).toEqual(once.runs)
    expect(twice.summary).toEqual(once.summary)
    expect(JSON.stringify(twice.runs)).toBe(JSON.stringify(once.runs))
    // 戳记的 `at` 是重算时刻，本就该变——不纳入幂等判据；来源链则必须留住
    expect(twice.reclassified.fromReclassifiedAt).toBe('T1')
  })

  it('不碰非派生字段：reply / elapsedMs / status / 报告级 ranAt 原样', () => {
    const stale = baseRun({ reply: '见 [1]', elapsedMs: 4321, status: 'ok' })
    const next = reclassifyReport(wrap([stale]), { from: 'x', at: 'T1' })
    expect(next.runs[0].reply).toBe('见 [1]')
    expect(next.runs[0].elapsedMs).toBe(4321)
    expect(next.runs[0].status).toBe('ok')
    expect(next.ranAt).toBe('2026-09-23T00:00:00.000Z')
  })

  it('error 行整行透传（其派生字段非 classifyReply 产出，重算会把 notMarked 翻真）', () => {
    const err = baseRun({ status: 'error', reply: '', notMarked: false, error: 'boom' })
    const next = reclassifyReport(wrap([err]), { from: 'x', at: 'T1' })
    expect(next.runs[0]).toEqual(err)
    expect(next.reclassified.skipped).toBe(1)
    expect(next.reclassified.skippedRuns[0]).toMatchObject({
      status: 'error',
      questionId: 'q2-visual-subspace',
    })
  })

  it('戳记写明「本件系重算」：来源 + 时刻 + 命中行数', () => {
    const next = reclassifyReport(wrap([baseRun({ reply: '见 [1]' })]), {
      from: 'old.json',
      at: 'T1',
    })
    expect(next.reclassified).toMatchObject({
      from: 'old.json',
      at: 'T1',
      runs: 1,
      skipped: 0,
      markersInCodeRuns: 0,
    })
    expect(next.reclassified.by).toContain('--mode reclassify')
  })
})

// ─── 形状规格守卫：`renderSections` 一变即红 ──────────────

describe('形状规格守卫（生产 renderSections ↔ 探针拼装）', () => {
  const src = readFileSync(path.join(REPO_ROOT, 'packages/server/src/memory/index.ts'), 'utf8')

  /** 取 `renderSections` 函数体（从其声明到下一个顶格 `}`）——不锚行号 */
  function renderSectionsBody() {
    const start = src.indexOf('function renderSections(')
    expect(start, 'renderSections 不在 memory/index.ts 里了——守卫失效，先修守卫').toBeGreaterThan(
      -1
    )
    const end = src.indexOf('\n}', start)
    expect(end, '取不到 renderSections 函数体结尾').toBeGreaterThan(start)
    return src.slice(start, end)
  }

  /**
   * 取生产 `CITATION_MARKER_INSTRUCTION` 的字面量（R14b）。
   *
   * 静态源断言而非 import：本文件在 scripts 包（无 TS 构建），拿不到 server 的 TS 模块。
   * **不引用探针常量**比对（那会让「探针改错」跟着改对），只从源码里抠出字面量。
   */
  function instructionLiteralFromSource() {
    const m = src.match(/export const CITATION_MARKER_INSTRUCTION =\s*'([^']*)'/)
    expect(
      m,
      'CITATION_MARKER_INSTRUCTION 不在 memory/index.ts 里了——守卫失效，先修守卫'
    ).not.toBeNull()
    return m[1]
  }

  it('头字面量 `【相关记忆】` 仍在前缀 `\\n\\n` 之后，指示语紧随其后、在 `1.` 之前', () => {
    const body = renderSectionsBody()
    expect(body).toContain('`\\n\\n【相关记忆】\\n${')
    expect(body).toContain('【相关记忆】\\n${CITATION_MARKER_INSTRUCTION}\\n')
    // R14b 之前的形状（头后直接接 `lines.join`）必须已不存在——
    // 形状如果改回去，这条先红（承重断言，别删）
    expect(body).not.toContain('【相关记忆】\\n${lines.join')
  })

  it('生产指示语与探针夹具 VARIANTS.jia 逐字节相等（措辞是实测过的自变量，漂移即失据）', () => {
    expect(instructionLiteralFromSource()).toBe(VARIANTS.jia)
  })

  it('逐行格式仍是 `${i + 1}. `（序号 = 最终位置，从 1 起）', () => {
    expect(renderSectionsBody()).toContain('`${i + 1}. ')
  })

  it('零节返回空串（探针同约定）', () => {
    expect(renderSectionsBody()).toContain(
      `if (sections.length === 0) return { text: '', tokens: 0 }`
    )
  })

  it('探针拼装出的串与规格逐字相等（防止探针侧单方面漂移）', () => {
    // 规格串写死在断言里，**不引用探针常量**——引用常量的话探针改错时断言会跟着错。
    expect(renderMemoryBlock(['A', 'B'])).toBe('\n\n【相关记忆】\n1. A\n2. B')
  })
})

// ─── DB 行 → AgentConfig（API 边界同口径）───────────────

describe('rowToAgentConfig', () => {
  it('snake_case 行映射到 camelCase，字段名与生产 AgentConfig 对齐', () => {
    const cfg = rowToAgentConfig({
      name: '某猫',
      system_prompt: '你是猫',
      llm_provider: 'claude',
      llm_model: 'm',
      llm_api_key: 'k',
      llm_base_url: 'http://x',
      effort_level: 'high',
      llm_max_tokens: 100,
      llm_temperature: 0.3,
      llm_env_extra: '{}',
    })
    expect(cfg.llmProvider).toBe('claude')
    expect(cfg.llmModel).toBe('m')
    expect(cfg.llmApiKey).toBe('k')
    expect(cfg.llmBaseUrl).toBe('http://x')
    expect(cfg.effortLevel).toBe('high')
    expect(cfg.llmMaxTokens).toBe(100)
    expect(cfg.llmTemperature).toBe(0.3)
    expect(cfg.systemPrompt).toBe('你是猫')
  })

  it('缺省列落 undefined，不落 null（适配器侧读的是 undefined 语义）', () => {
    const cfg = rowToAgentConfig({
      name: 'x',
      llm_provider: 'ollama',
      llm_model: 'm',
      llm_api_key: '',
    })
    expect(cfg.llmBaseUrl).toBeUndefined()
    expect(cfg.effortLevel).toBeUndefined()
    expect(cfg.llmEnvExtra).toBeUndefined()
  })
})
