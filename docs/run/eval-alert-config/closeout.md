# 收口记录：评估告警样本门 + 阈值设置化（P2-1 返工）

**状态：✅ 已入 dev** —— PR [#222](https://github.com/JianHun101/catStudio/pull/222)（head = `feat/eval-alert-config`，即已审 sha `70f99a774ec45f73738954eb3b2a76fefebfcdca` 字面量，无附加提交）→ merge commit `3b74332aa7136ace8f704763d721c8393e0880dd`（父 = `cff88ca` + `70f99a7`）。

## 审查链

- 审查者：吐槽猫；原票 **⚠️**（P2-1）→ 返工后复核 **💬 仅评论**，无 P2 及以上。
- 独立复跑（审查者侧，非作者自报）：`SettingsView.test.ts` **78 passed**；全仓 `vitest run` **3884 passed / 170 files**；`node scripts/lint.js` **三包通过**。
- 收口侧独立复跑：本票相关 8 个测试文件 **256 passed**（server 5 文件 + web 3 文件），`git merge-tree` 实测对 dev 无冲突。

## 收口机械步骤（实读）

| 步             | 读数                                                                             |
| -------------- | -------------------------------------------------------------------------------- |
| 已审 sha       | `70f99a774ec45f73738954eb3b2a76fefebfcdca`                                       |
| push           | `origin/feat/eval-alert-config`（pre-push 判据 ①「推的正是审查记录那一笔」放行） |
| PR             | #222（base = `dev`）→ MERGED                                                     |
| merge commit   | `3b74332a`（GitHub merge commit，父 `cff88ca` + `70f99a7`）                      |
| 合并态三方对账 | dev = origin/dev = `3b74332a`                                                    |

> 本票分支基于 `bd3f81f`，而 dev 已前进到 `cff88ca`（含 PR #221），故「会话分支 ff 到已审 sha」不成立：**推送的是已审 sha 所在的 `feat/eval-alert-config` 本身**，由 GitHub 在 dev 侧生成 merge commit。没有 rebase、没有等价提交、没有夹带。

## P2-1 修法

- 加载/保存成功时把生效值存为基线（百分比口径）；保存时逐字段与基线比差，只拼实际改动的字段；空 patch 不发请求。
- 基线缺失（配置尚未加载成功）不发请求——防把 env 兜底冻结成默认值。
- 服务端 `validateEvalAlertPatch` 接受 ≥1 字段的部分 patch，未传字段继续跟 env：这不是前端单边约定，是全链路契约。

## P3 留痕（审查判定不返工）

1. **P3-A 基线前移缺回归门**：保存成功后再点一次保存，应断言不发第二次请求（或只带新改字段）。
2. **P3-B 基线缺失分支无用例**：UI 不可达（加载成功态才渲染表单），补不补都行。
3. **P3-C「没有改动需要保存」复用绿色成功样式**：语义上是提示不是保存成功。
4. **P3-D l1-metrics 纯读用例退化为恒真门**：`packages/server/src/routes/eval.test.ts` 的 `it('GET /api/eval/l1-metrics 是纯读：不落任何告警消息')` 用「`messages` 计数不变」证明 GET 没走 `runL1Aggregation`；但 `l1-aggregator.ts` 现在没有任何写 `messages` 的路径，该断言量不到所声称的面。应按原审查方案改状态机探针：预置破线数据 → GET → 再调 `runL1Aggregation()` 断言 `alert === true`。
5. **P3-E「只提交改动字段」的固有代价**：env 生效值无法被 UI 显式钉住的（想在当前值上锁定，差值为空、发不出去）。有锁定需求需 per-field reset/pin 控件，另票。

## 重启判定：需重启

server 侧非测试新增行（去缩进后判 `//` `/*` `*`）：`config/eval-alert-config.ts` 119 非注释行（新增文件）、`eval/l1-aggregator.ts` 83、`routes/config.ts` 17、`routes/eval.ts` 16、`env.ts` 2、`index.ts` 2；`db/repository/sessions.ts` 3 行新增**全为注释**（0 非注释）。全部落在启动期 import 链上，运行实例不重载永远跑旧代码 ⇒ 走共通层重启审批。
