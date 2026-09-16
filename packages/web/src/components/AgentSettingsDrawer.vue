<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import type { AgentConfig } from '@cat-study/shared'
import { useChatStore } from '@/stores/chat'

/**
 * 猫咪设置抽屉（R4 屏③）——从右边缘滑出 360px，改完立刻在右侧面板看到效果
 * （形态参考 docs/run/eval-system/prototypes/R3-right-panel-v2.html 屏③，照形态不照代码）。
 *
 * ⚠️ 字段与分组**逐项对齐 AgentEditModal.vue**（同一批配置项，未新造字段）。
 *
 * 为什么是两份表单而不是抽一层共用的「表单体」：AgentEditModal.test.ts 是跨
 * script + template 的 `?raw` 静态断言（providerOptions / validateRuntimeConfig /
 * template 的 v-model 都在扫描面内），把表单体抽走会让那批断言直接红——而票面把
 * 「其既有测试零修改全绿」钉成了硬约束。代价是两份拷贝会漂移，故由
 * AgentSettingsDrawer.test.ts 的**对拍护栏**兜住：label 集合 / 分组标题集合 /
 * provider 选项值集合 / 保存 payload 键，任一侧改漏一处即红。
 */
const props = defineProps<{ agent: AgentConfig | null }>()
const emit = defineEmits(['close'])

const store = useChatStore()

const name = ref('')
const avatar = ref('🐱')
const systemPrompt = ref('')
const llmProvider = ref('claude')
const llmModel = ref('deepseek-v4-pro')
const llmApiKey = ref('')
const llmBaseUrl = ref('')
const llmEffortLevel = ref('high')
/** 静态运行配置（单 A 契约：maxTokens 正整数 1..131072、temperature 0..2——DB 列默认 2048/0.7） */
const llmMaxTokens = ref(2048)
const llmTemperature = ref(0.7)
/** 额外环境变量（JSON 字符串直存；仅 opencode 等 spawn CLI 的适配器消费，DB 列默认 '{}'） */
const llmEnvExtra = ref('{}')
const saving = ref(false)
const error = ref('')

watch(
  () => props.agent,
  (a) => {
    if (a) {
      name.value = a.name
      avatar.value = a.avatar
      systemPrompt.value = a.systemPrompt
      llmProvider.value = a.llmProvider
      llmModel.value = a.llmModel
      llmApiKey.value = a.llmApiKey
      llmBaseUrl.value = a.llmBaseUrl || ''
      llmEffortLevel.value = a.effortLevel || 'high'
      // 这三个字段 `AgentConfig` 里已有定义（`llmMaxTokens?` / `llmTemperature?` / `llmEnvExtra?`），
      // 故直接访问——**不照抄 AgentEditModal 的 `(a as any)`**：那边是单 A 落地前的过渡写法，
      // 其注释「类型无定义」如今已不成立，但它的 `?raw` 断言钉着那个字面量，改不动。
      llmMaxTokens.value = a.llmMaxTokens ?? 2048
      llmTemperature.value = a.llmTemperature ?? 0.7
      llmEnvExtra.value = a.llmEnvExtra ?? '{}'
      error.value = ''
    }
  },
  { immediate: true }
)

/** 供应商选项 + 提示：与 AgentEditModal 逐项对齐（对拍护栏覆盖值集合） */
const providerOptions = [
  { value: 'deepseek', label: 'DeepSeek (HTTP API)' },
  { value: 'claude', label: 'Claude Code (CLI)' },
  { value: 'opencode', label: 'OpenCode (CLI)' },
  { value: 'dsh', label: 'DeepSeek Harness (CLI)' },
  { value: 'ollama', label: 'ollama' },
  { value: 'openai', label: 'Codex (CLI)' },
  { value: 'pi', label: 'Pi (SDK)' },
  { value: 'custom', label: '自定义' },
]

