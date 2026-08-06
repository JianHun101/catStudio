import { describe, it, expect } from 'vitest'
import { parseMentionsFromReply } from './a2a-mentions.js'

const CATS = ['吐槽猫', '店长', 'ds猫', '布偶猫']

describe('parseMentionsFromReply', () => {
  // ─── 行首 @mention ──────────────────────────

  it('匹配行首的 @mention', () => {
    expect(parseMentionsFromReply('@吐槽猫 请 review', CATS)).toEqual(['吐槽猫'])
  })

  it('匹配有前导空格的 @mention', () => {
    expect(parseMentionsFromReply('  @吐槽猫 请 review', CATS)).toEqual(['吐槽猫'])
  })

  it('匹配多个行首 @mention', () => {
    const text = '@店长 你来看看\n@吐槽猫 也看看'
    expect(parseMentionsFromReply(text, CATS)).toEqual(['吐槽猫', '店长'])
  })

  it('只匹配 agentNames 中的名称', () => {
    expect(parseMentionsFromReply('@不存在的猫 hello', CATS)).toEqual([])
  })

  it('匹配文档末尾的交接 @mention', () => {
    const text = `【工作交接】

### 1. What
改了 context filter

### 5. Checklist
- [ ] 逻辑正确
- [ ] 测试覆盖

@吐槽猫 请 review`
    expect(parseMentionsFromReply(text, CATS)).toEqual(['吐槽猫'])
  })

  // ─── 句中的 @mention 不触发 ──────────────────

  it('句中 @mention 不触发', () => {
    expect(parseMentionsFromReply('请 @吐槽猫 review 一下', CATS)).toEqual([])
  })

  it('引用他人话语的 @mention 不触发', () => {
    expect(parseMentionsFromReply('@吐槽猫 说过这个问题需要修', CATS)).toEqual(['吐槽猫'])
    // ^ 这仍然是行首，算作主动喊话（和 Cat Café 设计一致）
  })

  // ─── 代码块剥离 ──────────────────────────────

  it('剥离围栏代码块中的 @mention', () => {
    const text = `@店长 看看这个

\`\`\`typescript
// @吐槽猫 这里需要优化性能
function foo() {}
\`\`\`

代码在文件 src/foo.ts`
    expect(parseMentionsFromReply(text, CATS)).toEqual(['店长'])
  })

  it('剥离无语言标记的代码块中的 @mention', () => {
    const text = `\`\`\`
@吐槽猫
@店长
\`\`\`
@ds猫 你来`
    expect(parseMentionsFromReply(text, CATS)).toEqual(['ds猫'])
  })

  it('剥离多个代码块中的 @mention', () => {
    const text = `\`\`\`js
// @吐槽猫
\`\`\`
\`\`\`python
# @店长
\`\`\`
@ds猫 帮我看看`
    expect(parseMentionsFromReply(text, CATS)).toEqual(['ds猫'])
  })

  // ─── 行内代码剥离 ────────────────────────────

  it('剥离行内代码中的 @mention', () => {
    const text = '请参考 `@吐槽猫` 的配置'
    expect(parseMentionsFromReply(text, CATS)).toEqual([])
  })

  it('剥离行内代码但保留外部的 @mention', () => {
    const text = '`@店长` 的配置参考这里\n@吐槽猫 你来 review'
    expect(parseMentionsFromReply(text, CATS)).toEqual(['吐槽猫'])
  })

  // ─── 边界情况 ────────────────────────────────

  it('空内容返回空数组', () => {
    expect(parseMentionsFromReply('', CATS)).toEqual([])
  })

  it('空白内容返回空数组', () => {
    expect(parseMentionsFromReply('   \n  \n  ', CATS)).toEqual([])
  })

  it('排除自己 @ 自己的情况（由调用方处理）', () => {
    // parseMentionsFromReply 不做自己排除，调用方负责 filter
    const result = parseMentionsFromReply('@店长 请 review', CATS)
    expect(result).toContain('店长')
  })

  it('纯代码块内容返回空数组', () => {
    expect(parseMentionsFromReply('```\n@吐槽猫\n@店长\n```', CATS)).toEqual([])
  })

  // ─── 混合场景 ────────────────────────────────

  it('综合场景：代码+注释+文档末尾 @mention', () => {
    const text = `我修改了 filter 逻辑：

\`\`\`typescript
// 新增规则：mentions.includes(agent.name) 时保留
// @吐槽猫 注意：这里不影响广播模式逻辑
if (m.role === 'agent') {
  if (mentions.includes(agent.name)) {
    relevantMessages.push(m)
  }
}
\`\`\`

请参考 \`@店长\` 之前的实现。

@吐槽猫 请 review 以上改动`
    // 只有末尾行首的 @吐槽猫 应该触发
    expect(parseMentionsFromReply(text, CATS)).toEqual(['吐槽猫'])
  })

  it('行内代码紧邻行首 @mention', () => {
    const text = '`some code`\n@吐槽猫 review'
    expect(parseMentionsFromReply(text, CATS)).toEqual(['吐槽猫'])
  })

  // ─── 特殊字符名称 ────────────────────────────

  it('正则特殊字符名称的转义', () => {
    const names = ['猫+狗', 'a.b', 'c*d']
    expect(parseMentionsFromReply('@猫+狗 hello', names)).toEqual(['猫+狗'])
    expect(parseMentionsFromReply('@a.b hello', names)).toEqual(['a.b'])
    expect(parseMentionsFromReply('@c*d hello', names)).toEqual(['c*d'])
  })

  // ─── 反引号错位回归（31f787bb 静默丢单根治）────────────────

  // 真实回归 fixture：店长派活单 31f787bb 全文（3838 字符、123 个反引号——奇数），
  // 2026-08-06 从 messages 表 content 字段提取。
  // 旧实现（全文成对剥离 /`[^`]*`/g）在反引号总数为奇数时配对错位，
  // 有一对反引号跨行吞掉行首的 @ds猫 → 解析 [] → A2A 派活静默丢失（dispatch_state 不写）；
  // 本单修复（逐行剥离）后必须解析出 ds猫。
  const REAL_DISPATCH_31F787BB =
    "收到——两件事：①「选」而不是「填」，方案要重新设计（浏览器沙箱限制我上次裁决过，但「选」有别的实现路径，我核实后给你方案）；②你给了实际路径 `D:\\Software\\NapCat`，我先看目录里到底有什么启动入口，不猜。先查：目录里没有直接的 napcat.exe，但有 `shell/`、`onekey/`、`extracted/` 三个子目录，还有 `napcat-run.log`（说明启动脚本跑过）。继续往下查启动入口：关键线索出现了：`shell/` 里有 `napcat.bat`（19 字节的小脚本）、`index.js`、`node.exe`（NapCat 自带 Node 运行时）——启动入口应该在这。看这三个文件内容确认启动形态：`napcat.bat` 内容实锤：`node.exe ./index.js` ——**这个版本根本没有 napcat.exe**，启动入口是 `shell\\napcat.bat`（NapCat Shell 形态，自带 node.exe）。而且它内部用相对路径，意味着**必须以 `shell/` 为工作目录启动**——这直接影响模板组装逻辑。再读一下 dev.js 当前的启动组装和 server config 接口，确认改动面：dev.js 现状确认：`spawn('cmd.exe', ['/c', cmd], {cwd: ROOT})` ——**cwd 固定是项目根**。这暴露了一个真实问题：`napcat.bat` 内容 `node.exe ./index.js` 是相对路径，从项目根跑必失败，必须以 `shell/` 为工作目录。看一眼上次成功运行的日志佐证启动方式，再确认 server 侧 config 接口现状：查证完毕，全貌已清楚。看最后一段 dev.js 的 spawn 组装细节，确保派活单准确：全貌核实完毕，两件事都有实锤了。先回答你的疑问，再给方案。\n\n## 为什么没看到 napcat.exe——这个版本根本没有\n\n刚查了 `D:\\Software\\NapCat` 实况：这是 **NapCat Shell 形态**（新版），没有 exe。启动入口是：\n\n```\nD:\\Software\\NapCat\\shell\\napcat.bat  →  内容只有一行：node.exe ./index.js\n```\n\n它自带 80MB 的 `node.exe`，实际链路是 `node.exe → index.js → napcat/napcat.mjs`。你之前能跑通（napcat-run.log 实锤 02:12 消息链路正常），就是从 `shell/` 目录手动启动的。\n\n**这暴露了一个真 bug**：dev.js 现在 `spawn('cmd.exe', ['/c', cmd], {cwd: ROOT})`——**工作目录固定是项目根**。而 `napcat.bat` 内部是相对路径 `node.exe ./index.js`，从项目根跑必失败。a7e3935 只做了字符串替换，没处理工作目录。所以哪怕你选了路径也拉不起来——这单必须一起修。\n\n## 「选」而不是「填」：方案成立，但实现路径要换\n\n之前裁决用输入框，是因为浏览器 file input 有安全沙箱——`<input type=\"file\">` 只能拿到 `C:\\fakepath\\…`，拿不到真实路径。但「选」有另一条成熟路径：**server 提供目录浏览接口，前端做成路径选择器**——从盘符根开始逐层点选，最终选中 `napcat.bat` 回填。体验上就是「选」，不违背浏览器沙箱（server 是本地进程，读目录是它的权限）。\n\n---\n\n**派活单：路径选择器（server 目录浏览 + 前端选择器弹窗）+ dev.js 工作目录修正**\n\n- **改动文件**：\n  | 文件 | 改动 |\n  | --- | --- |\n  | `scripts/dev.js` | 占位符形态 spawn 修正：替换后的路径视为「启动文件」→ `path.dirname` 作 `cwd` + 只传文件名（`spawn('cmd.exe', ['/c', basename], {cwd: dir})`）——bat 内相对路径因此正确；无占位符完整命令行形态维持现状（cwd: ROOT，向后兼容）。拆纯函数 `resolveNapcatSpawn(cmd, napcatPath) → {args, cwd} \\| null` 可测 |\n  | `packages/server/src/routes/connectors.ts` | 新增 `GET /api/connectors/napcat/browse?dir=<绝对路径>`：dir 空 → 盘符列表 `{dir: null, drives: ['D:\\\\', …]}（A:-Z: existsSync 枚举）；dir 存在 → `{dir, parent, entries: [{name, type: 'dir'\\|'file', executable}]}`（executable = .exe/.bat/.cmd 后缀标记，选择器高亮用）；dir 不存在/读失败 → 400。只读零 spawn，与现有接口同族 |\n  | `packages/web/src/composables/useApi.ts` | 加 `browseNapcatDir(dir?)` |\n  | `packages/web/src/components/ConnectorNapCatPanel.vue` | 路径区改「输入框 + 浏览…按钮」：按钮开选择器弹窗（新子组件 `NapcatPathPicker.vue`）——盘符列表 → 目录逐层（双击进入、上级返回、面包屑）+ 可执行文件高亮选中 → 确定回填输入框；保存逻辑不变 |\n  | `packages/web/src/components/NapcatPathPicker.vue` | 新组件（选择器弹窗本体） |\n  | 测试 | `connectors.test.ts` 补 browse（盘符枚举/目录列表/不存在 400/executable 标记）；`ConnectorNapCatPanel.test.ts` 补选择器打开回填；dev.js 行为脚本补 `resolveNapcatSpawn` 纯函数 + **真实 spawn 验证：以 dirname 为 cwd 跑一个含相对路径引用的 bat 成功执行**（模拟 napcat.bat 形态，验收硬项） |\n\n- **接口契约**：\n  - `GET /api/connectors/napcat/browse?dir=` 空 → `{drives}`；带 dir → `{dir, parent, entries}`；400 `{error}`\n  - 选择器选中文件 → 回填输入框 → 用户点保存 → 现有 POST + stat 校验链不变\n- **组件边界**：server 只读列目录（零 spawn 不违背）；dev.js 是唯一 spawn 者；选择器纯前端导航状态，不缓存任何路径\n- **验收标准（行为可验证）**：\n  1. 页面点「浏览」→ 看到盘符列表 → 逐层进 `D:\\Software\\NapCat\\shell` → 看到 `napcat.bat` 高亮可选中 → 确定回填输入框（**正是你机器的真实路径**）\n  2. 保存 → 点启动 → dev.js 日志显示 cwd 为 shell 目录 → NapCat 拉起，3000 端口从拒绝变可连\n  3. **对照实验**：同样的 bat 以项目根为 cwd 执行必失败（证明修复必要）；以 shell 目录为 cwd 执行成功（验收硬项）\n  4. 模板无占位符（老配置）→ 行为与 f184c71 完全一致\n  5. server/web 全量测试 + lint 三包干净；`git diff` 限定上述文件\n- **生效方式**：dev.js 改动需重启 dev.js 进程（收口后我发起重启请求）；server browse 接口常规重启生效；前端热更新即时\n\n**给你选路径时的答案**：选择器里选 `shell\\napcat.bat`（目录里的 `.bat` 文件），不是 `D:\\Software\\NapCat` 目录本身——`{NAPCAT_PATH}` 的语义是「启动文件完整路径」。\n\n@ds猫 派活单见上：路径选择器 + dev.js 工作目录修正。注意三点——①先读 dev.js `resolveNapcatCmd`/`ensureNapcat` 全文再动手，`resolveNapcatSpawn` 要与现有占位符替换逻辑衔接（拆 dir 的时机在 resolve 之后）；②browse 接口的盘符枚举注意 Windows 下 `existsSync('D:\\\\')` 的形态，容错别拖垮；③真实 spawn 的 bat 对照实验是验收硬项（7500095 范式行为脚本），别只测纯函数。有异议走审查链提。"

  it('真实回归：31f787bb 全文（123 反引号奇数）解析出行首 @ds猫', () => {
    expect(parseMentionsFromReply(REAL_DISPATCH_31F787BB, CATS)).toEqual(['ds猫'])
  })

  it('奇数反引号跨行形态不吞行首 @mention（最小复现）', () => {
    // 3 个反引号（奇数）：旧实现把第 1 个 ` 与第 3 个 ` 配对，
    // 吞掉中间行首的 @ds猫；逐行剥离下反引号配对不跨行，@ds猫 保留
    const text = '模板 `{NAPCAT_PATH}\n@ds猫 派活单见上：路径选择器\n替换见 `resolveNapcatCmd'
    expect(parseMentionsFromReply(text, CATS)).toEqual(['ds猫'])
  })

  it('偶数反引号跨行配对行为不变（零回归）', () => {
    const text = '`跨行` 开始\n@ds猫 不受影响\n继续 `结束` 尾'
    expect(parseMentionsFromReply(text, CATS)).toEqual(['ds猫'])
  })

  it('行首 @mention 所在行含奇数未闭合反引号不被吞（保守语义）', () => {
    // 本行 1 个未闭合反引号（奇数）：不成对则不剥离，@ds猫 保留——
    // 「未闭合的行内代码不隐藏提及」比「跨行错位误吞 @」更安全
    const text = '@ds猫 请查 `x\n尾部'
    expect(parseMentionsFromReply(text, CATS)).toEqual(['ds猫'])
  })
})
