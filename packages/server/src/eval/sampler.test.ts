/**
 * sampler.test.ts — 采样器单测。mock scorer（LLM 边界），验证采样门控与 fire-and-forget。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getSampleRate, maybeScoreSample } from './sampler.js'

vi.mock('./scorer.js', () => ({
  scoreReply: vi.fn().mockResolvedValue(null),
}))

import { scoreReply } from './scorer.js'

const DS_AGENT = {
  id: 'agent-1',
  name: '实施猫',
  avatar: '🐱',
  systemPrompt: '',
  llmProvider: 'deepseek',
  llmModel: 'deepseek-v4-flash',
  llmApiKey: 'sk-test',
}

// 生产主猫形态：llmProvider='opencode'，opencode-go/deepseek-v4-flash 经 opencode
// 适配器跑 Go 订阅（切 Go 后线上 DB 的真实配置）。采样门按模型名过滤（includes），
// 此形态必须采样（M1 回归测试）
const PROD_AGENT = {
  ...DS_AGENT,
  id: 'agent-prod',
  llmProvider: 'opencode',
  llmModel: 'opencode-go/deepseek-v4-flash',
  llmApiKey: '',
}
// 旧生产主猫形态（切 Go 前：claude 适配器直连 deepseek-v4-flash）——回滚路径仍在，
// includes 判定下仍须采样（回归护栏：换 provider 前缀不能把 DS 族猫误杀）
const LEGACY_CLAUDE_AGENT = { ...DS_AGENT, id: 'agent-legacy', llmProvider: 'claude' }
const OLLAMA_AGENT = {
  ...DS_AGENT,
  id: 'agent-ollama',
  llmProvider: 'ollama',
  llmModel: 'qwen3.5:9b',
}
const EXTERNAL_AGENT = { ...DS_AGENT, id: 'agent-ext', llmProvider: 'openai', llmModel: 'gpt-4o' }

beforeEach(() => {
  process.env.EVAL_SAMPLE_RATE = '0.02'
  vi.clearAllMocks()
})

afterEach(() => {
  delete process.env.EVAL_SAMPLE_RATE
})

describe('getSampleRate', () => {
  it('默认 0.02（契约 1-5% 区间内）', () => {
    delete process.env.EVAL_SAMPLE_RATE
    expect(getSampleRate()).toBe(0.02)
  })

  it('env 覆盖生效', () => {
    process.env.EVAL_SAMPLE_RATE = '0.05'
    expect(getSampleRate()).toBe(0.05)
  })

  it('超过 5% 封顶 0.05', () => {
    process.env.EVAL_SAMPLE_RATE = '0.9'
    expect(getSampleRate()).toBe(0.05)
  })

  it('低于 1% 抬到下限 0.01（契约 1-5% 区间）', () => {
    process.env.EVAL_SAMPLE_RATE = '0.005'
    expect(getSampleRate()).toBe(0.01)
  })

  it('非正数/NaN 返回 0（不采样）', () => {
    process.env.EVAL_SAMPLE_RATE = '0'
    expect(getSampleRate()).toBe(0)
    process.env.EVAL_SAMPLE_RATE = 'abc'
    expect(getSampleRate()).toBe(0)
  })
})

describe('maybeScoreSample', () => {
  it('ollama 猫不采样，random 不被调用', () => {
    const random = vi.fn(() => 0)
    maybeScoreSample(OLLAMA_AGENT, 's-1', 'm-1', random)
    expect(random).not.toHaveBeenCalled()
    expect(scoreReply).not.toHaveBeenCalled()
  })

  it('外部族模型（gpt-4o）不采样', () => {
    const random = vi.fn(() => 0)
    maybeScoreSample(EXTERNAL_AGENT, 's-1', 'm-1', random)
    expect(random).not.toHaveBeenCalled()
    expect(scoreReply).not.toHaveBeenCalled()
  })

  it('生产主猫形态（opencode provider + opencode-go 模型前缀）→ 采样（M1 回归）', () => {
    const random = vi.fn(() => 0.001)
    maybeScoreSample(PROD_AGENT, 's-1', 'm-1', random)
    expect(scoreReply).toHaveBeenCalledWith(PROD_AGENT, 's-1', 'm-1')
  })

  it('旧 claude 直连形态（claude provider + deepseek 模型）→ 仍采样（回滚路径回归）', () => {
    const random = vi.fn(() => 0.001)
    maybeScoreSample(LEGACY_CLAUDE_AGENT, 's-1', 'm-1', random)
    expect(scoreReply).toHaveBeenCalledWith(LEGACY_CLAUDE_AGENT, 's-1', 'm-1')
  })

  it('采样率 0 时跳过', () => {
    process.env.EVAL_SAMPLE_RATE = '0'
    const random = vi.fn(() => 0)
    maybeScoreSample(DS_AGENT, 's-1', 'm-1', random)
    expect(scoreReply).not.toHaveBeenCalled()
  })

  it('随机值未命中采样率 → 不评分', () => {
    const random = vi.fn(() => 0.5) // 0.5 ≥ 0.02
    maybeScoreSample(DS_AGENT, 's-1', 'm-1', random)
    expect(scoreReply).not.toHaveBeenCalled()
  })

  it('命中采样 → 异步评分（fire-and-forget：函数同步返回）', () => {
    const random = vi.fn(() => 0.001) // < 0.02
    maybeScoreSample(DS_AGENT, 's-1', 'm-1', random)
    expect(scoreReply).toHaveBeenCalledWith(DS_AGENT, 's-1', 'm-1')
  })

  it('评分失败静默（不抛出，fire-and-forget 语义）', async () => {
    vi.mocked(scoreReply).mockRejectedValueOnce(new Error('LLM 挂了'))
    const random = vi.fn(() => 0.001)
    expect(() => maybeScoreSample(DS_AGENT, 's-1', 'm-1', random)).not.toThrow()
    await vi.waitFor(() => expect(scoreReply).toHaveBeenCalled())
  })
})
