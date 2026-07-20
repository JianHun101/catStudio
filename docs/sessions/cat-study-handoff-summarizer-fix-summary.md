# 修复 handoff 摘要取错消息 + 去掉内容截断 + 模型迁移

## 1. What — 具体改动

| 文件                                      | 改动                                                                                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/handoff/index.ts`    | `generateFullSummary`：ORDER BY ASC→DESC+reverse 修复取最早 300 条的 bug；去掉每条 `.slice(0, 500)` 字符截断；默认模型 `deepseek-chat`→`deepseek-v4-flash` |
| `packages/server/src/summarizer/index.ts` | `updateRunningSummary`：去掉每条 `.slice(0, 500)` 字符截断；默认模型迁移                                                                                   |
| `packages/server/src/env.ts`              | `SUMMARY_MODEL` 默认值从 `deepseek-chat` 改为 `deepseek-v4-flash`，注释更新                                                                                |
| `.env.example`                            | 模型名和注释更新                                                                                                                                           |

## 2. Why — 为什么这样做

### 根因：L11"排序冗余修复"引入了语义 bug

commit `beaff7a` 中把 `ORDER BY m.created_at DESC LIMIT 500` + `allMessages.reverse()` 简化为 `ORDER BY m.created_at ASC LIMIT 500`。表面等价（都是时间正序），但 SQL 语义不同：

```
旧代码：DESC LIMIT 500 → 取最新 500 条 → reverse → 时间正序 ✓
新代码：ASC LIMIT 500  → 取最早 500 条 → 无需 reverse → 时间正序但取错了 ✗
```

对于有上千条消息的长会话，handoff 摘要会基于几天前的对话开头生成，完全丢失近期上下文。

### 去掉字符截断

deepseek-chat（已重定向到 deepseek-v4-flash）有 **1M tokens 上下文**。之前每条消息 `.slice(0, 500)` 截断是过度保守——截断会直接丢失消息后半部分的内容。300 条完整消息远在 1M 窗口内。

### 模型名迁移

`deepseek-chat` 是旧别名，**2026-07-24 退役**（4 天后）。现在已重定向到 `deepseek-v4-flash`，直接使用新名称避免退役后 API 调用失败。

### 诊断过程：店长不触发 review 不是 dispatch 代码的 bug

分析 `cf4c699b`（项目进度会话）日志后发现：

- Agent-to-Agent dispatch 机制（`parseMentionsFromReply` → `executeAgentsSerial` → `dispatch`）未改动，功能正常
- 店长在 09:40 正确触发了 @吐槽猫 review（改代码之前）
- 店长在 09:48 写代码后**没有** @吐槽猫（改代码之后）
- 原因是 LLM 行为漂移——deepseek-v4-pro 在 87 条消息的长上下文中未遵守 IRON_LAWS_CODER 的 @mention 规则

```
用户 @店长 → 店长写代码 → 没 @吐槽猫 → 吐槽猫不触发 → review 链断
                ↑
          LLM 行为问题（非代码 bug）
```

## 3. Tradeoff — 放弃了什么方案

| 放弃                                  | 原因                                                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 保留 `.slice(0, 500)` 只改 LIMIT      | 截断是丢数据——用户明确不要。1M 上下文足够容纳完整消息                                                                 |
| LIMIT 保持 500 或更大                 | 去掉截断后消息总量变大，300 条已经能覆盖足够长的对话上下文，多余的边际收益低                                          |
| 只修 ORDER BY 不动模型名              | 4 天后 `deepseek-chat` 退役会静默炸掉，不如顺手迁了                                                                   |
| 在 system prompt 里强化 @mention 规则 | 店长不 review 是 LLM 行为问题，不是 prompt 不够强。当前 IRON_LAWS_CODER 已经写得很清楚，强化可能无效且增加 token 开销 |

## 4. Open Questions — 不确定的点

- **summarizer 400 错误**：`updateRunningSummary` 持续报 `unexpected end of hex escape`，日志显示至少 7 次失败。当前是 fire-and-forget 所以不阻塞，但意味着 running_summary 一直没更新。不确定是 deepseek API 的 JSON parser 对某些 Unicode 序列的处理问题，还是 `chatComplete` 的 body 构建有问题。当前未修复。
- **店长 review 链断裂**：LLM 在长上下文中不遵守 @mention 规则。`parseMentionsFromReply` 的行首匹配策略本身没问题，但如果 Agent 根本没输出 @mention，代码层面无法兜底。可能需要考虑在 LLM 之外加一层"出口检查"——Agent 回复后检测是否写了代码但没 @ 任何人，如果是则系统自动插入一条提醒消息。
- **300 条无截断的实际 token 量**：当前估算 300 条完整消息在 1M 窗口内安全，但如果 Agent 输出极长的代码文件（10K+ 字符），少数几条就可能撑爆。当前没有做总 token 预算检查，仅凭条数限制不够精确。

## 5. Next Action — 希望做什么

- ✅ ~~修复 handoff ORDER BY 语义~~
- ✅ ~~去掉 handoff + summarizer 的内容截断~~
- ✅ ~~迁移默认模型名~~
- [ ] 调查 summarizer 的 `hex escape` 400 错误——写一个复现用例确认是 API 端还是客户端的问题
- [ ] 给 handoff 的 `generateFullSummary` 加总 token 预算检查——如果 300 条完整消息超 900K tokens 则逐步减少条数
- [ ] 考虑 Agent 出口检查——回复后检测代码改动但无 @mention 时自动插入提醒
