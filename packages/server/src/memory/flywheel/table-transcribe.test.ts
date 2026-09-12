import { describe, expect, it } from 'vitest'
import {
  isTableSeparatorRow,
  transcribeTableBlock,
  transcribeTableBlockDetailed,
} from './table-transcribe.js'

/** 票丙 A1 / A2：转写五规则 + 异常面 */

describe('transcribeTableBlock · A1 五规则', () => {
  const table = [
    '| 项 | 值 | 备注 |',
    '| --- | :---: | ---: |',
    '| 甲 | 1 | 说明 |',
    '| 乙 |   | 无备注 |',
  ].join('\n')

  it('规则① 分隔行丢弃：任何 `---` 形态都不出现在输出里', () => {
    const out = transcribeTableBlock(table)
    expect(out).toHaveLength(2)
    for (const line of out) {
      expect(line).not.toContain('---')
      expect(line).not.toMatch(/:\s*$/)
    }
  })

  it('规则② 空单元格 ⇒ 该项整条不输出（不留悬空的「列名：」）', () => {
    const out = transcribeTableBlock(table)
    // 第 2 数据行「值」列为空 ⇒ 只出「项：乙；备注：无备注」
    expect(out[1]).toBe('项：乙；备注：无备注')
    expect(out[1]).not.toContain('值：')
    expect(out.join('\n')).not.toMatch(/值：\s*(；|$)/m)
  })

  it('规则③ 转义还原：`\\|` → `|`；`<br>` 与真换行 → 空格', () => {
    const block = ['| 列 | 内容 |', '| --- | --- |', '| a\\|b | x<br>y |'].join('\n')
    const out = transcribeTableBlock(block)
    expect(out).toEqual(['列：a|b；内容：x y'])
    expect(out[0]).not.toContain('\\|')
    expect(out[0]).not.toContain('<br>')
  })

  it('规则③ 变体：`<BR/>` / `<br />` 一律还原为空格', () => {
    const block = ['| 列 | 内容 |', '| --- | --- |', '| a | p<BR/>q |', '| b | r<br />s |'].join(
      '\n'
    )
    expect(transcribeTableBlock(block)).toEqual(['列：a；内容：p q', '列：b；内容：r s'])
  })

  it('规则④ 列名取自表头**同列**：列序错位会被本断言抓住', () => {
    const block = ['| 甲列 | 乙列 | 丙列 |', '| --- | --- | --- |', '| 1 | 2 | 3 |'].join('\n')
    expect(transcribeTableBlock(block)).toEqual(['甲列：1；乙列：2；丙列：3'])
  })

  it('规则⑤ 永不输出标题行：输出里不含任何 `#` 标题形态', () => {
    const block = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n')
    const out = transcribeTableBlock(block)
    expect(out.join('\n')).not.toMatch(/^\s*#+\s/m)
    expect(out.join('\n')).not.toContain('#')
  })

  it('多行表格：每数据行一条输出，顺序与原文一致', () => {
    const block = ['| 名称 | 值 |', '| --- | --- |', '| A | 1 |', '| B | 2 |', '| C | 3 |'].join(
      '\n'
    )
    expect(transcribeTableBlock(block)).toEqual([
      '名称：A；值：1',
      '名称：B；值：2',
      '名称：C；值：3',
    ])
  })

  it('前后有空白 / 无外框竖线的表也认得出', () => {
    const block = ['', '  项 | 值  ', ' --- | --- ', ' 甲 | 1 ', '', ''].join('\n')
    expect(transcribeTableBlock(block)).toEqual(['项：甲；值：1'])
  })

  it('prefix 非空 ⇒ 每行带 `【prefix】` 前缀（同节多表的区分手段）', () => {
    const block = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n')
    expect(transcribeTableBlock(block, { prefix: '表前那句散文' })).toEqual([
      '【表前那句散文】a：1；b：2',
    ])
    expect(transcribeTableBlock(block, { prefix: '' })).toEqual(['a：1；b：2'])
  })

  it('整行皆空 ⇒ 不出行（无内容可索引，且不留空串）', () => {
    const block = ['| a | b |', '| --- | --- |', '|  |  |'].join('\n')
    expect(transcribeTableBlock(block)).toEqual([])
  })
})

describe('transcribeTableBlock · A2 异常面', () => {
  it('列多于表头 ⇒ 多出的值丢弃 + 计一次告警（不得静默错位）', () => {
    const block = ['| 项 | 值 |', '| --- | --- |', '| 甲 | 1 | 多出来的 | 还有 |'].join('\n')
    const { lines, warnings } = transcribeTableBlockDetailed(block)

    // 多出的值被丢弃：只剩两列，且**没有**错位（错位会把「多出来的」塞进「值」列）
    expect(lines).toEqual(['项：甲；值：1'])
    expect(lines[0]).not.toContain('多出来的')
    // 告警痕迹：结构化字段，含行号与列数
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toEqual({
      kind: 'extra-cells',
      row: 3,
      headerColumns: 2,
      actualColumns: 4,
    })
  })

  it('列数正常 ⇒ 零告警', () => {
    const block = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n')
    expect(transcribeTableBlockDetailed(block).warnings).toEqual([])
  })

  it('非表格输入（无分隔行）⇒ 原样返回该块的非空行，不 throw', () => {
    const block = ['普通段落一行', '', '  ', '第二行', ''].join('\n')
    expect(() => transcribeTableBlock(block)).not.toThrow()
    expect(transcribeTableBlock(block)).toEqual(['普通段落一行', '第二行'])
  })

  it('空串 / 只有空白 ⇒ 不 throw，返回空数组', () => {
    expect(transcribeTableBlock('')).toEqual([])
    expect(transcribeTableBlock('\n\n   \n')).toEqual([])
  })

  it('表头单元格为空 ⇒ 该列拼不出「列名：值」，整列跳过（不产生悬空「：值」）', () => {
    const block = ['| a |  | c |', '| --- | --- | --- |', '| 1 | 2 | 3 |'].join('\n')
    const out = transcribeTableBlock(block)
    expect(out).toEqual(['a：1；c：3'])
    expect(out[0]).not.toMatch(/：2/)
  })

  it('分隔行判据：真分隔行认得出，数据行 / 普通行认不出', () => {
    expect(isTableSeparatorRow('| --- | :---: | ---: |')).toBe(true)
    expect(isTableSeparatorRow('| a | b |')).toBe(false)
    expect(isTableSeparatorRow('|---|')).toBe(true) // 单列分隔行
    expect(isTableSeparatorRow('普通一行')).toBe(false)
    // 无竖线 ⇒ 不是表格分隔行（`---` 在 MD 里是分隔线，不是表格）
    expect(isTableSeparatorRow('---')).toBe(false)
  })
})
