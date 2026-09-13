# 票单：前端会话渲染解耦（会话一多就卡）

> 活：把「会话消息条数 N 增长 → 每次流式推送全量重渲染」这条乘积式劣化链拆掉。
> 落点：会话 worktree `D:/Game/ai/catStudy-sessions/9be79af7`（`session/9be79af7`）。
> 触发：用户报「现在前端会话内容一多就很卡」，@店长 要求优化前端。
> 预兆留痕：`docs/sessions/cat-study-markdown-review-skills-summary.md:123` 早已预言该失效模式并写
> 「在消息量超过 ~100 条后加入」——该票单从未开出，本次补上。

---

## 一、诊断（已取证，非推演）

`packages/web/src/components/ChatPanel.vue` 是 **3237 行单组件**，消息列表 100% 内联 `v-for`
（`:1029` `TransitionGroup` → `:1030` `v-for`），**全组件树里没有任何消息级子组件边界**。
全仓 grep `v-memo | v-once | content-visibility | contain: | shallowRef | markRaw` → **零命中**。

后果：服务端 `packages/server/src/execution/reply.ts:867-876` **逐 chunk 推送 typing（无节流）**，
每个 chunk 到达 ⇒ `typingStates` 变更 ⇒ **ChatPanel 整个 render 函数重跑** ⇒ N 条历史消息的模板内
函数全部重新求值。单次 chunk 的成本 ≈ O(N)：

| 开销                                                                                                                          | 位置                                        | 量级                          |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------- |
| `storedFoldEntries(msg)` **模板中被调两次**，每次重建 Map + 两轮 segments 遍历                                                | `ChatPanel.vue:1080` / `:1082` / `:753-794` | 每条 ×2                       |
| `renderMarkdown(e.content)` **完全无缓存**（`<details :open="false">` 收起也照样 parse）                                      | `ChatPanel.vue:1086`                        | **O(全会话 thinking 总字数)** |
| `isGrouped(i)` 每条 3 次（2 次正则 + 2 次 Date 解析）                                                                         | `ChatPanel.vue:1041/1042/1050`、`:271-287`  | 每条 ×3                       |
| `isLatestUserMessage(msg)` 每条 user 消息跑一次全量 filter                                                                    | `ChatPanel.vue:1206`、`:628-633`            | **O(N²)**                     |
| `markdownAgentNames()` 2 次 `agents.find` 全表扫                                                                              | `ChatPanel.vue:689-693`、键在 `:712`        | 每条 ×2                       |
| 缓存键**含整条正文**（`${msg.id}:${names}:${textContent}`）→ 每条每次渲染 O(内容长度) 字符串拼接，且 Map **无淘汰、无界增长** | `ChatPanel.vue:686`、`:712`                 | 每条                          |
| `TransitionGroup` 包裹 N 个子节点 → 每次 key map + FLIP                                                                       | `ChatPanel.vue:1029`                        | O(N)                          |
| `DiffViewer` 模板内直调 `parseUnifiedDiff`                                                                                    | `DiffViewer.vue:56`                         | 每次重解析                    |

**根因一句话**：没有组件渲染边界 ⇒ 一个 chunk 的重渲染成本 = O(N) + O(全会话 thinking 总字数)；
N 增长时与推送频率相乘，表观即「越用越卡」。

**一处勘察纠偏（我自己复核过，别再按错判据找）**：`ChatPanel.vue:1236-1241` 的
`item.type === 'seg'` 流式正文 markdown 分支**是死代码**——`buildStreamItems`（`:177-185`）对
`kind === 'text'` 直接 `continue`，**从不产出 `type:'seg'`**（点1 规格：流式期间正文不渲染）。
所以流式路径的真实 markdown 热区只有 `:1276`（折叠块内 thinking 段，随 chunk 增长）。

---

## 二、架构裁决

### 目标形态：三层