const providerHint = computed(() => {
  switch (llmProvider.value) {
    case 'claude':
      return '需要安装 Claude Code CLI: npm i -g @anthropic-ai/claude-code。Base URL 留空 = DeepSeek，填 https://api.moonshot.ai/anthropic = Kimi K3'
    case 'opencode':
      return '需要安装 opencode CLI 并 opencode auth login；本地认证无需填 key；模型填 provider/model 格式（如 deepseek/deepseek-v4-pro）'
    case 'dsh':
      return '需要安装 dsh CLI: npm i -g @deepseek-ai/dsh@0.1.0-rc.6；本地 credentials 落盘认证，key 可留空（填了则复用 DS_KEY 注入，留空走 dsh 本地 credentials 兜底）；模型填 deepseek-chat'
    case 'ollama':
      return '本地 Ollama 服务，key 可留空；模型填已拉取模型名（如 qwen3.5:9b）；Base URL 默认 http://127.0.0.1:11434'
    case 'openai':
      return '需要安装 Codex CLI (npm i -g @openai/codex) 和 codex-proxy'
    case 'pi':
      return '需要安装 pi-coding-agent: npm i @earendil-works/pi-coding-agent'
    case 'custom':
      return '自定义 API 端点，需兼容 OpenAI Chat Completions 格式'
    default:
      return ''
  }
})

const avatarOptions = [
  '🐱',
  '😺',
  '😼',
  '😻',
  '😾',
  '😿',
  '🙀',
  '🐈',
  '🦁',
  '🐯',
  '🐶',
  '🐰',
  '🐼',
  '🦊',
  '🐮',
]

const effortOptions = [
  { value: 'low', label: 'Low (最低推理深度)' },
  { value: 'medium', label: 'Medium (中等)' },
  { value: 'high', label: 'High (较高推理深度)' },
  { value: 'max', label: 'Max (最高推理深度)' },
]

/** 抽屉头副标题：全部取自 agent 已有字段，不新造 */
const subtitle = computed(() => {
  const a = props.agent
  if (!a) return ''
  const parts = [a.role, `${a.llmProvider} / ${a.llmModel}`, `effort ${a.effortLevel || 'high'}`]
  return parts.filter(Boolean).join(' · ')
})

/** 前端校验对齐单 A 契约（maxTokens 正整数 1..131072、temperature 0..2）——不通过不发请求，后端 400 兜底 */
function validateRuntimeConfig(): boolean {
  const maxTokens = Number(llmMaxTokens.value)
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 131072) {
    error.value = 'Max Tokens 必须是 1~131072 的整数（如 2048）'
    return false
  }
  const temp = Number(llmTemperature.value)
  if (!Number.isFinite(temp) || temp < 0 || temp > 2) {
    error.value = '温度必须是 0~2 之间的小数（如 0.7）'
    return false
  }
  return true
}

