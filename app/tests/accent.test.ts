/**
 * 自定义主题色（accent）行为契约。
 *
 * 这个模块的产出直接进 CSS 变量，所以"形状"比"好不好看"更重要：
 * 坏 hex 必须变 null（而不是把垃圾写进 var()），可读色必须真的达到 4.5:1。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
// ESM 之谜：node 只认带 .js 的 specifier，TS 会把它映射回 .ts——两头都通。
import { normalizeAccentHex, readableAccent, ACCENT_PRESETS } from '../src/shared/accent.js'

test('normalizeAccentHex: 6 位大写带 #', () => {
  assert.equal(normalizeAccentHex('#ff8800'), '#FF8800')
  assert.equal(normalizeAccentHex('FF8800'), '#FF8800')
})

test('normalizeAccentHex: 3 位展开为 6 位', () => {
  assert.equal(normalizeAccentHex('#f80'), '#FF8800')
  assert.equal(normalizeAccentHex('abc'), '#AABBCC')
})

test('normalizeAccentHex: 非字符串/坏长度/非 hex 字符一律 null', () => {
  assert.equal(normalizeAccentHex(null), null)
  assert.equal(normalizeAccentHex(undefined), null)
  assert.equal(normalizeAccentHex(0xff8800), null)
  assert.equal(normalizeAccentHex('#ff88'), null)
  assert.equal(normalizeAccentHex('#gggggg'), null)
  assert.equal(normalizeAccentHex(''), null)
  // 带空格的合法输入：trim 后可用（设置页输入框常见）
  assert.equal(normalizeAccentHex('  #ff8800  '), '#FF8800')
})

test('readableAccent: 对比足够时原样返回', () => {
  // 白底上的深色 accent：本身就 >= 4.5，不该被改动
  assert.equal(readableAccent('#1D4ED8', '#FFFFFF', false), '#1D4ED8')
})

test('readableAccent: 深底上把过暗的 accent 提亮到可读', () => {
  const before = '#0B1220'
  const adjusted = readableAccent(before, '#0A0A0B', true)
  assert.notEqual(adjusted, before, '过暗的 accent 必须被调整')
  // 契约：结果比原值亮（向白推移），具体停在哪一档由对比度决定
  const ch = (h: string) => parseInt(h.slice(1, 3), 16)
  assert.ok(ch(adjusted) > ch(before), `应向白推移: ${before} -> ${adjusted}`)
})

test('readableAccent: 浅底上把过亮的 accent 压暗到可读', () => {
  const before = '#FAFAFA'
  const adjusted = readableAccent(before, '#FFFFFF', false)
  assert.notEqual(adjusted, before, '过亮的 accent 必须被调整')
  const ch = (h: string) => parseInt(h.slice(1, 3), 16)
  assert.ok(ch(adjusted) < ch(before), `应向黑推移: ${before} -> ${adjusted}`)
})

test('readableAccent: 与背景同色也能给出可读结果', () => {
  // 与背景完全同色（对比 1:1）时，算法沿着"往白/往黑"推进到第一个
  // 达到 4.5:1 的色阶就停（不一定是纯白/纯黑）。契约是"结果可读"。
  const onBlack = readableAccent('#000000', '#000000', true)
  const onWhite = readableAccent('#FFFFFF', '#FFFFFF', false)
  assert.notEqual(onBlack, '#000000', '不能原样返回不可读的同背景色')
  assert.notEqual(onWhite, '#FFFFFF', '不能原样返回不可读的同背景色')
  // 用 WCAG 相对亮度验证结果与背景的对比度 >= 4.5（可读契约）。
  // 注意不能断言 >0x80 之类的绝对值：纯黑底上 4.5:1 只要 ~0x7B 就够，
  // 二分停在最近满足点，不是无脑推到纯白。
  const lum = (h: string): number =>
    [0, 2, 4]
      .map((i) => parseInt(h.slice(1 + i, 3 + i), 16) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i]!, 0)
  const contrast = (a: string, b: string): number => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
    return (x + 0.05) / (y + 0.05)
  }
  assert.ok(contrast(onBlack, '#000000') >= 4.5, `深底结果应达 4.5:1: ${onBlack}`)
  assert.ok(contrast(onWhite, '#FFFFFF') >= 4.5, `浅底结果应达 4.5:1: ${onWhite}`)
})

test('ACCENT_PRESETS: 预设 id 唯一且格式正确', () => {
  const ids = ACCENT_PRESETS.map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length, '预设 id 不可重复')
  for (const p of ACCENT_PRESETS) {
    if (p.id === 'preset' || p.id === 'custom') continue
    assert.ok(normalizeAccentHex(p.hex), `预设 ${p.id} 的 hex 必须合法: ${p.hex}`)
  }
})
