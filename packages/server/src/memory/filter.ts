/**
 * 记忆入库筛选 — 保守 deny-list 策略。
 *
 * 默认存，只过滤高置信度的"垃圾"：
 * - 过短（应答词/寒暄）: "好"、"嗯嗯"、"早上好"、"谢谢"
 * - 纯填充: "哈哈哈哈哈"、"😄😄😄😄"、"。。。。。"
 * - 一次性指令: "帮我修一下bug"、"看看前端代码"、"写个脚本"
 *
 * 长期/偏好标记（以后/每次/不要/喜欢/习惯…）命中时无条件存储——
 * 用户显式表达的偏好与约定优先级高于指令特征，防止误杀。
 * 设计原则: 筛选错误的代价是信息永久丢失，检索噪音的代价只是偶尔跑偏，
 * 所以只做 deny-list，不做打分排序；宁可多存不可漏存。
 *
 * 环境变量:
 *   MEMORY_FILTER_ENABLED     — '0' 关闭筛选（默认 '1'）
 *   MEMORY_MIN_CONTENT_LENGTH — 最小内容长度（默认 4，按 Unicode 码点计）
 */

export type MemoryFilterReason = 'too_short' | 'filler' | 'one_time_command'

export interface MemoryFilterResult {
  store: boolean
  reason: MemoryFilterReason | null
}

/** 筛选开关 */
export function isMemoryFilterEnabled(): boolean {
  return process.env.MEMORY_FILTER_ENABLED !== '0'
}

/** 长期/偏好标记 — 命中则无条件存储（含"不要/千万别"等否定式约定） */
const STANDING_MARKERS =
  /(以后|今后|每次|总是|一直|永远|从今|务必|千万|习惯|默认|长期|平时|不要|不想|希望|想要|喜欢|讨厌|害怕|别忘|记得|记住)/

/** 请求开头 — 高置信度一次性请求 */
const REQUEST_OPENERS = /^(?:帮我|帮|请|麻烦|替我|帮忙|烦请|请您)/

/** 指令动词 + 语气后缀 — "修一下"、"看看"、"写个脚本" 等命令句式 */
const COMMAND_VERB =
  '修改加删除查看试试跑写做检查清理更新升级部署启动停止重启清空重置优化整理找搜发翻译统计汇总合并移动安装配置下载上传处理解决'
const COMMAND_PATTERN = new RegExp(
  `^(?:[${COMMAND_VERB}]{2}|(?:[${COMMAND_VERB}])(?:一下|下|个|一遍|一次|一版))`
)

/** 纯填充: emoji / 标点 / 语气词 */
const FILLER_PATTERN = /^[\p{Emoji_Presentation}\p{P}\p{S}哈嘿呵呵嗯啊哦呀噢喔哎哟唉]+$/u

/**
 * 评估清洗后的内容是否值得入库。
 * 传入的内容应为已剥离 @mention 的文本（调用方负责清洗）。
 */
export function evaluateMemoryContent(content: string): MemoryFilterResult {
  const text = content.trim()
  if (!text) return { store: false, reason: 'too_short' }

  const minLength = parseInt(process.env.MEMORY_MIN_CONTENT_LENGTH || '4', 10)
  if ([...text].length < minLength) return { store: false, reason: 'too_short' }

  // 长期/偏好标记优先——用户显式表达的约定不允许被指令特征误杀
  if (STANDING_MARKERS.test(text)) return { store: true, reason: null }

  if (FILLER_PATTERN.test(text)) return { store: false, reason: 'filler' }

  if (REQUEST_OPENERS.test(text) || COMMAND_PATTERN.test(text)) {
    return { store: false, reason: 'one_time_command' }
  }

  return { store: true, reason: null }
}