async function handleSave(): Promise<void> {
  if (!props.agent) return
  if (!validateRuntimeConfig()) return
  saving.value = true
  error.value = ''
  try {
    await store.updateAgent(props.agent.id, {
      name: name.value,
      avatar: avatar.value,
      systemPrompt: systemPrompt.value,
      llmProvider: llmProvider.value,
      llmModel: llmModel.value,
      llmApiKey: llmApiKey.value,
      llmBaseUrl: llmBaseUrl.value,
      effortLevel: llmEffortLevel.value,
      llmMaxTokens: Number(llmMaxTokens.value),
      llmTemperature: Number(llmTemperature.value),
      llmEnvExtra: llmEnvExtra.value,
    })
    emit('close')
  } catch (err: any) {
    error.value = err.message || '保存失败'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-if="agent" class="drawer-overlay" @click.self="emit('close')">
    <aside class="drawer" role="dialog" aria-modal="true" aria-label="猫咪设置">
      <div class="drawer-head">
        <span class="drawer-avatar">{{ agent.avatar }}</span>
        <div class="drawer-headtext">
          <div class="drawer-title">{{ agent.name }}</div>
          <div class="drawer-sub">{{ subtitle }}</div>
        </div>
        <button class="btn-close" aria-label="关闭" @click="emit('close')">✕</button>
      </div>

      <div class="drawer-body">
        <!-- 基本（无分组标题——与 AgentEditModal 逐项对齐：它的名字/头像直接位于表单顶部，
             分组标题只有「LLM 配置」「角色设定」两级。对拍护栏盯着这个集合） -->
        <div class="form-row">
          <div class="form-group flex-1">
            <label>名字</label>
            <input v-model="name" type="text" class="input" />
          </div>
          <div class="form-group avatar-col">
            <label>头像</label>
            <div class="avatar-picker">
              <button
                v-for="a in avatarOptions"
                :key="a"
                class="avatar-option"
                :class="{ selected: avatar === a }"
                @click="avatar = a"
              >
                {{ a }}
              </button>
            </div>
            <input v-model="avatar" type="text" class="input input-sm" />
          </div>
        </div>

        <!-- LLM 配置 -->
        <div class="form-section-title">LLM 配置</div>

        <div class="form-row">
          <div class="form-group flex-1">
            <label>供应商</label>
            <select v-model="llmProvider" class="input">
              <option v-for="p in providerOptions" :key="p.value" :value="p.value">
                {{ p.label }}
              </option>
            </select>
            <p v-if="providerHint" class="provider-hint">{{ providerHint }}</p>
          </div>
          <div class="form-group flex-1">
            <label>模型</label>
            <input v-model="llmModel" type="text" class="input" placeholder="deepseek-v4-pro" />
          </div>
        </div>

        <div v-if="llmProvider === 'claude'" class="form-group">
          <label>推理深度 (Effort)</label>
          <select v-model="llmEffortLevel" class="input">
            <option v-for="opt in effortOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
          <p class="provider-hint">
            控制 Claude Code 的推理 token 预算。High 适用于大多数场景，Max 推理最深入但耗时最长。
          </p>
        </div>

        <div class="form-row">
          <div class="form-group flex-1">
            <label>Max Tokens（单次输出上限）</label>
            <input
              v-model.number="llmMaxTokens"
              type="number"
              min="1"
              max="131072"
              step="1"
              class="input input-mono"
            />
            <p class="provider-hint">
              每次调用的最大输出 token 数（1~131072 整数）。与上下文窗口上限 （系统配置页
              maxContextTokens）是两个数字体系——这是单次回复上限。
            </p>
          </div>
          <div class="form-group flex-1">
            <label>温度 (Temperature)</label>
            <input
              v-model.number="llmTemperature"
              type="number"
              min="0"
              max="2"
              step="0.1"
              class="input input-mono"
            />
            <p class="provider-hint">采样温度（0~2）。越低越确定，越高越发散；默认 0.7。</p>
          </div>
        </div>

        <div class="form-group">
          <label>API Key</label>
          <input v-model="llmApiKey" type="password" class="input input-mono" placeholder="sk-…" />
        </div>

        <div v-if="llmProvider === 'custom' || llmProvider === 'claude'" class="form-group">
          <label>Base URL</label>
          <input
            v-model="llmBaseUrl"
            type="text"
            class="input input-mono"
            :placeholder="
              llmProvider === 'claude'
                ? '留空 = DeepSeek；https://api.moonshot.ai/anthropic = Kimi K3'
                : 'https://api.example.com'
            "
          />
        </div>

        <div class="form-group">
          <label>额外环境变量 (JSON)</label>
          <textarea
            v-model="llmEnvExtra"
            class="input input-mono textarea-env"
            rows="2"
            spellcheck="false"
            placeholder='{"HTTPS_PROXY":"http://127.0.0.1:7897","NO_PROXY":"localhost,127.0.0.1"}'
          ></textarea>
          <p class="provider-hint">
            仅 opencode/CLI 适配器生效（HTTP 适配器不读代理 env），留空 {} 不注入
          </p>
        </div>

        <!-- System Prompt -->
        <div class="form-section-title">角色设定 (System Prompt)</div>
        <div class="form-group">
          <textarea
            v-model="systemPrompt"
            class="input textarea-lg"
            rows="10"
            placeholder="描述这个 Agent 的角色、性格、说话风格…"
          ></textarea>
        </div>

        <div v-if="error" class="error-msg">{{ error }}</div>
      </div>

      <div class="drawer-foot">
        <button class="btn btn-cancel" @click="emit('close')">取消</button>
        <button class="btn btn-ok" :disabled="saving" @click="handleSave">
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>
    </aside>
  </div>
</template>

<style scoped>
/* 抽屉：右边缘滑出 360px，盖住面板右半——面板本体保留在左侧可见（改完立刻看效果） */
.drawer-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  z-index: 1000;
  display: flex;
  justify-content: flex-end;
}

.drawer {
  width: 360px;
  max-width: 92vw;
  height: 100%;
  background: var(--bg-raised);
  border-left: 1px solid var(--border-default);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: -8px 0 30px rgba(0, 0, 0, 0.35);
  animation: drawer-in 0.18s var(--ease-out);
}

@keyframes drawer-in {
  from {
    transform: translateX(24px);
    opacity: 0.4;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

.drawer-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-surface);
}

.drawer-avatar {
  font-size: 22px;
  line-height: 1;
}

.drawer-headtext {
  flex: 1;
  min-width: 0;
}

.drawer-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drawer-sub {
  font-size: 10px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 1px;
}

.btn-close {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  transition: all var(--ease-out);
}

.btn-close:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px;
}

