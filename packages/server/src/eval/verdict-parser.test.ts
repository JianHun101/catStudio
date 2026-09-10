/**
 * verdict-parser 测试 — W3 L3 契约。
 *
 * 纯函数单测（parseReviewVerdict 无 I/O）+ recordReviewVerdict 落库集成
 * （真实 SQLite :memory:，走 repository 层）。契约验收三分支：
 * approve→subject null；suggest/reject 只@作者 / @店长+作者 / 只@店长→null+no_subject。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import { parseReviewVerdict, recordReviewVerdict } from './verdict-parser.js'

/** 店长（store）+ 作者（非 store）的典型作用域 */
const TARGETS = [
  { name: '店长', isStore: true },
  { name: 'ds猫', isStore: false },
]

describe('parseReviewVerdict — 纯函数', () => {
  it('approve 行首标记 → verdict=approve、subject=null（即使 @ 店长）', () => {
    const r = parseReviewVerdict('审查完毕，全部通过。\n✅可合并', TARGETS)
    expect(r).toEqual({ kind: 'verdict', verdict: 'approve', subject: null, failure: null })
  })

  it('suggest 只@作者 → subject=作者', () => {
    const r = parseReviewVerdict('⚠️建议修改 见下。', [{ name: 'ds猫', isStore: false }])
    expect(r).toEqual({
      kind: 'verdict',
      verdict: 'suggest',
      subject: 'ds猫',
      failure: null,
    })
  })

  it('suggest @店长+作者 → subject=作者（首个非 store 目标，店长排前也取作者）', () => {
    const r = parseReviewVerdict('⚠️建议修改 需返工。', [
      { name: '店长', isStore: true },
      { name: 'ds猫', isStore: false },
    ])
    expect(r).toEqual({
      kind: 'verdict',
      verdict: 'suggest',
      subject: 'ds猫',
      failure: null,
    })
  })

  it('reject 只@店长 → subject=null + failure=no_subject', () => {
    const r = parseReviewVerdict('❌需重做 全部推倒。', [{ name: '店长', isStore: true }])
    expect(r).toEqual({
      kind: 'verdict',
      verdict: 'reject',
      subject: null,
      failure: 'no_subject',
    })
  })

  it('无行首标记 → no-marker（不落库）', () => {
    const r = parseReviewVerdict('整体不错，没有结论标记。', TARGETS)
    expect(r).toEqual({ kind: 'no-marker' })
  })

  it('句中复述标记（非行首）→ no-marker（防正文复述误命中）', () => {
    const r = parseReviewVerdict('这个方案 ✅可合并，不用改。', TARGETS)
    expect(r).toEqual({ kind: 'no-marker' })
  })

  it('代码块内的标记 → 不误命中（剥离后 no-marker）', () => {
    const r = parseReviewVerdict('```\n✅可合并\n```\n正文无结论。', TARGETS)
    expect(r).toEqual({ kind: 'no-marker' })
  })

  it('行首 emoji 非标准 marker → failure=bad_verdict（格式漂移防御）', () => {
    // fixture 用**后缀漂移**（`需处理` 非标准后缀）；旧 fixture 是 `✅ 可合并`
    // 带空格，T-L 后那已是**合法标记**（→ approve），不再能充当本用例样本
    const r = parseReviewVerdict('⚠️ 需处理（后缀漂移）', TARGETS)
    expect(r).toEqual({ kind: 'failure', reason: 'bad_verdict' })
  })

  it('行首 ✅ 前缀变体（✅可合并了）→ bad_verdict（格式漂移防御，不静默）', () => {
    const r = parseReviewVerdict('✅可合并了，结论如下', TARGETS)
    expect(r).toEqual({ kind: 'failure', reason: 'bad_verdict' })
  })

  // ─── 装饰 / 标签前缀放宽（2026-09-09 裁决 B）───────────────────────────
  // 规范层（cat-roles.md）只要求「标记独立成行」，未要求「裸标记」；真实审查
  // 输出带 markdown 装饰与「结论：」标签 → 旧实现静默 no-marker。

  it('真实审查输出 **结论：⚠️建议修改**（装饰 + 标签前缀）→ suggest', () => {
    const r = parseReviewVerdict('## 审查结论\n\n**结论：⚠️建议修改**\n\n3 点需处理，见下。', [
      { name: 'ds猫', isStore: false },
    ])
    expect(r).toEqual({ kind: 'verdict', verdict: 'suggest', subject: 'ds猫', failure: null })
  })

  it('结论：⚠️建议修改（仅标签前缀，无装饰）→ suggest', () => {
    const r = parseReviewVerdict('结论：⚠️建议修改', [{ name: 'ds猫', isStore: false }])
    expect(r).toEqual({ kind: 'verdict', verdict: 'suggest', subject: 'ds猫', failure: null })
  })

  it('### ❌需重做（markdown 标题装饰）→ reject', () => {
    const r = parseReviewVerdict('### ❌需重做', [{ name: 'ds猫', isStore: false }])
    expect(r).toEqual({ kind: 'verdict', verdict: 'reject', subject: 'ds猫', failure: null })
  })

  it('> ✅可合并（引用块）→ no-marker（引用按定义是转述，一律排除）', () => {
    const r = parseReviewVerdict('> ✅可合并', TARGETS)
    expect(r).toEqual({ kind: 'no-marker' })
  })

  it('标签前缀 + 强调闭合 **结论：✅可合并** → approve（装饰与标签交错）', () => {
    const r = parseReviewVerdict('**结论：✅可合并**', TARGETS)
    expect(r).toEqual({ kind: 'verdict', verdict: 'approve', subject: null, failure: null })
  })

  it('**结论：✅ 可合并**（emoji 与后缀间空格）→ approve（T-L 翻转：旧实现判 bad_verdict）', () => {
    const r = parseReviewVerdict('**结论：✅ 可合并**', TARGETS)
    expect(r).toEqual({ kind: 'verdict', verdict: 'approve', subject: null, failure: null })
  })

  it('标签前缀后是句中复述 → no-marker（标签剥离不越过行首语义）', () => {
    const r = parseReviewVerdict('结论：这个方案 ✅可合并，不用改。', TARGETS)
    expect(r).toEqual({ kind: 'no-marker' })
  })

  it('代码块内的标签前缀标记 → 不误命中（剥离后 no-marker）', () => {
    const r = parseReviewVerdict('```\n结论：✅可合并\n```\n正文无结论。', TARGETS)
    expect(r).toEqual({ kind: 'no-marker' })
  })

  // ─── 真实形态（2026-09-09 吐槽猫 ⚠️ 主项 1）──────────────────────────
  // 实测本会话 14 条真实审查消息：结论行主导形态是 `**结论：⚠️建议修改**——续写正文`，
  // 强调闭合 + 标点紧贴标记 → 旧 lookahead `(?=\s|$)` 遇 `*` 不匹配，86% 静默不落库。

  it('真实形态 **结论：⚠️建议修改**——续写正文 → suggest（强调闭合 + 破折号）', () => {
    const r = parseReviewVerdict('**结论：⚠️建议修改**——方向正确，但 3 点需处理。', [
      { name: 'ds猫', isStore: false },
    ])
    expect(r).toEqual({ kind: 'verdict', verdict: 'suggest', subject: 'ds猫', failure: null })
  })

  it('真实形态 **结论：✅可合并**——续写正文 → approve', () => {
    const r = parseReviewVerdict('**结论：✅可合并**——方向对、测试全绿。', TARGETS)
    expect(r).toEqual({ kind: 'verdict', verdict: 'approve', subject: null, failure: null })
  })

  it('真实形态 - **结论**：⚠️建议修改（LOW）——续写 → suggest（标签夹强调闭 + 括号）', () => {
    const r = parseReviewVerdict('- **结论**：⚠️建议修改（LOW）——docs 清理达标。', [
      { name: 'ds猫', isStore: false },
    ])
    expect(r).toEqual({ kind: 'verdict', verdict: 'suggest', subject: 'ds猫', failure: null })
  })

  it('真实形态 **结论判定：⚠️建议修改（LOW）**。→ suggest（长标签须早于短标签）', () => {
    const r = parseReviewVerdict('**结论判定：⚠️建议修改（低严重度收尾）**。3 处待修。', [
      { name: 'ds猫', isStore: false },
    ])
    expect(r).toEqual({ kind: 'verdict', verdict: 'suggest', subject: 'ds猫', failure: null })
  })

  it('标记后接汉字仍不匹配 → bad_verdict（✅可合并了，不因放宽而误收）', () => {
    const r = parseReviewVerdict('✅可合并了，结论如下', TARGETS)
    expect(r).toEqual({ kind: 'failure', reason: 'bad_verdict' })
  })

  // ─── 引用 / 列表行不覆盖真结论（2026-09-09 吐槽猫 ⚠️ 主项 2）──────────
  // 引用块行**一律排除、无兜底识别**（引用按定义是转述）；列表项只在带标签时
  // 才算候选。否则一条 ⚠️ 审查会因末尾引用的一行 ✅ 被误判 approve。

  it('引用行 ✅ 不覆盖真结论 ⚠️ → suggest（旧实现误判 approve）', () => {
    const r = parseReviewVerdict('**结论：⚠️建议修改**——需改。\n\n> ✅可合并', [
      { name: 'ds猫', isStore: false },
    ])
    expect(r).toEqual({ kind: 'verdict', verdict: 'suggest', subject: 'ds猫', failure: null })
  })

  it('列表行 ✅ 不覆盖真结论 ⚠️ → suggest（旧实现误判 approve）', () => {
    const r = parseReviewVerdict('- ✅可合并 → 行首@店长\n\n**结论：⚠️建议修改**——需改。', [
      { name: 'ds猫', isStore: false },
    ])
    expect(r).toEqual({ kind: 'verdict', verdict: 'suggest', subject: 'ds猫', failure: null })
  })

  it('全消息只有引用行标记 → no-marker（引用一律排除，不兜底识别）', () => {
    const r = parseReviewVerdict('审查意见见上。\n> ✅可合并', TARGETS)
    expect(r).toEqual({ kind: 'no-marker' })
  })

  it('列表项无标签 ✅ 排除 → no-marker（清单描述不误判 approve）', () => {
    const r = parseReviewVerdict('- ✅可合并 → 行首@店长', TARGETS)
    expect(r).toEqual({ kind: 'no-marker' })
  })

  it('列表项带标签 ⚠️ → suggest（真实形态，A 级候选不受列表前缀影响）', () => {
    const r = parseReviewVerdict('- **结论**：⚠️建议修改（LOW）——docs 清理达标。', [
      { name: 'ds猫', isStore: false },
    ])
    expect(r).toEqual({ kind: 'verdict', verdict: 'suggest', subject: 'ds猫', failure: null })
  })

  it('A 级优先于 B 级：带标签 ✅ + 裸 ⚠️ → approve（标签行是结论）', () => {
    const r = parseReviewVerdict('⚠️建议修改 先记问题。\n**结论：✅可合并**——复审已通过。', TARGETS)
    expect(r).toEqual({ kind: 'verdict', verdict: 'approve', subject: null, failure: null })
  })

  it('同级冲突取最严：裸 ⚠️ + 裸 ✅ → suggest（错误代价不对称）', () => {
    const r = parseReviewVerdict('⚠️建议修改 先说问题。\n✅可合并 后来确认了', [
      { name: 'ds猫', isStore: false },
    ])
    expect(r).toEqual({ kind: 'verdict', verdict: 'suggest', subject: 'ds猫', failure: null })
  })

  it('同级无冲突取该值：裸 ❌ 重复出现 → reject', () => {
    const r = parseReviewVerdict('❌需重做 第一轮。\n❌需重做 复审仍不过。', [
      { name: 'ds猫', isStore: false },
    ])
    expect(r).toEqual({ kind: 'verdict', verdict: 'reject', subject: 'ds猫', failure: null })
  })

  // ─── T-C 判词三档：💬仅评论（非阻断）────────────────────────────────
  // 语义（docs/plans/review-chain-anchor.md C5）：低严重度观察项不再一律打成
  // ⚠️（每条强制起一轮）。💬 不要求返工 → subject 恒 null（写 subject 会被下游
  // 当返工派发）；严重度落在 ✅ 与 ⚠️ 之间（有观察项就不算干净通过）。

  it('comment：💬仅评论 → comment + subject=null（@ 了非 store 目标也不写 subject）', () => {
    const r = parseReviewVerdict('💬仅评论 3 点非阻断观察，不要求返工。', [
      { name: '店长', isStore: true },
      { name: 'ds猫', isStore: false },
    ])
    expect(r).toEqual({ kind: 'verdict', verdict: 'comment', subject: null, failure: null })
  })

  it('comment：**结论：💬仅评论**（装饰 + 标签前缀）→ comment', () => {
    const r = parseReviewVerdict('**结论：💬仅评论**——两条小建议，不阻断收口。', TARGETS)
    expect(r).toEqual({ kind: 'verdict', verdict: 'comment', subject: null, failure: null })
  })

  it('comment：行首 💬 但后缀漂移（💬 仅评论 带空格）→ comment（T-L 翻转：旧实现判 bad_verdict）', () => {
    const r = parseReviewVerdict('💬 仅评论（带空格变体）', TARGETS)
    expect(r).toEqual({ kind: 'verdict', verdict: 'comment', subject: null, failure: null })
  })

  it('同级冲突：裸 💬 + 裸 ✅ → comment（有观察项就不算干净通过）', () => {
    const r = parseReviewVerdict('✅可合并 主结论。\n💬仅评论 另有两条小建议', TARGETS)
    expect(r).toEqual({ kind: 'verdict', verdict: 'comment', subject: null, failure: null })
  })

  it('同级冲突：裸 💬 + 裸 ⚠️ → suggest（既有向严裁决不放宽，💬 不得降级 ⚠️）', () => {
    const r = parseReviewVerdict('💬仅评论 小建议。\n⚠️建议修改 但这条必须改', [
      { name: 'ds猫', isStore: false },
    ])
    expect(r).toEqual({ kind: 'verdict', verdict: 'suggest', subject: 'ds猫', failure: null })
  })

  // ─── 真实语料回归（2026-09-09 店长验收硬指标）────────────────────────
  // 语料 = 本会话（86e15a43）DB 中吐槽猫 15 条审查消息的结论行原文，
  // 逐条从 `cat-study-dev.db` 导出（非手写夹具）。修复前实测 2/15 落 verdict，
  // 修复后 13 条落 verdict（CORPUS）+ 2 条 no-marker（NO_MARKER_CORPUS，标记在
  // 句中且无标准后缀，属「标记须独立成行」的合理漏判）——后两条也钉住，防未来
  // 放宽把它们变成 verdict 时无回归钉。
  // 保留原文标点/全半角冒号差异——它们是真实形态的一部分。
  const CORPUS: Array<[string, string]> = [
    [
      'suggest',
      '**结论:⚠️建议修改**——方向正确(MCP read_skill 懒加载是对的选择,测试全绿、catalog 与磁盘对齐、request-review 递送状态保留),但上述 3-4 点建议收口前处理,最实质的是 catstudy 嵌套定制版的内容正确性与 skill-loader 死代码。',
    ],
    [
      'suggest',
      '**结论：⚠️建议修改**——方向完全对（投递外移/改名/request-review 移除都正确，门禁全绿、命名收敛、无悬空），但上述主要问题建议收口前处理：把 16 项检查点清单迁移到保留文件，兑现"内容资产并入"的承诺。',
    ],
    [
      'suggest',
      '**结论判定：⚠️建议修改（低严重度收尾）**。内容资产找回这一核心目标**已一锤定音地达成**（15 项特有 + 48 项通用完整逐字迁移、门禁绿、纯 docs 无需重启），但上述 3 处描述性错误建议修正后再闭环。',
    ],
    [
      'approve',
      '**结论：✅可合并**——方向对、3 处描述性错误全部修正、清单内容完整无损（55=55）、门禁绿、无新引入问题。纯 docs 改动，店长可直接收口合并。',
    ],
    [
      'approve',
      '**结论：✅可合并**——方向对、四点 ⚠️ 全部落地、读盘逻辑单源化并补了自动化契约测试、无新引入问题、脚本与 server 双绿、tsc 过。此提交与 flash猫 `fc34675` 均已审 ✅，店长可一并收口合并。',
    ],
    [
      'suggest',
      '**结论：⚠️建议修改（LOW）**——docs 清理达标、契约①核实准确且有价值，仅 spec:77 承载物一处角色误述需 flashCat 补一行；契约① shape 不符是独立的、更重要的接线输入，单独上报店长。',
    ],
    [
      'suggest',
      '**结论：⚠️建议修改（LOW）**——line 78 修正本身准确、方向对；但同一承载物误述在 line 18 残留、fix 不完整。补 line 18 一处 + 拨正 reply.ts 行号即闭环。',
    ],
    [
      'suggest',
      '**结论：⚠️建议修改**——X2 接线方向完全对（verdict 推进 + commit_sha 去重 + 铁律 shape 对齐 + 门禁绿），核心逻辑正确且测试全绿；但 **OQ1（closeout 提醒店长收口未真正投递）** 是实质缺口，需你按 (a)/(b) 二选一定夺；OQ2 建议补接线测试。处理完我复审。',
    ],
    [
      'approve',
      '**结论：✅可合并**——两处 ⚠️ 全部修正、与实际磁盘一致、无新引入问题、纯 docs 无需重启。店长收口即可。',
    ],
    ['suggest', '## 审查结论：⚠️建议修改（`81f253b` 契约③ X2 闭环接线）'],
    [
      'approve',
      '**结论：✅可合并**——OQ1 按 (a) 真正投递、OQ2 补真实接线测试、次要两条均已落地，实测无回归、无环、类型干净。两条观察属 spec 层口径与边界覆盖，挂后续单。',
    ],
    [
      'suggest',
      '**结论：⚠️建议修改**——修法①（边表 + 注释 + 文案）✅ 正确且是本事故正解，测试同步到位、无回归；修法② 需按 (a)/(b) 定夺（推荐 (a)，改动仅注释/测试名/文档）。改完我复审。',
    ],
    [
      'suggest',
      '**结论：⚠️建议修改**——裁决 A + 次要两条正确、全量 1320 + tsc 全绿；但裁决 B 未达成核心目标（真实审查消息 86% 仍不落 verdict），且放宽引入「引用行误判 approve」新面。这是「重启后 e2e 验证 verdict→closeout」的直接前置，**建议修好再收口重启**。',
    ],
  ]

  // 同一批语料的另 2 条——标记在句中且无标准后缀 → no-marker（安全方向：漏判只多一轮）
  const NO_MARKER_CORPUS: string[] = [
    '**结论先行：本轮是同源重复派发，不是新交付——✅ 结论维持，不重审、不重启审查循环。**',
    '**结论先行：`de525b8` 归档确认 ✅ —— 不填、不重审、不重启审查循环。**',
  ]

  it.each(CORPUS)('真实语料：%s ← %s', (expected, line) => {
    const r = parseReviewVerdict(line, TARGETS)
    expect(r.kind).toBe('verdict')
    if (r.kind === 'verdict') expect(r.verdict).toBe(expected)
  })

  it.each(NO_MARKER_CORPUS)('真实语料 no-marker：%s', (line) => {
    expect(parseReviewVerdict(line, TARGETS).kind).toBe('no-marker')
  })

  it('引用/列表行 emoji 不记 bad_verdict（噪音消除）→ no-marker', () => {
    const r = parseReviewVerdict('- ✅ 绝大部分都对了——仅 2 点。\n> ⚠️ 参考历史结论。', TARGETS)
    expect(r).toEqual({ kind: 'no-marker' })
  })

  it('suggest 但 targets 为空（防御）→ subject=null + no_subject', () => {
    const r = parseReviewVerdict('⚠️建议修改', [])
    expect(r).toEqual({
      kind: 'verdict',
      verdict: 'suggest',
      subject: null,
      failure: 'no_subject',
    })
  })

  // ─── T-L：emoji 与后缀之间的空格零容忍（2026-09-10 店长裁决）────────────
  // 样本首行取自真库（cat-study-dev.db）原文：`**结论：⚠️ 建议修改。**` 这类
  // emoji 后带空格的形态，旧实现（emoji 紧贴后缀）下 **3 条必红** —— 该返工的
  // 没返工、该收口的收不了。下面是判别性判据。

  it('T-L 实证 `69fc0765`：**结论：⚠️ 建议修改。**（emoji 后带空格）→ suggest + subject', () => {
    const r = parseReviewVerdict(
      '**结论：⚠️ 建议修改。** 四条待核项里三条成立（谓词那条我复核了）。',
      TARGETS
    )
    expect(r).toEqual({ kind: 'verdict', verdict: 'suggest', subject: 'ds猫', failure: null })
  })

  it('T-L 实证 `c4c40fac`：**结论：✅ 可合并。**（emoji 后带空格）→ approve', () => {
    const r = parseReviewVerdict('**结论：✅ 可合并。** `ad8af8b` 两处必改方向正确。', TARGETS)
    expect(r).toEqual({ kind: 'verdict', verdict: 'approve', subject: null, failure: null })
  })

  it('T-L 实证 `fde26688`：**结论：✅ 可合并。**（emoji 后带空格）→ approve', () => {
    const r = parseReviewVerdict('**结论：✅ 可合并。** `a1200a7` 三项必修全过。', TARGETS)
    expect(r).toEqual({ kind: 'verdict', verdict: 'approve', subject: null, failure: null })
  })

  it('T-L 阴性对照 `032b6ccd`：**结论：⚠️建议修改**（无空格）→ 修前修后同值 suggest', () => {
    const r = parseReviewVerdict(
      '**结论：⚠️建议修改** —— 门禁那一半修对了，但台账那半方向相反。',
      TARGETS
    )
    expect(r).toEqual({ kind: 'verdict', verdict: 'suggest', subject: 'ds猫', failure: null })
  })

  it('T-L 同判：同一结论行带/不带空格 → 同值（视觉同形必须同判）', () => {
    const withSpace = parseReviewVerdict('**结论：⚠️ 建议修改。** 见下。', TARGETS)
    const withoutSpace = parseReviewVerdict('**结论：⚠️建议修改。** 见下。', TARGETS)
    expect(withSpace).toEqual(withoutSpace)
  })

  it('T-L 阴性对照 `e2781808` 形状：行中「⚠️ 建议修改」不因放宽而翻转 → 仍取行尾 suggest', () => {
    // 行中（非行首）的带空格复述 + 标题行后缀不符，均不得改写结论
    const r = parseReviewVerdict(
      [
        '我写「⚠️ 建议修改」（带空格）四个 marker 全不匹配 —— 危害不止 ⚠️。',
        '### ⚠️ 必改 1｜台账把一条真实派发缺口判反了',
        '⚠️建议修改',
      ].join('\n'),
      TARGETS
    )
    expect(r).toEqual({ kind: 'verdict', verdict: 'suggest', subject: 'ds猫', failure: null })
  })

  it('T-L 行尾判据**未**放松：`✅ 可合并了`（带空格且后接汉字）→ 仍 bad_verdict', () => {
    const r = parseReviewVerdict('**结论：✅ 可合并了**', TARGETS)
    expect(r).toEqual({ kind: 'failure', reason: 'bad_verdict' })
  })
})

