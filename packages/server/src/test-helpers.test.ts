/**
 * `test-helpers` 的**端口判据**测试（其余部分由各消费方间接覆盖）。
 *
 * 重点不在「能起服务」，而在**判据有分辨力**：本票修的是「服务在听、`fetch` 却永久连不上」
 * 这类静默失败。若判据恒 `true`（catch 写反 / 比对了一份过期的黑名单），重取循环就变成空转，
 * 而所有测试照旧全绿 —— 那正是本仓栽过的恒真绿门。故此处三条对照缺一不可：
 * 黑名单端口 ⇒ `false`、正常端口 ⇒ `true`、关掉后同端口 ⇒ `false`。
 */

import { describe, it, expect } from 'vitest'
import { createServer, type Server } from 'node:http'
import {
  closeServer,
  isFetchReachable,
  listenFetchable,
  withFetchablePort,
} from './test-helpers.js'

/** WHATWG Fetch 禁用端口黑名单里的候选（本机端口池 1024–15000 与之交叠，故 `listen(0)` 抽得中） */
const BLACKLISTED = [1719, 3659, 4190, 6000, 6666, 10080]

/** 在指定端口起一个最简单的服务；端口被占 ⇒ null（由调用方断言，不静默跳过） */
async function bindOn(port: number): Promise<Server | null> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
    return server
  } catch {
    return null
  }
}

describe('isFetchReachable', () => {
  it('服务真在监听、但端口在黑名单 ⇒ false（本票根因的判别面）', async () => {
    let bound: Server | null = null
    let port = 0
    for (const candidate of BLACKLISTED) {
      const s = await bindOn(candidate)
      if (s) {
        bound = s
        port = candidate
        break
      }
    }
    if (bound === null) {
      throw new Error(
        `黑名单候选端口全被占用（试过 ${BLACKLISTED.join(' / ')}）——本票的承重判据无法验证，不静默跳过`
      )
    }

    // 先证「服务确实在听」：否则下面的 false 可能只是「什么都没连上」，判据就没有分辨力
    expect(bound.listening).toBe(true)
    expect(await isFetchReachable('127.0.0.1', port)).toBe(false)

    await closeServer(bound)
  })

  it('同一份代码、同一种「服务在听」：端口不在黑名单 ⇒ true（正控）', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    const port = await listenFetchable(server)
    expect(await isFetchReachable('127.0.0.1', port)).toBe(true)

    // 反控（防恒真）：关掉后同一端口必须转 false —— 端口没被拒，只是没人听
    await closeServer(server)
    expect(await isFetchReachable('127.0.0.1', port)).toBe(false)
  })
})

describe('withFetchablePort（重取分支）', () => {
  it('判据说不可触达 ⇒ 关掉当前端口、换一个重来', async () => {
    const bound: number[] = []
    const released: number[] = []
    let n = 0

    const port = await withFetchablePort(
      async () => {
        const p = 41000 + n++
        bound.push(p)
        return p
      },
      async () => {
        released.push(bound[bound.length - 1])
      },
      async (p) => p !== 41000 // 第一个判为不可触达
    )

    expect(port).toBe(41001)
    expect(released).toEqual([41000]) // 命中那个真被关掉了（不关就再 listen 会 EADDRINUSE）
  })

  it('连续不可触达 ⇒ 抛错，不静默返回一个坏端口', async () => {
    let calls = 0
    await expect(
      withFetchablePort(
        async () => {
          calls++
          return 42000
        },
        async () => {},
        async () => false,
        3
      )
    ).rejects.toThrow(/都不可被 fetch 触达/)
    expect(calls).toBe(3)
  })
})
