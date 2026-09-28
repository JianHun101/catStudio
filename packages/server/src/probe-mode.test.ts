/**
 * probe-mode.ts 纯单元测试——**取值口径**（显式开启 vs 宽松 `!== 'false'`）。
 *
 * 承重断言是「笔误不开启」那一组：本开关误开的后果是**探针实例静默不执行**
 * （症状是「什么都没发生」），比漏开更难察觉，故判据必须是白名单而不是黑名单。
 * 反向对照（`0` / `false` / 空串 / 未设置 ⇒ 关闭）同样承重：它是「正常启动序列
 * 语义零变化」的保证面——少一条，宽松实现（`!== 'false'`）就会全绿放行。
 */

import { describe, it, expect, afterEach } from 'vitest'
import { isProbeMode, PROBE_MODE_ENV } from './probe-mode.js'

/** 逐用例复位：真删除变量（不是置空串），覆盖「未设置」这一面 */
afterEach(() => {
  delete process.env[PROBE_MODE_ENV]
})

function setRaw(value: string): void {
  process.env[PROBE_MODE_ENV] = value
}

describe('probe-mode — 显式开启口径', () => {
  it.each(['1', 'true', 'TRUE', 'True', ' true ', '\t1\n'])('开启面：%j ⇒ true', (raw) => {
    setRaw(raw)
    expect(isProbeMode()).toBe(true)
  })

  it.each(['0', 'false', 'FALSE', '', '   ', 'yes', 'on', '2', 'enabled', 'catstudy'])(
    '关闭面：%j ⇒ false（白名单之外一律关闭）',
    (raw) => {
      setRaw(raw)
      expect(isProbeMode()).toBe(false)
    }
  )

  it('未设置 ⇒ false', () => {
    delete process.env[PROBE_MODE_ENV]
    expect(isProbeMode()).toBe(false)
  })

  it('读在调用点：同一进程内改 env 即刻生效（无模块级缓存分叉）', () => {
    delete process.env[PROBE_MODE_ENV]
    expect(isProbeMode()).toBe(false)
    setRaw('1')
    expect(isProbeMode()).toBe(true)
    setRaw('0')
    expect(isProbeMode()).toBe(false)
  })

  it('变量名钉死——消费点与文档/`.env.example` 共用本常量，不许各写一份字面量', () => {
    expect(PROBE_MODE_ENV).toBe('CATSTUDY_PROBE_MODE')
  })
})