describe('recordReviewVerdict — 解析 + 落库', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb())
  })

  afterEach(() => {
    resetDb()
  })

  const verdictsOf = (messageId: string) =>
    getDb().prepare('SELECT * FROM review_verdicts WHERE message_id = ?').get(messageId) as
      Record<string, unknown> | undefined

  const failuresOf = (messageId: string) =>
    getDb().prepare('SELECT * FROM review_parse_failures WHERE message_id = ?').get(messageId) as
      Record<string, unknown> | undefined

  it('approve → review_verdicts 落库 subject=null，failure 表不写', () => {
    recordReviewVerdict({
      messageId: 'm-approve',
      sessionId: 's1',
      reviewerAgentId: 'reviewer-1',
      content: '没问题\n✅可合并',
      targets: TARGETS,
    })
    const row = verdictsOf('m-approve')!
    expect(row.verdict).toBe('approve')
    expect(row.subject_agent_id).toBeNull()
    expect(row.session_id).toBe('s1')
    expect(row.reviewer_agent_id).toBe('reviewer-1')
    expect(failuresOf('m-approve')).toBeUndefined()
  })

  it('suggest + 只@店长 → review_verdicts subject=null + failure no_subject 双写', () => {
    recordReviewVerdict({
      messageId: 'm-nosubject',
      sessionId: 's1',
      reviewerAgentId: 'reviewer-1',
      content: '❌需重做',
      targets: [{ name: '店长', isStore: true }],
    })
    const row = verdictsOf('m-nosubject')!
    expect(row.verdict).toBe('reject')
    expect(row.subject_agent_id).toBeNull()
    const fail = failuresOf('m-nosubject')!
    expect(fail.reason).toBe('no_subject')
    expect(fail.raw).toContain('❌需重做')
  })

  it('comment → review_verdicts 落库 verdict=comment，failure 表不写（CHECK 已放宽）', () => {
    recordReviewVerdict({
      messageId: 'm-comment',
      sessionId: 's1',
      reviewerAgentId: 'reviewer-1',
      content: '💬仅评论 两条小建议。',
      targets: TARGETS,
    })
    const row = verdictsOf('m-comment')!
    expect(row.verdict).toBe('comment')
    expect(row.subject_agent_id).toBeNull()
    expect(failuresOf('m-comment')).toBeUndefined()
  })

  it('bad_verdict → 只写 failure 表，不写 review_verdicts', () => {
    recordReviewVerdict({
      messageId: 'm-bad',
      sessionId: 's1',
      reviewerAgentId: 'reviewer-1',
      content: '✅ 通过（后缀漂移，T-L 后 `✅ 可合并` 已是合法标记）',
      targets: TARGETS,
    })
    expect(verdictsOf('m-bad')).toBeUndefined()
    const fail = failuresOf('m-bad')!
    expect(fail.reason).toBe('bad_verdict')
    expect(fail.raw).toContain('✅ 通过')
  })

  it('装饰 + 标签前缀格式 → review_verdicts 真实落库（旧实现静默 no-marker）', () => {
    recordReviewVerdict({
      messageId: 'm-decorated',
      sessionId: 's1',
      reviewerAgentId: 'reviewer-1',
      content: '**结论：⚠️建议修改**\n\n3 点需处理。',
      targets: TARGETS,
    })
    const row = verdictsOf('m-decorated')!
    expect(row.verdict).toBe('suggest')
    expect(row.subject_agent_id).toBe('ds猫')
    expect(failuresOf('m-decorated')).toBeUndefined()
  })

  it('no-marker → 两表都不写', () => {
    recordReviewVerdict({
      messageId: 'm-none',
      sessionId: 's1',
      reviewerAgentId: 'reviewer-1',
      content: '日常汇报，无结论。',
      targets: TARGETS,
    })
    expect(verdictsOf('m-none')).toBeUndefined()
    expect(failuresOf('m-none')).toBeUndefined()
  })

  it('同 message_id 重复落库（INSERT OR IGNORE）→ 不抛错不覆盖', () => {
    recordReviewVerdict({
      messageId: 'm-dupe',
      sessionId: 's1',
      reviewerAgentId: 'reviewer-1',
      content: '✅可合并',
      targets: TARGETS,
    })
    expect(() =>
      recordReviewVerdict({
        messageId: 'm-dupe',
        sessionId: 's1',
        reviewerAgentId: 'reviewer-1',
        content: '✅可合并',
        targets: TARGETS,
      })
    ).not.toThrow()
    const rows = getDb()
      .prepare('SELECT COUNT(*) AS c FROM review_verdicts WHERE message_id = ?')
      .get('m-dupe') as { c: number }
    expect(rows.c).toBe(1)
  })
})
