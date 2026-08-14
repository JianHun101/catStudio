import { z } from 'zod'

// ─── Agent ──────────────────────────────────────────

export const AgentConfigSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  avatar: z.string(),
  systemPrompt: z.string(),
  llmProvider: z.string(),
  llmModel: z.string(),
  llmApiKey: z.string(),
  llmBaseUrl: z.string().optional(),
  effortLevel: z.enum(['low', 'medium', 'high', 'max']).optional(),
  // per-agent 静态运行配置：用户显式配置，严格校验（与 .env 容错哲学不同——非法值直接 400 暴露前端 bug）
  llmMaxTokens: z.number().int().min(1).max(131072).optional(),
  llmTemperature: z.number().min(0).max(2).optional(),
})

export const AgentCreateSchema = AgentConfigSchema.omit({ id: true })

// PATCH 入参：与 AgentCreate 对齐，但所有字段可缺省（partial）。llmEnvExtra 是 PATCH 独有字段
// （宽容字符串：JSON 原样落库、registry 消费时解析，无特殊校验），不在 AgentConfigSchema 中——
// 故在此 extend 而非改 AgentConfigSchema，避免 POST 行为变化。
export const AgentUpdateSchema = AgentConfigSchema.omit({ id: true }).partial().extend({
  llmEnvExtra: z.string().optional(),
})

// ─── Session ────────────────────────────────────────

export const SessionCreateSchema = z.object({
  title: z.string().min(1).max(100),
  agentIds: z.array(z.string()).min(1),
})

export const SessionUpdateSchema = z.object({
  title: z.string().min(1).max(100).optional(),
  addAgentIds: z.array(z.string()).optional(),
  removeAgentIds: z.array(z.string()).optional(),
  broadcastMode: z.boolean().optional(),
})

// ─── Message ────────────────────────────────────────

export const MessageSendSchema = z.object({
  sessionId: z.string(),
  content: z.string().min(1),
  mentions: z.array(z.string()).default([]),
  /** 用户消息附带的图片（base64 dataURL）。数量/大小上限由 server 运行时守卫执行（socketio.ts / routes/messages.ts），与 socket 路径行为一致 */
  images: z.array(z.string()).optional(),
  taskId: z.string().optional(),
})

// ─── Embedding Config ───────────────────────────────

export const EmbeddingConfigSchema = z.object({
  provider: z.string(),
  model: z.string(),
  apiKey: z.string(),
  baseUrl: z.string().optional(),
})
