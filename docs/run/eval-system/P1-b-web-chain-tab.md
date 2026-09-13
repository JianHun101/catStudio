# P1-B 票单：评估中心「链路」tab

<!-- label: wayfinder:ticket -->
<!-- 上游地图: map.md（Destination + Decisions so far） -->
<!-- 依赖: P1-A 的两条只读端点。**契约已冻结**（见下），可与 P1-A 并行开工 -->

Claimed by: **flash猫**（2026-09-13）
Blocked by: **无**（契约已冻结到字段级，可照契约先写 UI + mock 测试；真机联调归店长收口）

Status: **已交付，待审查** —— commit `5ec2b3e`（详见文末 Resolution）

## 目标

让用户**看得见**「哪条链耗时最长、卡在哪一跳」。回答地图四个问题里的 ②（卡点在哪）和 ③（哪里耗时最长）。

## 一、落点（架构裁决，别另起 view）

**`packages/web/src/views/EvaluationView.vue`** —— 已有「全屏评估中心」，已挂左侧栏底部入口（`App.vue:7,15`）。

现在双 tab：`const activeTab = ref<'observe' | 'review'>('observe')`（`:22`），tab 栏在 `:191-207`。
本票**加第三个 tab `'chain'`（标签「链路」）**，与另两个平级。

**不要**新建 view、不要加 vue-router（本项目无 router，App 级布尔切换是既有形态）。

## 二、契约（冻结，照抄，别改字段名）

两个只读端点，均由 P1-A 实现。**字段名以此处为准**——两边不一致会在店长收口的端到端联调里露馅。

### `GET /api/eval/l1-metrics`

```json
{
  "windowDays": 30,
  "successRate": 0.87,
  "timeoutRate": 0.02,
  "avgLatencyMs": 198800,
  "totalTokens": 12345,
  "suggestRate": 0.1,
  "rejectRate": 0.05,
  "parseFailureRate": 0.01,
  "infraFailures": 3,
  "sampleTotal": 1010
}
```

`avgLatencyMs: number | null` —— **null 是合法值**（窗口内无 completed 样本，或修复前的存量窗口）。显示 `—`，别显示 `0ms`。

### `GET /api/eval/chains?limit=&windowDays=`

```json
{
  "windowDays": 30,
  "anchor": "coalesce(reply.task_id, trigger.task_id)",
  "slowMs": 300000,
  "totals": {
    "chains": 482,
    "hops": 1084,
    "orphanHops": 28,
    "avgHopsPerChain": 2.19,
    "maxHops": 26
  },
  "chains": [
    {
      "chainId": "9b4509e7-…",
      "startedAt": "2026-09-01 10:00:00",
      "endedAt": "2026-09-01 11:04:06",
      "spanMs": 3846000,
      "hopCount": 25,
      "completedCount": 21,
      "failedCount": 4,
      "hops": [
        {
          "executionLogId": "…",
          "agentId": "…",
          "agentName": "ds猫",
          "status": "completed",
          "errorType": null,
          "startedAt": "2026-09-01 10:00:00",
          "endedAt": "2026-09-01 10:02:00",
          "totalMs": 120000,
          "replyMs": 118500,
          "nonReplyMs": 1500,
          "segmentClamped": false,
          "flags": [],
          "triggerMessageId": "…",
          "replyMessageId": "…"
        }
      ]
    }
  ],
  "orphanChain": { "chainId": null, "hopCount": 28, "hops": [/* 同上形状 */] }
}
```

**`hops[]` 一行 = 一条 `execution_logs`（执行跳），不是一条 messages 行。**
失败的跳**没有回复消息**，但**必须出现在 `hops[]` 里**——这是本视图存在的理由（按消息行分组会把卡点静默吞掉）。

**DTO 类型就地声明在 `packages/web/src/composables/useApi.ts`**（跟 `EvalScoreRow:119` / `ScoreAggregate:133` / `EpisodeStats:155` 同款），**不要**塞进 `@cat-study/shared`——shared 放领域类型（Message/AgentConfig），HTTP 响应 DTO 的既有惯例在 useApi。

## 三、展示契约（用户看得懂是硬要求）

1. **概览条**（顶部）：链数 / 总跳数 / 均跳数 / 最长跳数 / 孤儿跳数 + 窗口天数。
2. **链列表**：按 `spanMs` 降序（后端已排好，前端别重排）。每链一行摘要：
   `跨度 | 跳数 | 完成/失败 | 起止时间`。**失败数非 0 的行必须有可见视觉区分**。
