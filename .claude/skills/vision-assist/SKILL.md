---
name: vision-assist
description: Use the project's qwen3.5:9b (Ollama) vision pipeline as your eyes. Use whenever the task requires SEEING an image — the user attaches an image and asks what it shows, asks to describe a picture, wants visual review of a UI screenshot, or needs image-link functionality verified. Your own model cannot render images natively (Read returns "[Unsupported Image]"), so route any image-seeing task through this pipeline instead of trying to read pixels yourself.
---

# Vision Assist — 用 qwen3.5:9b 当眼睛

**本环境模型无法原生看图**（Read 工具读图返回 "[Unsupported Image]"）。所有"看"的任务直接走项目现成链路，不要自己先试读图再绕路——一步到位。

## 触发场景（出现即用）

- 用户发图片消息问"图里是什么 / 画了什么"
- UI 截图评审（输入框突兀感之类）
- 验证图片链路是否工作
- 任何需要看到像素内容的任务

## 一键命令（首选，零思考成本）

```
npx tsx packages/server/src/ui-review.ts <图片路径> ["任意指令"]
```

支持任意图片 + 任意指令（描述内容 / 评审 UI / 验证识别）。脚本自动完成：sharp 压缩（最长边 1280, q80）→ base64 → Ollama `/api/chat` `images` 字段 → 打印结果。

## 图片来源

1. **用户消息里的图片**：SQLite `messages` 表 `images` 字段（JSON 数组，完整 `data:image/*;base64,...` dataURL）。用 better-sqlite3 查最近一条带图的消息，解码落盘到 `scripts/shots/` 再喂给脚本
2. **截图产物**：`scripts/shots/`（`scripts/ui-screenshot.mjs` 用 Playwright 截）
3. **手动截图**：用户给的文件路径

**选源规则（图在 DB → 取 DB，别重截页面）**：DB 里存的 dataURL 就是用户上传时的原始字节（sha256 可验证），解码直接喂模型**零额外损失**；重截页面反而丢精度——截图拿到的是"气泡里缩放渲染后的图"，二次编码 + 分辨率缩水。截图只留给"页面现状不在任何库里"的 UI 评审场景（UI 只存在于渲染后的屏幕上，DB 里没有它的图）。

## 关键事实（踩过的雷，别再踩）

- **Ollama 只收裸 base64**，带 `data:image/` 前缀报 `400 illegal base64 data at input byte 4`（byte 4 是冒号）。`ollama.ts` 的 `toOllamaImage()` 已处理，但直接手调 API 时要自己剥
- Ollama 服务由**桌面 App** 管（`127.0.0.1:11434`，勿用 localhost），模型名 `qwen3.5:9b`，调用耗时 10~20s（GPU 推理），不是快操作
- **模型意见要核对代码再采纳**：它可能看错细节（如把 14px 圆角说成偏小）。模型说的"突兀感"要能在 CSS 里找到对应事实，找不到就不盲从
- 临时文件放 `scripts/shots/`（已 gitignore），不污染仓库
- 图片格式无所谓（Ollama 直接收原始字节），JPEG/PNG 都行，无需先转格式

## 相关文件

- `packages/server/src/ui-review.ts` — 视觉评审脚本（就是本 skill 的一键命令）
- `packages/server/src/llm/ollama.ts` — Ollama 适配器，`toOllamaImage()` 剥前缀
- `scripts/ui-screenshot.mjs` — Playwright 自动截图（需 :5173 起着）
- `packages/web/src/components/ChatPanel.vue` — 前端输入框图片能力
