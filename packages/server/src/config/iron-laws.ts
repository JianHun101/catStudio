/**
 * 铁律单一权威访问器（运行期注入的全局策略）。
 *
 * 设计：铁律从「seed 期烘焙」升级为「运行期注入」——settings 表优先，
 * 缺省回退 seed-data.ts 的两个常量（IRON_LAWS_CODER/IRON_LAWS_REVIEWER）。
 * 这是通用挂载点：任何全局运营规则都能塞 settings 表、走同一访问器，
 * 不再动 seed 或主链路。编辑后下一轮回复立即生效（无需重启、无需重跑 seed）。
 */
import { IRON_LAWS_CODER, IRON_LAWS_REVIEWER } from '../seed-data.js'
import { settings as settingsRepo } from '../db/repository/index.js'

const KEY_CODER = 'iron_laws_coder'
const KEY_REVIEWER = 'iron_laws_reviewer'

export interface IronLaws {
  coder: string
  reviewer: string
}

/** 读生效铁律——settings 优先、常量兜底（POST 校验通过后由 writeIronLaws 落 settings） */
export function getIronLaws(): IronLaws {
  return {
    coder: settingsRepo.getSetting(KEY_CODER) ?? IRON_LAWS_CODER,
    reviewer: settingsRepo.getSetting(KEY_REVIEWER) ?? IRON_LAWS_REVIEWER,
  }
}

/** 写铁律——upsert settings 两键（幂等，覆盖旧值） */
export function writeIronLaws(coder: string, reviewer: string): void {
  settingsRepo.setSetting(KEY_CODER, coder)
  settingsRepo.setSetting(KEY_REVIEWER, reviewer)
}

/**
 * 按 role 取应注入的铁律——运行期注入点（runAgentReply）消费。
 * 映射必须与 seed 现状严格一致：reviewer→审查铁律；store/implementer→开发铁律；
 * 其余（vision/unknown 等）→'' 不注入（图测猫与 UI 新建猫当前无铁律，不得引入行为变化）。
 */
export function ironLawForRole(role: string | undefined): string {
  if (role === 'reviewer') return getIronLaws().reviewer
  if (role === 'store' || role === 'implementer') return getIronLaws().coder
  return ''
}