3. **展开一跳瀑布**：每跳显示猫名 + 状态 + 三段耗时。
   - `replyMs` / `nonReplyMs` 用**横向堆叠条**表示（比例 = 该跳 `totalMs` 内占比）。
   - **`replyMs === null` 时该段画成斜纹/灰条并标注「无数据」**——**不要画成 0 长度**。0 和「无数据」是两回事（这正是 clowder-ai 的 `TelemetryGap` 那条教训）。
   - `segmentClamped === true` → 标注「秒级舍入」小字。
4. **flags 徽章**：`failed` / `no_reply` / `slow` / `no_data` 四类各一色，可同时出现。
   文案用中文短词：失败 / 无回复 / 超时 / 无数据。**别只靠颜色**（要带文字，色盲可读）。
5. **orphanChain 单独一区**，标题写「未归属跳（无链锚）」，**恒显示**（`hopCount: 0` 时显示「无」但区块不消失）。
   **不得静默丢弃**——这是 28 行真实数据的落点。
6. **`running` 跳**（`endedAt: null`）显示为「进行中」，耗时显示 `—`。

### ⚠️ 文案禁用词

**不许**把 `nonReplyMs` 写成「等锁」「等 token 锁」。
它的真实含义是 **等 token 锁 + 编排收尾 + 建行开销**（等锁是主要成分但未实测占比）。
`replyMs` 也不是纯 LLM 段——它含上下文过滤 / 记忆检索 / 落库。
中性文案：**「回复生成段」/「非回复段」**。

### 时间戳

后端透传 SQLite 的 **UTC 字符串** `YYYY-MM-DD HH:MM:SS`（无时区后缀）。前端展示须转本地时区——注意 `new Date("2026-09-01 10:00:00")` 在浏览器里按**本地时区**解析（不是 UTC），要用 `new Date(s.replace(' ', 'T') + 'Z')` 显式当 UTC 解析，否则差 8 小时。**这条要写测试**。

## 四、验收标准

1. tab 栏出现第三个「链路」，点击切换，不影响既有 observe / review 两 tab（既有测试不回归）。
2. 加载态 / 错误态齐备（照 observe tab 的 `observeLoading` / `observeError` 同款）；两个端点用 `Promise.all` 并行拉（`:109` 同款范式）。
3. 单测（`EvaluationView.test.ts` 追加，mock fetch）：
   - 一条含 `failed` 跳的链 → 该跳**可见**且带「失败」徽章（**防「按消息行渲染」的回归**）
   - `replyMs: null` 的跳 → 渲染「无数据」，**断言不是 `0ms`**
   - `orphanChain.hopCount > 0` → 孤儿区渲染且条数正确
   - `avgLatencyMs: null` → 显示 `—` 而非 `0ms`
   - UTC→本地时区转换：固定输入串 → 断言输出（防差 8 小时）
4. 纯展示 + 只读：**零写入、零 LLM 调用**（与既有「观察 tab」同款约束）。
5. `pnpm lint` 通过；`pnpm test:web` 全绿。

## 五、边界（**不做**）

- 不加新 view、不加 router、不动 `App.vue` 的入口结构（除非 tab 需要新图标——那也只动该处）。
- **不做筛选/排序交互**（P1 裁决：四类 flag 全标不筛，让用户先看分布）。
- **不做定时刷新/轮询**。
- 不改后端任何文件——**P1-B 只碰 `packages/web/**`**。
- 不引入新依赖（图表用 CSS 堆叠条即可，**别引图表库**）。

## 六、提交规范

- **worktree**：在 `D:/Game/ai/catStudy-sessions/0eb66b63` 内干活，git 一律 `git -C D:/Game/ai/catStudy-sessions/0eb66b63 <cmd>`。
- **限定路径**：`git add packages/web/src/...`（**显式路径**）。**与 P1-A 并行**——`git add -A` 会扫走 ds猫 未提交的 server 改动，**严禁**。
- **uuid 标记**：commit message 带 `catstudy [<uuid>]`，uuid 取 **`$CATSTUDY_TRIGGER_MSG_ID`**（本会话 = `d4c52ec4-e909-4f53-93a6-6108a3aa3e2a`）。
  ⚠️ **不是 `$CATSTUDY_MSG_ID`**——诱饵变量，会被门禁挡下。