.form-section-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  margin: 16px 0 10px;
  padding-top: 12px;
  border-top: 1px solid var(--border-subtle);
}

.form-section-title:first-of-type {
  border-top: none;
  margin-top: 0;
  padding-top: 0;
}

.form-row {
  display: flex;
  gap: 12px;
}

.form-group {
  margin-bottom: 12px;
}

.flex-1 {
  flex: 1;
  min-width: 0;
}

.avatar-col {
  width: 150px;
  flex-shrink: 0;
}

.form-group label {
  display: block;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.4px;
  margin-bottom: 5px;
}

.input {
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-primary);
  font-size: 12px;
  font-family: inherit;
  outline: none;
  transition: border-color var(--ease-out);
}

.input:focus {
  border-color: var(--accent);
}

.input-mono {
  font-family: var(--font-mono);
  font-size: 11px;
}

.input-sm {
  margin-top: 6px;
  font-size: 13px;
}

.textarea-lg {
  resize: vertical;
  font-size: 12px;
  line-height: 1.6;
  font-family: inherit;
}

.textarea-env {
  resize: vertical;
  min-height: 42px;
  font-size: 11px;
  line-height: 1.5;
}

select.input {
  cursor: pointer;
}

.provider-hint {
  font-size: 10px;
  color: var(--accent-text);
  margin-top: 5px;
  padding: 5px 8px;
  background: var(--accent-tint);
  border: 1px solid var(--accent-hint-border);
  border-radius: var(--radius-sm);
  line-height: 1.5;
}

.avatar-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.avatar-option {
  width: 26px;
  height: 26px;
  font-size: 15px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--ease-out);
}

.avatar-option:hover {
  border-color: var(--accent-text);
}

.avatar-option.selected {
  border-color: var(--accent-text);
  background: var(--accent-soft);
}

.drawer-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border-subtle);
}

.btn {
  padding: 7px 18px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--ease-out);
}

.btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.btn-cancel {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.btn-cancel:hover:not(:disabled) {
  color: var(--text-primary);
}

.btn-ok {
  background: var(--accent);
  color: var(--text-on-accent);
  font-weight: 600;
}

.btn-ok:hover:not(:disabled) {
  background: var(--accent-hover);
}

.error-msg {
  background: rgba(224, 85, 106, 0.1);
  color: var(--accent-red);
  padding: 8px 11px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  border: 1px solid rgba(224, 85, 106, 0.2);
}
</style>
