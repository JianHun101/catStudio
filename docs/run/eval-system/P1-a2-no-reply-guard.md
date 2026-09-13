# P1-A2 追补：`no_reply` 加 running 守卫

> 来源：P1-A 审查（吐槽猫，commit `51170dc`，结论 💬 仅评论）上报 OQ-1 / OQ-3。
> 店长裁决于 2026-09-13。**P1-A 本体已收口**（PR #72，dev `8b3fc712`），本票是读侧纯函数的独立追补，**不重开 P1-A 的审查面**。

## 一、Why：这不是推演出来的风险，是库里正躺着的两条活证据

`toHop()` 在同一行里说两件互斥的事：

- `chain-query.ts:110-112` 用「段算全 null」声明**这一段尚未结束**（`ended_at` 为 null）；
- `chain-query.ts:123` 却在 flags 里断言 **「没有回复」**。

于是前端 `EvaluationView.vue:604` 会把 `statusLabel(h.status)`（`running → '进行中'`）与 `no_reply → '无回复'` **并排渲染在同一行**——自相矛盾直接摆给用户看。

**实测证据（dev 库，本裁决时刻）**：`status='running'` 共 **2 行**，两行都会被误标 `no_reply`。

| exec id    | 猫      | started_at (UTC) | 真相                                         |
| ---------- | ------- | ---------------- | -------------------------------------------- |
| `ebbccf54` | 店长    | `15:55:15`       | 本次执行，正在写回复                         |
| `30f7ebd8` | flash猫 | `15:45:29`       | **已提交 `5ec2b3e`**（P1-B），正在写完工报告 |

两行都是**当下在飞的活跳**，不是残留。用户看「卡在哪一跳」，看到的是「无回复」，真相是「正在回复」。

## 二、契约变更（唯一一处）

```ts
// before（chain-query.ts:123）
if (row.message_id === null || row.reply_chars === 0) flags.push('no_reply')

// after
if (row.status !== 'running' && (row.message_id === null || row.reply_chars === 0))
  flags.push('no_reply')
```

**判据理由（三重，缺一不可）**：

1. **语义自洽**——`no_reply` 与 `no_data` 应当对称：两者都描述「**已结束的跳**的缺失」。当前不对称（`no_data` 有 `status === 'completed'` 守卫，`no_reply` 没有）是契约笔误，不是设计选择。
2. **同一行不得自相矛盾**——段算已声明「未结束」，flags 不得断言「没回复」。
3. **在飞 ≠ 无回复**——在飞跳的 `message_id` 必为 null 是**结构性必然**（回复还没产生），拿它当「无回复」的证据是拿「尚未」当「没有」。

## 三、边界（明写不做）

- **只动读侧纯函数**：`chain-query.ts` 判据一行 + `chain-query.test.ts`。**不碰采集**（`executionLogs.ts` 一个字节都不动）。
- **不碰 DDL、不碰前端、不引依赖。**
- **不加 `Chain.runningCount` 等新字段**——前端已在跳级渲染 `hops[].status`，链级聚合是便利字段非必需，避免契约膨胀。
- **不改 `spanMs` 算法**——它算的是「链内已见的最晚结束时刻 − 最早开始时刻」，定义本身正确（含在飞跳时为下界）。在飞链通常刚启动，跨度本就短，排名不受实质影响。

## 四、验收标准（行为可验证）

1. **running 跳不标 `no_reply`**：构造 `status='running'`、`message_id=null`、`ended_at=null` 的行 → 断言 `flags` **不含** `no_reply`。
2. **已结束但无回复的跳仍标**（防过度修正）：`status='failed'` / `reply_chars=0` → 断言**仍含** `no_reply`；`status='completed'` 且 `message_id=null` → **仍含**。
3. **既有断言零回归**：四 flag 正例 + `no_data` 负例 + `hops.length === hopCount` + 孤儿桶 + `totals` 不受 `limit` 影响，全部保持绿。
4. **真机复核（非单测）**：直连 dev 库跑 `buildChains`，
   - 2 条 `running` 行 → `flags` 不含 `no_reply`；
   - `failed` 行 → 仍带 `no_reply`（修复前该数 = 71 − 2 = 69，修复后 **应仍为 69**，仅 running 那 2 条退出）。
5. **全量测试 + lint 全绿**；commit message 带 `catstudy [$CATSTUDY_TRIGGER_MSG_ID]`，行号 grep 复核。

## 五、决策留痕

**OQ-1 裁决 = 加守卫。** 判据见上「三重理由」；关键是它**报假数**（主动错标），而非欠报（不完整）——评估系统的全部价值建立在「不骗人」上。

**OQ-3 撤销：ds猫 报的「幽灵 running（8 小时未收口）」实证不成立。**
它报「两条 started_at 都是 15:45:29、至今 8 小时」。实测：一条是 `15:55:15`（不是 15:45:29），另一条距今 **8 分钟**而非 8 小时。
**根因**：手工 SQL 对账时把 UTC 时间戳当成本地时间读——**正是它在 `chain-query.ts:97-99` 亲手写下的警告**（不补 `Z` 差 8 小时）。代码里做对了，对账时踩了自己立的规矩。
**保留的观察**：它顺带发现「在飞跳所在链 `spanMs` 排名 165/482、被 `limit=20` 截掉」——该观察**成立**，但根因是排序契约（跨度降序）而非幽灵；按本票第三节，`spanMs` 定义正确，不改。

**OQ-6 单开一票，不阻塞本票。** `parseFloat(env || '默认')` 在 env 为 `abc` 时得 `NaN`，`totalMs > NaN` 恒 false ⇒ `slow` 静默全不标。既有四处阈值同病（`l1-aggregator.ts:32` 等），本票只是同款携带。整族加 `Number.isFinite` 回退另立一票。

**教训（记一笔）**：实施者在自己写下时区警告的同一文件里，手工对账时踩了那个坑——**警告写在代码注释里，不会自动传导到临时脚本**。凡「手工 SQL 对账」结论，落库前必须先确认时区口径。