**L1 · 渲染边界（根因修复，唯一能把 O(N)/chunk 降成 O(1)/chunk 的手段）**
抽出 `MessageItem.vue` 子组件。Vue 的更新传播是**组件粒度**：父重渲染时子组件 props 未变则跳过
子组件更新。抽出来后，一个 typing chunk 只重渲染「流式气泡 + 真正变化的那条消息」，
N 条历史消息**零成本**。
**硬性约束：所有依赖整个消息数组或下标的判定（分组、日期分隔、是否最新用户消息、发送者/头像/
模型名/token 文案）必须上移到父组件算成标量 prop 传入**——子组件里再算一次 `activeMessages.filter`
就白抽了。这条是本次设计的承重点，审查时优先看它。

**L2 · 折叠块内容懒渲染**
`<details :open="false">` 的内容仍在 DOM 且仍在 parse —— 这是「历史 thinking 全量 markdown 重算」的
来源（`:1086`）。改为**收起时不渲染内容体**（受控 open 态 + `v-if` 门控）。首屏默认全折叠 ⇒ 零 parse。

**L3 · 缓存归位（L1 的副产品）**
抽组件后，子组件内部用 `computed` 即可（自带缓存 + 依赖追踪，无键拼接、无无界增长），
**手写 `markdownCache`（`:686`）整体删除**。L1 让 L3 的手写缓存变成不必要的复杂度——这是抽组件的
第二重收益，不是额外工作。

### 裁决：本轮**不做**虚拟滚动

依 `docs/adr/0007-external-tool-form-selection-checklist.md`「简单形态默认 + 复杂举证倒置」：
虚拟滚动需新建第三方依赖（现 `packages/web/package.json` **零虚拟滚动依赖**，deps 仅
`dompurify / highlight.js / marked / pinia / socket.io-client / vue`），且引入动态高度、滚动锚定、
搜索定位、加载历史跳转等一串复杂度。L1 已把 patch 成本降到 O(1)/chunk，L2 砍掉最大头 markdown 重算；
屏幕外节点的 style/layout/paint 用**零依赖**的 `content-visibility: auto` + `contain-intrinsic-size` 兜底。
⇒ **先做零依赖方案并实测；若实测 2000+ 条仍不够，带实测数据另立项评估虚拟滚动。**

### 不做清单（Out of Scope，双向钉死）

- **不做虚拟滚动**（理由见上）
- **不动 `stores/chat.ts` 的 `activeMessages` computed**（`:184-186`）——它只在 `messages` 变更时重算，
  而 typing 变更走的是 `typingStates`，**不在热路径上**。改它是无收益的搅动，且会动到 T1 的 prop 来源
- **不动服务端 typing 推送频率** —— 见文末「票 T2（挂账）」
- **零视觉变化**：本票是纯性能重构，不改任何样式、文案、交互、DOM 语义
- 不动消息分组/日期分隔/撤回/重启按钮/diff 展示的**行为**（只改它们**在哪里被计算**）

---

## 票 T1：ChatPanel 渲染解耦

### 改哪些文件

| 文件                                              | 改动                                                                                                            |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `packages/web/src/components/MessageItem.vue`     | **新增**。承载单条消息（头像/发送者/折叠块/图片/正文/diff/撤回/重启按钮）                                       |
| `packages/web/src/components/ChatPanel.vue`       | 消息 `v-for` 改渲染 `<MessageItem>`；标量判定上移父组件；删 `markdownCache`；滚动监听去重；收窄 TransitionGroup |
| `packages/web/src/components/DiffViewer.vue`      | `parseUnifiedDiff` 从模板调用移入 `computed`                                                                    |
| `packages/web/src/components/MessageItem.test.ts` | **新增**（可 co-located；若走 ChatPanel 全量 mount 则落在 `ChatPanel.test.ts`）                                 |

### 契约

- **C1** `MessageItem` props 全为标量/稳定引用，**不得传入整个消息数组或下标**：
  `msg: Message`、`grouped: boolean`、`showDateSep: boolean`、`dateText: string`、
  `isLatestUser: boolean`、`senderName: string`、`avatar: string`、`modelName: string`、
  `tokensText: string`、`statusEntries: AgentStatusEntry[]`。
  （命名与确切切分由实施者按现有调用点定，但「不含数组/下标」是硬约束）
- **C2** `renderMarkdown` 只在**内容或 provider 相关 agent 名变化**时重新调用；折叠块收起的消息
  **一次都不调**。
