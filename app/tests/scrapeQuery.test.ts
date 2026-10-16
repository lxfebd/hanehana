/**
 * queryLadder 清洗梯契约（2026-10-16 用真实 VNDB 逐词实测钉死）：
 * VNDB search 是精确匹配，污染目录名 0 命中；梯子的职责是把目录名
 * 逐级放宽成能命中的干净词，同时保持原词在第一位（干净标题一发命中）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { queryLadder, stripBrackets } from '../src/main/scrapeQuery.js'

test('干净标题：原词在第一位（快路径，不多花请求）', () => {
  assert.equal(queryLadder('Muv-Luv Alternative')[0], 'Muv-Luv Alternative')
})

test('实测锚点：【Key】Clannad [EX](完全版) → 出现 Clannad（VNDB 实测命中 v4）', () => {
  const l = queryLadder('【Key】Clannad [EX](完全版)')
  assert.ok(l.includes('Clannad'), l.join(' | '))
})

test('实测锚点：サノバウィッチ -Sunna-【DL版】 → 出现 サノバウィッチ（命中 v16044）', () => {
  const l = queryLadder('サノバウィッチ -Sunna-【DL版】')
  assert.ok(l.includes('サノバウィッチ'), l.join(' | '))
})

test('实测锚点：ATRI -My Dear Moments-（中文版） → 剥括号后的干净词在梯内（VNDB 实测命中）', () => {
  const l = queryLadder('ATRI -My Dear Moments-（中文版）')
  assert.ok(l.includes('ATRI -My Dear Moments-'), l.join(' | '))
})

test('实测锚点：Rewrite 10th anniversary+ 全年龄版 → 尾部裁剪出 Rewrite（命中 v2510）', () => {
  const l = queryLadder('Rewrite 10th anniversary+ 全年龄版')
  assert.ok(l.includes('Rewrite'), l.join(' | '))
})

test('顺序=具体→宽泛：更长（更具体）的候选永远排在被裁剪的短词前', () => {
  const l = queryLadder('Summer Pockets REFLECTION BLUE（中文版）')
  const idxLong = l.indexOf('Summer Pockets REFLECTION BLUE')
  const idxShort = l.indexOf('Summer Pockets')
  assert.ok(idxLong >= 0 && idxShort >= 0 && idxLong < idxShort, l.join(' | '))
})

test('去重 + 限长：不重复、不超上限、不收 <2 字符的碎词', () => {
  const l = queryLadder('a - b - c', 5)
  assert.ok(l.length <= 5)
  assert.equal(new Set(l.map((x) => x.toLowerCase())).size, l.length)
  assert.ok(l.every((x) => x.length >= 2), l.join(' | '))
  assert.deepEqual(queryLadder(''), [])
})

test('噪音地板：尾部裁剪不出 <3 字符碎词（实测 "VR" 命中 8 条全无关）', () => {
  const l = queryLadder('VR Japanese Demo')
  assert.ok(!l.includes('VR'), l.join(' | '))
  assert.ok(l.includes('VR Japanese'), '剥掉 demo 的候选仍保留（合法检索词）')
})

test('stripBrackets：成对括号反复剥（全半角混合）', () => {
  assert.equal(stripBrackets('【组】作品[DL版]（完全版）').replace(/\s+/g, ' ').trim(), '作品')
})