- **禁 `--no-verify`**；push 归店长。

## 决策留痕

- 跳 grilling：因 需求经 wayfinder 地图收敛 + 用户 2026-09-13 批「开工」；契约由 P1-A 冻结在字段级 → 故本单不单跑 grill
- Gate B 契约：[边界=**只碰 `packages/web/**`**，不加 view/router/筛选/轮询/图表库 / 契约=P1-A 端点 JSON 逐字段照抄 + DTO 落 `useApi.ts`（既有惯例）/ 验收=5 条，含 4 条针对性单测（失败跳可见 / null≠0 / 孤儿区 / 时区）] 已钉死
- 架构裁决①：**不新建 view**，加在既有 `EvaluationView.vue` 的 tab 栏做第三个 tab（本项目无 vue-router，App 级布尔切换是既有形态）
- 架构裁决②：DTO **不进 `@cat-study/shared`**——shared 放领域类型，HTTP 响应 DTO 的惯例在 `useApi.ts`（`EvalScoreRow:119` 等）
- 展示裁决：`null`（无数据）**必须**与 `0`（自解释为零）视觉可分——正面抄 clowder-ai 的 `TelemetryGap` 教训（「我不知道」和「我没有」是两种状态）
- 文案裁决：禁「等锁段」，用「回复生成段 / 非回复段」

## Resolution

**Commit `5ec2b3e`** · `packages/web/**` 3 文件（+975/−7）· 零新文件、零新依赖、零后端改动

| 验收项                                         | 结果                                                                                                                                                                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 第三 tab「链路」平级切换，既有两 tab 不回归 | ✅ 既有 18 条用例全保留通过（原「双 tab」静态断言按新形态更新为三 tab）                                                                                                                                                    |
| 2. 加载/错误态齐备 + `Promise.all` 并行拉      | ✅ `chainLoading`/`chainError`/`loadChains`（`EvaluationView.vue:304`）照 observe 范式                                                                                                                                     |
| 3. 五条单测                                    | ✅ 失败跳可见+徽章 / `replyMs:null`→「无数据」且断言非 `0ms` / 孤儿区条数与空态 / `avgLatencyMs:null`→`—` / UTC→本地时区。**另做过变异验证**（改坏 UTC 解析与 null 分支 → 对应用例确实转红），防「写了但不会失败」的假绿门 |
| 4. 纯展示 + 只读                               | ✅ 零写入、零 LLM 调用                                                                                                                                                                                                     |
| 5. `pnpm lint` / `pnpm test`                   | ✅ lint 三包全绿；全量 vitest **112 files / 2236 passed**                                                                                                                                                                  |

**实现要点**：`chainGroups`（`:70`）把正文链与孤儿组归一成同一形状 → 一个 `v-for` 覆盖两处，不复制跳模板；
`l1Cards`（`:155`）把 8 张指标卡收敛成数据驱动；孤儿区默认收起但**数量恒显示**（「不得静默丢弃」靠可见数字与恒在区块）。

**契约对齐**：落锤前对 P1-A 的**已落 sha `51170dc`** 逐字段复核——`routes/eval.ts:84/107` 两条响应确为**平铺**（无 `ok` 外壳），`chain-query.ts:33-72` 字段名与小驼峰 100% 一致。

**⚠️ 门槛 #5（前端真机自证）本轮未满足**：运行中的 server 是 P1-A 提交**之前**启动的进程，两条端点在其中不存在；真机 happy path 必须等一次重启，而重启归用户决策且票单 `Blocked by` 明写「真机联调归店长收口」→ 本轮不重启（也不自起第二个 server 抢 3200/5173 与 embed sidecar 端口）。替代证据：vite 生产构建（308 modules）+ jsdom 挂载测试 + 对已落 sha 的契约复核。**解锁条件：店长收口 → 重启审批 → 用户点头 → 端到端联调。**

**遗留观察项（已点名给审查者，非阻断）**：① 平铺契约若日后被包 `ok` 外壳 → 前端**静默**读不到数（不抛错）；② `chainId` 回退分支疑似投机性防御（契约保证非空）；③ `segPct` 各自钳位未归一化，`segmentClamped` 时第二段贴边；④ 失败跳行内「失败」文案出现两次（状态词 + 徽章）；⑤ 概览条是全量口径而列表受 `limit` 截断，页面上无落差说明。
