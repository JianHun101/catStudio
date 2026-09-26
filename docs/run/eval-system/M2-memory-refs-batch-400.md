# M2 票：memory-refs 批量口被 welcome 伪消息 id 整批 400 —— M1/R14b 前端全灭（**缺陷**·在飞 2026-09-26）

> 来源：用户实测「底部没有见到检索的记忆」→ 店长真机复现 + 根因定位（本票 §一证据链，全部实跑，非推断）。
> 派活对象：**ds猫**（M1 修复与 R14b 前端都是它落的，上下文最新）。
> 行号基线：`dev@4fdda4cc`。**实施者落笔前按自己那棵树重取一遍。**

## 一、现象与证据链（均已实跑复现）

**现象**：生产 UI 里**任何会话**都不渲染记忆行（📎 / 未使用 / 未检索 三态全灭），R14b 角标也一并消失——两者共用同一条批量口。

证据链（2026-09-26，店长真机）：

1. CDP 驱动无头 Edge 开 `http://127.0.0.1:5173`，console 抓到：
   `[ChatPanel] fetchMemoryRefs failed | error=Error: messageIds not in session 4c7fde77-…: welcome-4c7fde77-4f4d-4688-ab9f-5a83b6ac5161`
2. 渲染态 DOM 实测：25 条消息渲染、`msg-memory-refs` 行 **0** 条、`sup.mem-citation` **0** 个。
3. 对照：同一批 24 个**真实**消息 id 直打 server（3200）与 vite 代理（5173）均 **200**，返回 24 entries（injected 6 / not-retrieved 18）——server 与代理都无病。
4. 根因：`SESSION_HISTORY` 由 server 合成一条 welcome 伪消息（`connectors/socketio.ts` 的 `welcomeMsg`，id = `welcome-<sessionId>`，role=system，**不落 messages 表**）；前端 `fetchMemoryRefs`（`ChatPanel.vue`）把 `activeMessages` **全量 id** 发给批量口；server 的越权守卫 `messageExists` 查不到该 id → **整条 400**；前端 fire-and-forget 吞掉 → 全会话零渲染。
5. 推论：**每个会话都有 welcome 消息 ⇒ 该批量口在生产从未成功过**——M1 上线即死，R14b 角标同源同死。此前「最新回复短暂显示未检索」的修法是对的，但它修的是一条从没被走到的路。

## 二、修法（店长裁决：**甲**）

**前端只发 agent 消息的 id**：`fetchMemoryRefs` 里 `store.activeMessages` 先过滤 `m.role === 'agent'` 再取 id。

判据同源：记忆行本来就只对 agent 消息渲染（`memoryRefViewFor` 非 agent 返回 `null`）——**请求面与消费面对齐**，伪消息（welcome）与 user/system 消息天然被排除，还顺带缩小了 URL。

**不取乙**（server 对未知 id 放宽为跳过）：`400 on foreign` 是设计守卫（越权不静默返回空，`routes/memory.ts` 头注），不削。守卫不动，修发送方。

## 三、边界

- 只动 `packages/web/src/components/ChatPanel.vue`（`fetchMemoryRefs` 一处过滤）+ 对应测试。
- **不改 server**（路由、守卫、三态语义全不动）；不改 welcome 消息本身（它是 SESSION_HISTORY 的既有契约）。
- web-only ⇒ 合入 dev 后 vite HMR 即生效，**无需重启审批**；真机验收 = 硬刷新。

## 四、验收（行为可验）

1. **回归测试（承重）**：组件/组装测试——`activeMessages` 含 `welcome-<sid>` 伪消息 + 若干 agent 消息时，捕获 `api.getSessionMemoryRefs` 入参：ids **不含** welcome id、**不含** user 消息 id、**含**全部 agent 消息 id。
2. **真空性反对照**：摘掉过滤 → 验收 1 的测试必须红（确认断言不是恒真门），红后还原。
3. **端到端形态**： mock 批量口返回 injected 条目 → 记忆行渲染（既有测试若已覆盖则引用，不重复造）。
4. **守卫不削弱**：server 侧「foreign id → 400」的既有测试零改动（`git diff` 该测试文件为空）。
5. `pnpm test` + `pnpm lint` 全绿（环境注入变量按既有口径剥）。

## 五、真机验收（收口后，店长执行）

硬刷新会话页 → 有注入的回复底部出「📎 记忆 N 条」、a2a 回复出「未检索记忆」、带 markers 的回复正文 `[n]` 渲染为 `sup.mem-citation` 角标、hover 出卡片。DOM 判据：`document.querySelectorAll('.msg-memory-refs').length > 0` 且 `sup.mem-citation` 计数 > 0（本会话 15:11 的设计答复消息 markers=[1,2]，是现成观察对象）。

## 六、教训留痕（不挡本票）

- M1 审查链漏核「需真实浏览器才能验」的判据——撞上既有记忆「审查清单 vs 票面验收项」（回执漏核需新建环境的核心判据）。本票 §五 把真机判据写成 DOM 断言，收口时必须真跑。
- 店长上轮给用户的空间诊断（「server 全链绿 ⇒ 浏览器缓存」）是**误诊**——查遍了 server 侧每一环，唯独没看浏览器 console。对应既有教训「探针须打在声称面上」：判「浏览器没拿到」必须真的从浏览器里看。
