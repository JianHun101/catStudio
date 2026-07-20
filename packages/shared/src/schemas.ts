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
})

export const AgentCreateSchema = AgentConfigSchema.omit({ id: true })

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
  taskId: z.string().optional(),
})

// ─── Embedding Config ───────────────────────────────

export const EmbeddingConfigSchema = z.object({
  provider: z.string(),
  model: z.string(),
  apiKey: z.string(),
  baseUrl: z.string().optional(),
})