- **C3** 分组/日期分隔/撤回按钮/重启按钮/diff 的**判定结果与改前逐条一致**（只换计算位置）。
- **C4** 折叠块默认收起；展开态、展开后内容、DOM 结构（`details/summary/fold-thinking/ToolRow`）不变。
- **C5** 滚动行为（贴底/新消息计数/滚动到底按钮）与监听注册**恰好一份**（`:984` 模板 `@scroll.passive`
  与 `:379` `addEventListener` 现为重复注册，二选一）。

### 验收（可执行，逐条对应）

- **A1（主指标，机械断言，必须能进 CI）**
  新增测试：Pinia 真实 store（`setActivePinia(createPinia())`）注入 **200 条**带 `segments`（含 thinking 段）
  的历史消息；mock `../utils/markdown` 把 `renderMarkdown` 换成计数桩；`mount(ChatPanel)` 稳定后
  **触发一次 `AGENT_TYPING` 更新**，`await nextTick()`，断言 **`renderMarkdown` 调用增量 ≤ 5**。
  - 改前基线远大于此（≈ 200 × 每条 thinking 条目数）——**开工第一步先跑改前基线并把实测数字写进测试注释**，
    作为「O(N) → O(1)」的留痕。
  - fallback：若 ChatPanel 全量 mount 在 jsdom 下不可行，退化为「mount `MessageItem` 列表 + 单独断言
    ChatPanel 模板确实渲染 `MessageItem`」两层，但**必须保住这条断言的机械性**，不许降级成「人工感觉快了」。
- **A2（静态源断言）** `packages/web/src/components/ChatPanel.vue` 模板正文中不再出现
  `storedFoldEntries(` 与 `isLatestUserMessage(`（项目已有 `?raw` 读 SFC 的静态断言范式）。
- **A3（行为回归）** 折叠块默认收起 + 展开后内容与改前一致；正文 markdown 输出与改前逐字节一致
  （对同一批语料做快照对比）；分组/头像/日期分隔/撤回/重启按钮/diff 行为不变。
- **A4** `pnpm test:web` 全绿 + `pnpm test:shared` 不受影响 + `pnpm lint` 全绿。
- **A5（人工实测，交付时附读数）** 300 条消息的会话 + 连续流式输出，Performance 面板无 >50ms 长任务。
  > **勘误（收口时实测）**：真实加载路径硬上限 200 条，「300 条」不可达；阈值口径亦修正——两条见文末
  >「票单勘误」「OQ2」。原文保留不改，读作「满载 200 条」。

### 边界（本票**不做**）

- 不动 `stores/chat.ts`、不动 `packages/server/**`、不动 `packages/shared/**`
- 不改任何样式与视觉（`content-visibility` 若引入需单独说明并附实测，属加分项非必需项）

---

## 票 T2（挂账·**未派**）：服务端 typing 推送节流

`reply.ts:867-876` 逐 chunk emit 是「chunk 频率」这条轴的根因（与 N 这条轴相乘）。
**暂不派**——T1 直接命中用户报的那条轴（内容量），先落 T1 取实测读数；若实测显示**长流式单条**仍卡
（chunk 频率为瓶颈而非 N），再开本票。届时契约：合并窗口 ~60ms + **trailing 必发**（终态不得丢尾），
出口三条路径（完成/失败/中止）各需 flush 一次。改动落在 `packages/server` ⇒ 收口后需用户批准重启。

---

## Gate Report

### Gate A · 需求照准

✅ 全部可证伪。需求 = 「会话内容变多时前端不卡」，证伪条件 = A1 的调用增量断言不成立
（增量随 N 线性增长）或 A5 实测仍出现 >50ms 长任务。无「尽量快」「更好用」类不可测措辞。

### Gate B · 契约锁定

✅ 边界双向钉死（见「不做清单」+ T1「边界」）；契约 C1–C5 逐条落到文件/行为；
验收 A1–A5 每条对应一个可执行项，其中 A1 是机械断言（可进 CI），A5 是人工实测且要求附读数。

### Gate C · 反向证明

