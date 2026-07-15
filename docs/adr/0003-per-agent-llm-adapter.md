# ADR 0003: 每 Agent 独立 LLM 适配器

> **实现现状**：适配器接口实际为 `chatStream(messages: LLMMessage[], options: ChatOptions): AsyncIterable<Chunk>`（非 `chat` / `Message[]`），增加了 `readonly provider` 属性。`custom` provider 类型在 TypeScript 中定义但注册表未实现，运行时抛出 `Unsupported LLM provider`。Embedding 实际为本地 Transformers.js 模型（非外部 API），详见 ADR 0006。

每个 Agent 独立配置 LLM 供应商（DeepSeek / Claude / GPT）和 API key。同一 Session 内不同 Agent 可用不同供应商——店长用 DeepSeek，吐槽猫用 Claude。采用适配器接口统一抽象：

```ts
interface LLMAdapter {
  chat(messages: Message[], options: ChatOptions): AsyncIterable<Chunk>
}
```

## Considered Options

- **全局单一供应商**：所有 Agent 共用一个 API key。简单但不灵活——无法混合使用不同模型优势，且一个 key 的速率限制拖累所有 Agent。
- **按 Session 配置**：每个 Session 一个供应商。折中但不够——同一 Session 内 Agent 无法差异化。
- **每 Agent 独立配置**（选中）：最大灵活性。代价是配置复杂度——每个 Agent 需单独设 key，但对你"个人使用"场景完全可接受。

## Consequences

- 前端 Agent 配置 UI 需暴露供应商选择器、API key 输入、model 名称输入——这些字段不能简化。
- Embedding 供应商与 LLM 解耦——全局独立配置，不是每 Agent 级别。不同供应商的 embedding 维度不同（DeepSeek 4096 vs OpenAI 1536），统一维度确保记忆库跨 Agent 可检索。
