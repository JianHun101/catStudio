# 票：夹具仓库钩子泄漏活会话 —— handoff 链无身份校验，测试提交可触达真实会话

> 状态：已立票 · 未派
> 来源：hook-marker-fail-open 票矩阵测试的活实证（flash猫 发现清单 N2，店长独立 triage 确认）
> 基线：dev `4fdc4651`

## 现状

在 `/tmp` 等临时路径造夹具仓库测钩子（本仓标准探针姿势）时，夹具会继承两样东西：

- `core.hooksPath` 指向真仓 `.husky`（复制配置或 worktree 派生时带上）；
- 环境变量 `CATSTUDY_SESSION_ID`（驱动 shell 从活会话继承）。

实证（2026-09-28，两次实例 `e09340a` / `3f8047c`）：夹具仓库内造带伪 uuid 的 commit ⇒ post-commit hook 里的 handoff-gen 以活会话身份向**活 server** 投出交接补填请求 ⇒ 伪 uuid 反查端点 404 ⇒ 走兜底 @店长，在真实会话里造出两条噪声消息。真实侧零污染（.push-gate / 账本 / 草稿槽均未被写）纯属侥幸——兜底路径只投消息不写账本是现状，不是保证。

机制层面：handoff 投递链只认「环境里有 session id + 钩子被触发」，**不校验触发方是不是这个会话的仓库**——身份面零防线。hook-marker-fail-open 票管的是「标记怎么写」（标记面），本票管「谁的身份」（身份面），两层互不覆盖。

## 任务

1. 先实测钉清触发链（别凭记忆落笔）：post-commit → handoff-gen 的哪一环读了 `CATSTUDY_SESSION_ID`、哪一环可以插校验，产出链路图入交接文档；
2. 定身份校验方案并实施，候选方向（实施时择一或组合，选型理由写交接文档）：
   - handoff-gen 校验 `git rev-parse --git-common-dir`（或 toplevel）是否属于该 session 登记的仓库/worktree 集合，不属于则拒绝投递并显式告警；
   - 钩子入口校验环境里的 session id 与当前仓库的归属关系（如会话 worktree 登记表）；
   - 投递带仓库指纹，server 侧比对 session 归属再入账；
3. 方案不得误伤合法路径：会话 worktree（`catStudy-sessions/*`）内的提交必须照常触发 handoff——worktree 的 git-common-dir 指向主仓，校验逻辑要正确处理这一形态。

## 验收

1. 复现实证场景：夹具仓库（hooksPath 指真 .husky + 继承 CATSTUDY_SESSION_ID）造 commit，投递被拒且有显式告警；反对照：真仓 + 会话 worktree 内提交照常触发 handoff（构造真 commit 实跑，不靠读代码推断）；
2. 受影响测试绿；若改 hook/脚本行为语义，同批扫复述文本（AGENTS.md、相关技能正文）并回报清单；
3. 交接文档说明「拒绝投递」的可观测性——静默拒绝等于把噪声换成隐身，要有日志或告警面。

## 边界

- scripts/hooks 治理面；不动审查链路由、不动 handoff 草稿槽/账本语义。
- 与 hook-marker-fail-open 票互不依赖、可独立收口；若同期在途，双方不得互改对方文件。
- 历史噪声消息（两条补填请求）不清理不回填，只堵机制。