✅ A1 通过 ⇒ C2 成立（同一 chunk 不再按 N 触发 markdown）⇒ 根因「无渲染边界」被拆除；
A2 通过 ⇒ C1 的标量上移落地（父组件不再在模板里现算）；
A3 通过 ⇒ C3/C4/C5 的「只换计算位置、不改行为」成立；
A4 通过 ⇒ 无回归。
⚠️ 覆盖不到的残留：**A1 只钉住 typing 这一条触发路径**，NEW_MESSAGE / 历史加载 / 会话切换三条路径
不在此断言覆盖内——它们各自 O(N) 一次（非每 chunk），成本可接受，但**本票不对它们做性能承诺**，
如需覆盖另开断言。

### Gate Result

✅ PASS → 可进 implement（票 T1）

---

## 决策留痕

- 跳 grilling：因需求来自用户直接报障 + 已完成的代码勘察取证（根因链完整、可证伪），
  ⇒ 故本单不单跑 grill。
- Gate B 契约：[边界=不做虚拟滚动/不动 store/不动 server/零视觉变化；契约=C1 标量 prop 硬约束 +
  C2 折叠收起零 parse + C5 监听恰好一份；验收=A1 机械断言(200 条消息下 typing 更新后 renderMarkdown
  调用增量 ≤5) + A2 静态源断言 + A5 人工实测附读数] 已钉死。
- 架构裁决：**不做虚拟滚动**，依 ADR 0007「简单形态默认 + 复杂举证倒置」改用零依赖三层方案；
  若实测不足再带数据立项。
- 派活时机：T2（服务端节流）**已定架构但未授权开工**，等 T1 实测读数决定是否需要。

---

## 收口记录（2026-09-13 · 店长）

### T1 收口事实

| 项 | 值 | 复核方式 |
| ------------------------ | ----------------------------------------- | -------------------------------------------- |
| 被审 sha | `d96d3f8` | 判词原文点名 `ref: "d96d3f8"` 且「9 files / +2026 −1148」逐字对上 |
| carrier | PR **#70** → merge commit `5aa1032` | `gh pr view 70` |
| 被审 sha 作 parent 字面量 | parents = [`b85bcf5`, `d96d3f8`] | `git rev-list --parents -n 1 5aa1032` |
| 合并净差 | 9 files / +2026 −1148 | 与被审 diff 逐字一致 ⇒ 无冲突消解污染 |
| 合并态复跑 | **111 files / 2175 passed**，exit 0 | 较 vision 退役基线 109/2152 差 +2 文件 +23 测试，对得上 |
| lint | 三包 tsc / vue-tsc 全绿 | `pnpm lint` |
| 三方对齐 | `dev = origin/dev = .push-gate = 5aa1032` | 三条命令互等 |
| 重启 | **不需要** | T1 只动 `packages/web/**` + `docs/run/**` |

**未用 squash**：被审 sha 必须是 parent 字面量——squash 产出的是「内容等价、sha 不同」的提交，
正是 T-O 门禁规则④要拦的形态。

**审查链时间差已排除误判**：判词落库 `2026-09-12 16:49:27`（UTC）而提交时间戳为 `2026-09-13 00:45:05 +0800`
＝ 16:45:05Z，**判词晚 4.5 分钟**。DB 存 UTC，不是「审了旧 commit」。

### A5 读数（flash猫 执行 · 吐槽猫 独立复核 → 交由审查者解 ⚠️→✅）

流式期 200 chunk（30ms 节奏，思考段 2281 字符 + 1 个工具段）：

| 构建 | N | 帧率 | p95 帧间隔 | longtask >50ms |
| -------- | --- | ----- | ---------- | -------------- |
| POST-T1 | 201 | 60 | 17ms | 0（3/3 次） |
| POST-T1 | 56 | 60 | 17ms | 0 |
| POST-T1 | 9 | 60 | 17ms | 0 |
| PRE-T1 | 201 | 41–44 | 50ms | 0 / 0 / 1 |

一次性历史渲染（POST，重进会话，`SESSION_HISTORY` 权威全量校正）：
N=9 → **0ms** · N=56 → **200ms** · N=201 → **539 / 540 / 785 / 795ms**。

