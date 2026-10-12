/**
 * engineLines 行缓冲解析契约（引擎协议边界行为）。
 *
 * 引擎 stdout 是换行 JSON：流式读取会切在任意位置。这段解析是协议第一道关口，
 * 行为契约：
 *   - 完整行按 \n 切出，不含换行符；
 *   - 最后一条不带 \n 的是「半行」，必须留在 rest 给下次拼；
 *   - 超大缓冲（>512KiB）只留尾部，但要保住最后一个 \n 之后的完整行，
 *     不能把半条事件砍没；
 *   - 空行也原样返回（由调用方决定跳过）。
 * 改协议解析先改测试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
// ESM 之谜：node 只认带 .js 的 specifier，TS 会把它映射回 .ts——两头都通。
import { consumeLines } from '../src/main/engineLines.js'

test('切出完整行、半行留给 rest', () => {
  const r = consumeLines('{"a":1}\n{"b":2}\n{"c":3}')
  assert.deepEqual(r.lines, ['{"a":1}', '{"b":2}'])
  assert.equal(r.rest, '{"c":3}')
})

test('chunk 拼接：上次的半行 + 新 chunk 合出完整行', () => {
  const first = consumeLines('{"a":1}\n{"b":2}\n{"c"')
  assert.deepEqual(first.lines, ['{"a":1}', '{"b":2}'])
  assert.equal(first.rest, '{"c"')
  const second = consumeLines(first.rest + ':3}\n{"d":4}')
  assert.deepEqual(second.lines, ['{"c":3}'])
  // {"d":4} 没有换行符，是半行，留给下一次
  assert.equal(second.rest, '{"d":4}')
})

test('空行原样返回（调用方决定跳过）', () => {
  const r = consumeLines('{"a":1}\n\n\n{"b":2}\n')
  assert.deepEqual(r.lines, ['{"a":1}', '', '', '{"b":2}'])
  assert.equal(r.rest, '')
})

test('无换行符时全是 rest、没有行', () => {
  const r = consumeLines('{"a":1}')
  assert.deepEqual(r.lines, [])
  assert.equal(r.rest, '{"a":1}')
})

test('超大缓冲：完整行照切，rest 保住尾部完整事件', () => {
  // 构造超过 512KiB 的缓冲：塞满 600KiB 垃圾 + 一个末尾半行事件
  const garbage = 'x'.repeat(600 * 1024)
  const tailEvent = '{"evt":"final"}'
  const r = consumeLines(`${garbage}\n${tailEvent}`)
  // 垃圾是完整行（600KiB，跟 \n 一起被切掉），不触发 rest 截断
  assert.equal(r.lines.length, 1)
  assert.equal(r.lines[0].length, 600 * 1024)
  // rest 保住完整尾事件（不能砍半）
  assert.equal(r.rest, tailEvent)
})

test('超大缓冲 rest：单个超大半行只留尾部、保住事件结尾', () => {
  // rest 是没换行符的半行，长度超 MAX_BUF → 截到 MAX_BUF 尾部
  const r = consumeLines('a'.repeat(600 * 1024) + '{"evt":"tail"')
  assert.deepEqual(r.lines, [])
  assert.equal(r.rest.length, 64 * 1024 * 8)
  assert.ok(r.rest.endsWith('{"evt":"tail"'), '截断保住事件结尾')
})

test('超大缓冲里也有完整行：行照常切出，rest 截到尾部完整行', () => {
  const garbage = 'y'.repeat(600 * 1024)
  const r = consumeLines(`${garbage}\n${garbage}\n{"evt":"keep"}\n{"evt":"tail"`)
  // 垃圾行 + 完整事件行都切出来（600KiB 整行不触发截断）
  assert.equal(r.lines.length, 3)
  assert.deepEqual(r.lines[2], '{"evt":"keep"}')
  // rest 是最后那个半行事件（长度没超限，不截断）
  assert.equal(r.rest, '{"evt":"tail"')
})
