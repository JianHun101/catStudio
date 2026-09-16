/**
 * `utils.ts` — `messageOf`（R5 §B 诊断取值单源）单元测试。
 *
 * 被测性质三条：① Error 路径逐字零回归；② 非 Error 抛出物落出可辨识信息（不再
 * `undefined` / `'[object Object]'`）；③ **本函数不抛**——它是 `finally` 槽位收口
 * 路径上的取值器，抛错会把一次失败升级成槽位永久卡死。
 */

import { describe, it, expect } from 'vitest'
import { messageOf } from './utils.js'

describe('messageOf · 诊断取值单源', () => {
  describe('空值与空串', () => {
    it('null / undefined → undefined（调用方兜底词接管）', () => {
      expect(messageOf(null)).toBeUndefined()
      expect(messageOf(undefined)).toBeUndefined()
    })

    it('空串 → undefined（不是空串本身——空串与「取不出信息」不可区分）', () => {
      expect(messageOf('')).toBeUndefined()
    })
  })

  describe('Error 路径零回归', () => {
    it('Error → `message` 原样', () => {
      expect(messageOf(new Error('boom-error'))).toBe('boom-error')
    })

    it('Error 子类 → 同样取 `message`', () => {
      class Boom extends Error {}
      expect(messageOf(new Boom('子类'))).toBe('子类')
    })

    it('`Error("")` → 原样返回空串（**不得**被兜底吞掉——票面「Error 路径 message 原样」）', () => {
      expect(messageOf(new Error(''))).toBe('')
    })
  })

  describe('非 Error 抛出物（本票靶心）', () => {
    it('字符串 → 原样（修复前落 `undefined`）', () => {
      expect(messageOf('boom-string')).toBe('boom-string')
    })

    it('数字 / 布尔 / bigint → `String()` 形态', () => {
      expect(messageOf(42)).toBe('42')
      expect(messageOf(false)).toBe('false')
      expect(messageOf(10n)).toBe('10')
    })

    it('Symbol → `String()` 形态（模板字面量会抛，`String()` 不会）', () => {
      expect(messageOf(Symbol('sym'))).toBe('Symbol(sym)')
    })

    it('普通对象 → JSON（**不是** `[object Object]`，后者信息量为零）', () => {
      const got = messageOf({ code: 42 })
      expect(got).toBe('{"code":42}')
      expect(got).not.toBe('[object Object]')
    })

    it('嵌套对象 → JSON 保留结构', () => {
      expect(messageOf({ err: { code: 42, kind: 'x' } })).toBe('{"err":{"code":42,"kind":"x"}}')
    })

    it('数组走 `String()`（`1,2` —— 与 `err.message` 同形，非本票新增语义）', () => {
      expect(messageOf([1, 2])).toBe('1,2')
    })
  })

  describe('取不出信息 → undefined（不抛、不落零信息值）', () => {
    it('空对象 `{}` → undefined（JSON 得 `{}`，同样零信息）', () => {
      expect(messageOf({})).toBeUndefined()
    })

    it('循环引用对象 → undefined，**不抛**', () => {
      const a: Record<string, unknown> = { k: 1 }
      a.self = a
      expect(() => messageOf(a)).not.toThrow()
      expect(messageOf(a)).toBeUndefined()
    })

    it('无原型对象 → undefined（`String()` 抛，JSON 得 `{}`），**不抛**', () => {
      const bare = Object.create(null) as object
      expect(() => messageOf(bare)).not.toThrow()
      expect(messageOf(bare)).toBeUndefined()
    })

    it('`toString` 自身抛错 → 不走 `String()`，仍由 JSON 落出信息', () => {
      const o = {
        a: 1,
        toString() {
          throw new Error('toString 炸了')
        },
      }
      expect(() => messageOf(o)).not.toThrow()
      expect(messageOf(o)).toBe('{"a":1}')
    })

    it('`toJSON` 自身抛错 → undefined，**不抛**', () => {
      const o = {
        toJSON() {
          throw new Error('toJSON 炸了')
        },
      }
      expect(() => messageOf(o)).not.toThrow()
      expect(messageOf(o)).toBeUndefined()
    })

    it('函数 → `String()` 得源码（非空 ⇒ 有信息量，原样返回）', () => {
      const got = messageOf(function named() {})
      expect(got).toContain('function')
    })
  })

  describe('总性质：任何输入都不抛', () => {
    it('一组刁钻输入逐一过——全部不抛', () => {
      const circular: Record<string, unknown> = {}
      circular.self = circular
      const trap = new Proxy(
        {},
        {
          get() {
            throw new Error('proxy trap 炸了')
          },
        }
      )
      const inputs: unknown[] = [
        null,
        undefined,
        '',
        'x',
        0,
        -0,
        NaN,
        Infinity,
        false,
        10n,
        Symbol('s'),
        {},
        [],
        [1],
        () => {},
        circular,
        Object.create(null),
        trap,
        new Error('e'),
        new Date(0),
        new Map(),
      ]
      // 标签用下标而非 `String(input)`——本用例里就有「`String()` 自身会抛」的输入，
      // 拿它拼断言消息会先于被测函数炸（这正是被测性质本身）
      for (const [i, input] of inputs.entries()) {
        expect(() => messageOf(input), `inputs[${i}] 不该抛`).not.toThrow()
      }
    })
  })
})