- **灵敏度自证**：同一页面每轮主动阻塞 5×120ms，观察者 **5/5 全捕获** ⇒ 「0 长任务」是显性证伪，
  不是聋子听诊。
- **假绿自纠（本条最值钱）**：首版只推 `AGENT_TYPING` 时 `messageStatus` 为空 ⇒ 用户消息状态行不渲染
  ⇒ `canStop` 未进渲染依赖 ⇒ pre/post **皆报 0**。补推 `agent-status(busy)` + `message-agent-status`
  并**断言 `.btn-stop-agent` 真渲染出来**（每轮 `stopButtons=1`）之后才开测。不补这步，这次读数就是
  「两个构建测了同一条不存在的面」——与 T1 勘察「typingStates 经停止按钮入渲染依赖」严丝合缝。

### 票单勘误两处（实测推翻派活口径，非执行缺失）

1. **「300 条」在真实加载路径不可达** —— `packages/server/src/db/repository/messages.ts:92`
   `getSessionHistory(sessionId, limit = 200)` 为 `ORDER BY created_at ASC LIMIT 200`，取**最早** 200 条。
   A1 用 200 条本身没错；A5 的「300 条」读作「**满载 200 条**」。
2. **自证闸判据不足：「状态码 200」≠「在测含本次改动的代码」** —— vite 的 SPA fallback 对**不存在的模块**
   也回 `200 + text/html + index.html`（实测 `:5173` 对 `/src/components/MessageItem.vue` 正是如此）。
   闸已升级为 **content-type + 模块特征双重断言**。**状态码不是内容**——同「验证面必须与被判面同面」。

### 裁决

**OQ1 · 重进长会话一次性 O(N)（N=201 时 539–795ms）是否立虚拟滚动新单？**
⇒ **不立单**。① N 有**硬上限 200**（勘误 1）⇒ 成本**有界**，且只在「打开会话」发生一次，不随使用时长增长；
② 用户报的「越用越卡」已被流式期 0 长任务正面证伪；③ 虚拟滚动的复杂度（动态高度 / 滚动锚定 / 搜索定位）
与之不成比例，违 ADR 0007「简单形态默认 + 复杂举证倒置」。
**挂 P3 观察项**，触发条件（任一成立才立项，且须带实测数据）：`getSessionHistory` 的分页/上限放宽到 >200；
或用户实测再次报「打开长会话可感卡」。立项时验收面须含 `content-visibility` 可见性表现（本读数未覆盖）。

**OQ2 · A5 阈值口径**：`>50ms` 长任务在 N=201 上 pre-T1 仅 1/3 次跨过 ⇒ **在本区间分不开档 ⇒ 不可判优**。
⇒ **采纳修正（裁决，非建议）**：后续同类验收以 **帧间隔 p95（或帧率）为主判**，`>50ms` 长任务降为**并列证据**。
本单读数已按此并列给出，原阈值**未改、未偷换**。
理由：验收指标若在被测区间分不开档，就是**恒真门**——「验证面必须与被判面同面」的底线。

**T2（服务端 typing 节流）⇒ 不派。**
T2 的开工触发条件是「实测显示**长流式单条**仍卡（chunk 频率为瓶颈而非 N）」。A5 读数给出的是反面：
200 chunk 全推完，帧率 60 / p95 17ms / 0 长任务，且与 N 无关 ⇒ 触发条件**未成立**。降为观察项。
触发条件：用户再报「长流式单条卡」，或 T1 落地后仍可感卡顿（届时以**帧间隔**为判据）。
届时契约不变：合并窗口 ~60ms + **trailing 必发**（终态不得丢尾），出口三条路径（完成/失败/中止）各 flush 一次；
改动落 `packages/server` ⇒ 收口后需用户批准重启。

### 本单遗留（不阻塞收口）

- 主库 `cat-study.db` / 实验库 `cat-study-dev.db` 的图测猫残留行清理属 vision 退役单，与本单无关。
- `:5173` 上那个**身份未确证**的 pre-T1 实例仍在跑（他人实例，只读未动）。
