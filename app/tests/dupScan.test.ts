/**
 * 重复入库回归：同一款游戏装在两个目录（实测用户机器 F:\gg 与 G:\ggame 各一份），
 * 归一化标题后必须压成同一个判重键——否则封面墙上同一个游戏出现 N 份。
 *
 * 这里测纯函数 dupKeyOf（不 import games.ts，避开 electron 依赖）。
 * 集成层（handleScan/handleSteamImport 用同一把键）由 e2e 走查覆盖。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { dupKeyOf } from '../src/main/dupKey.js'

/** 与 games.ts 的 cleanTitle 同源逻辑副本（测试内自足，不拉 electron）。
 *  真正的 cleanTitle 在 games.ts，两边行为必须一致——靠下面第一条断言钉住。 */
function cleanTitle(raw: string): string {
  let t = raw.trim()
  t = t.replace(/[（(][^）)]*[）)]/g, ' ')
  t = t.replace(/[+\s]*\d+(?:\.\d+){1,}(?:\s*[+\-–].*)?$/i, ' ')
  t = t.replace(/[+\s]*v?\d+(?:\.\d+)+/gi, ' ')
  t = t.replace(
    /(汉化(?:补丁)?(?:全[面们]?|版)?|整合包|完整版|绿色版|免安装|硬盘版|简体中文|繁体中文|步兵|骑兵|fff?mod|小黑盒|叮卜|上色|白[色版]|DLC\+.*|全\.? unlock.*|ver\s*\d+(?:\.\d+)*)/gi,
    ' ',
  )
  t = t.replace(/\s*\d+(?:\.\d+)+(?:[+-][^ ]*)+/g, ' ')
  t = t
    .replace(/[+_…_/\\|,;:：，、]+/g, ' ')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  return t || raw.trim()
}

/** 用户机器上的真实目录名 */
const MEIXIANGSUI_COLOR =
  '妹相随1.4.5+DLC+fffmod1.6.0 步兵整合包小黑盒叮卜汉化（全部使用daseson上色）'
const MEIXIANGSUI_BW = '妹相随1.4.5+DLC+fffmod1.6.0 步兵整合包小黑盒叮卜汉化（黑白版本！！！）'

test('妹相随彩色/黑白两个版本目录 → 同一个判重键', () => {
  const a = dupKeyOf(MEIXIANGSUI_COLOR, cleanTitle(MEIXIANGSUI_COLOR), cleanTitle)
  const b = dupKeyOf(MEIXIANGSUI_BW, cleanTitle(MEIXIANGSUI_BW), cleanTitle)
  assert.equal(a, b)
  assert.equal(a, '妹相随')
})

test('判重键大小写/空白不敏感（Living With SIster 大小写变体同键）', () => {
  const a = dupKeyOf('Living With SIster Monochrome Fantasy', 'Living With SIster Monochrome Fantasy', cleanTitle)
  const b = dupKeyOf('living with sister monochrome fantasy', 'living with sister monochrome fantasy', cleanTitle)
  assert.equal(a, b)
})

test('真正不同的游戏 → 不同键（判重不能误杀）', () => {
  const a = dupKeyOf("Yog-Sothoth's Yard", "Yog-Sothoth's Yard", cleanTitle)
  const b = dupKeyOf('NTR Master V0.2.1', 'NTR Master', cleanTitle)
  const c = dupKeyOf('夏ノ音', '夏ノ音', cleanTitle)
  assert.notEqual(a, b)
  assert.notEqual(b, c)
  assert.notEqual(a, c)
})

test('词内连字符保留（Yog-Sothoth 不被误削成两截）', () => {
  assert.equal(dupKeyOf("Yog-Sothoth's Yard", "Yog-Sothoth's Yard", cleanTitle), "yog-sothoth's yard")
})

test('title 为空时退回 rawTitle 归一', () => {
  const a = dupKeyOf(MEIXIANGSUI_COLOR, '', cleanTitle)
  const b = dupKeyOf(MEIXIANGSUI_COLOR, cleanTitle(MEIXIANGSUI_COLOR), cleanTitle)
  assert.equal(a, b)
})
