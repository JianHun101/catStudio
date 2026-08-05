---
name: quality-gate
description: 代码变更提交审查前的自查门。检查编码规范、测试覆盖、架构边界、安全性和未完成项。通过后才能发起 /request-review。Use when a code change is finished and needs a self-check before review. Not for pure conversation without code changes, exploration, or when already inside the review loop. Output a Quality Gate Report (PASS/FAIL with per-item results).
---

# quality-gate

提交审查前的自查门。作者在发给其他猫审查之前，先自己检查一遍。

## 何时使用

- 完成一个代码变更后
- 在发起 `/request-review` 之前（前置条件）
- 对已有代码做改动后自查

## 不使用的情况

- 纯对话/回答用户问题（无代码变更）
- 探索/调研阶段
- 已经在审查循环中（receive-review 处理后）

## 检查步骤

### 步骤 1：VISION CHECK（需求对齐）

回到原始需求和讨论，确认：

- [ ] 改动实现了用户/任务要求的所有功能
- [ ] 没有范围蔓延（多做了不相关的改动）
- [ ] 如果有 .pen 设计文件，与实现做视觉对比

### 步骤 2：CODING STANDARDS CHECK（编码规范）

对照 `CODING_STANDARDS.md`（项目根目录）逐项检查：

- [ ] 包结构：代码放在正确的 monorepo 包中
- [ ] TypeScript：无 `any`，Zod 校验覆盖 API 边界，命名转换正确
- [ ] 测试：测试通过，覆盖新增/修改的功能
- [ ] 命名：文件 kebab-case，组件 PascalCase，函数 camelCase
- [ ] 错误处理：非阻塞降级、超时保护、结构化日志
- [ ] Vue：scoped 样式、v-html 经 DOMPurify
- [ ] 数据库：幂等迁移、JSON 字段处理、WAL 模式

### 步骤 3：TEST EVIDENCE（测试证据）

```bash
pnpm test
pnpm lint
```

确认：

- [ ] 所有测试通过
- [ ] 无新增 lint 错误
- [ ] 测试覆盖了新功能的关键路径

### 步骤 4：ARCHITECTURE BOUNDARY（架构边界）

- [ ] 依赖方向正确（shared ← server ← web）
- [ ] 无跨包直接引用（server 不 import web 代码）
- [ ] 新文件位置合理
- [ ] 如有新依赖，已声明并获批准

### 步骤 5：SECURITY SWEEP（安全扫描）

- [ ] 无硬编码的密钥/Token/密码
- [ ] `v-html` 已通过 DOMPurify 消毒
- [ ] API 输入有 Zod 校验
- [ ] 无 `eval()`、`new Function()`、`innerHTML` 裸赋值
- [ ] SQL 查询使用参数化（无字符串拼接）

### 步骤 6：UNFINISHED BUSINESS（未完成项扫描）

- [ ] 无 TODO/FIXME/HACK 注释（或已明确标记为有意保留）
- [ ] 无被注释掉的代码块
- [ ] 无 `console.log` 调试语句
- [ ] 无 `only`/`skip` 标记的测试（`test.only`、`it.skip`）

### 步骤 7：SELF-DOGFOOD（自测）

如果是用户可见的功能变更：

- [ ] 启动应用（`pnpm dev`）验证功能正常工作
- [ ] 至少走通一条完整的用户路径

## 输出

自查通过后，输出以下格式：

```
## Quality Gate Report

### Vision Check
✅ 所有需求已实现 / ⚠️ 以下需求未覆盖：...

### Standards Check
✅ 通过 / ❌ 以下项目未通过：...

### Test Evidence
pnpm test → N passed, 0 failed
pnpm lint → 通过 / M errors

### Architecture
✅ 边界正确 / ❌ 以下问题：...

### Security
✅ 无问题 / ❌ 以下风险：...

### Unfinished Business
✅ 干净 / ⚠️ 以下项目保留：...

### Gate Result
✅ PASS → 可以发起 /request-review
❌ FAIL → 以下项目需要先修复：...
```

## 衔接

- 通过 → 自动提示执行 `/request-review`
- 未通过 → 修复后重新运行 quality-gate

## Common Mistakes

| 错误                                     | 正确做法                                            |
| ---------------------------------------- | --------------------------------------------------- |
| 测试全绿就直接发起审查，跳过自查         | 先跑完 quality-gate 全部检查步骤，PASS 后才允许发起 |
| 只检查测试是否通过，不看需求是否全部实现 | VISION CHECK 回到原始需求逐条对齐，防范围蔓延       |
| 自查报告只写「✅ 通过」不列证据          | 每项附实际证据（测试数、lint 结果、涉及文件）       |
| 带着已知问题提交自查（「这个先这样」）   | 有未完成项 → FAIL，修复后再重新过门                 |

## 与其他 skill 区别

| skill          | 区别                                                                      |
| -------------- | ------------------------------------------------------------------------- |
| receive-review | quality-gate 是作者提交前自查；receive-review 是收到审查反馈后处理        |
| request-review | quality-gate 是前置门，PASS 后才能发起审查；request-review 是发起动作本身 |
| review         | quality-gate 是自查（自己过门）；review 是双轴代码审查（他人/工具视角）   |
