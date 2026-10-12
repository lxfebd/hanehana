/**
 * sanitizeScrapeResult 净化契约（刮削源不可信数据的安全边界）。
 *
 * 外部源（VNDB/Bangumi）的响应是 unknown，直接进库会把「字段超长、
 * rating 越界、封面指向内网/明文」的脏数据带进游戏库。sanitize 是唯一关口：
 *   - provider 白名单（vndb/bangumi）、id/title 必填
 *   - 所有字符串长度截断；数组限条数
 *   - rating 钳制 [0,10]、lengthMinutes 钳制 + 取整
 *   - coverUrl 不在白名单（https + 见过的域名）时整条丢弃，元数据照常保留
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeScrapeResult } from '../src/main/scrapeRules.js'

test('合法输入：字段全部通过并截断超长值', () => {
  const r = sanitizeScrapeResult({
    provider: 'vndb',
    id: 'v1234',
    title: '恋×シンアイ彼女',
    description: 'd'.repeat(50000),
    rating: 8.5,
    tags: ['恋爱', 'x'.repeat(100), 123, '纯爱'],
    series: ['s'.repeat(300), 'SERIES2'],
    aliases: ['别名1'],
    lengthMinutes: 1234.9,
    coverUrl: 'https://cdn.example.com/c.jpg',
  })
  assert.ok(r)
  assert.equal(r.provider, 'vndb')
  assert.equal(r.id, 'v1234')
  // description 截到 20000
  assert.equal(r.description?.length, 20000)
  assert.equal(r.rating, 8.5)
  // tags：非字符串过滤、超长截到 64
  assert.deepEqual(r.tags, ['恋爱', 'x'.repeat(64), '纯爱'])
  // series：超长截到 200
  assert.deepEqual(r.series, ['s'.repeat(200), 'SERIES2'])
  assert.equal(r.lengthMinutes, 1234)
})

test('rating 越界钳制到 [0,10]', () => {
  assert.equal(sanitizeScrapeResult({ provider: 'bangumi', id: 'b1', title: 'T', rating: 99 })?.rating, 10)
  assert.equal(sanitizeScrapeResult({ provider: 'bangumi', id: 'b1', title: 'T', rating: -5 })?.rating, 0)
  assert.equal(sanitizeScrapeResult({ provider: 'bangumi', id: 'b1', title: 'T', rating: 7.4 })?.rating, 7.4)
})

test('provider 不在白名单 / id / title 缺失 → null', () => {
  assert.equal(sanitizeScrapeResult({ provider: 'steam', id: 'x', title: 'T' }), null)
  assert.equal(sanitizeScrapeResult({ provider: 'vndb', title: 'T' }), null)
  assert.equal(sanitizeScrapeResult({ provider: 'vndb', id: 'x' }), null)
  assert.equal(sanitizeScrapeResult(null), null)
  assert.equal(sanitizeScrapeResult('str'), null)
  assert.equal(sanitizeScrapeResult(42), null)
})

test('id 空白裁剪 + 超长截断', () => {
  const r = sanitizeScrapeResult({ provider: 'vndb', id: '  v' + '1'.repeat(200), title: 'T' })
  assert.ok(r)
  assert.equal(r.id.length, 64)
  assert.ok(!r.id.startsWith(' '), 'id 先 trim 再截断')
})

test('coverUrl 不在白名单：整条丢弃但元数据照常保留', () => {
  const r = sanitizeScrapeResult({
    provider: 'vndb',
    id: 'v1',
    title: 'T',
    rating: 9,
    coverUrl: 'http://evil.example.com/c.jpg', // 非 https → 白名单外
  })
  assert.ok(r)
  assert.equal(r.coverUrl, undefined)
  assert.equal(r.rating, 9, 'coverUrl 丢弃不影响其余字段')
})

test('coverUrl 非法 URL：丢弃不炸', () => {
  const r = sanitizeScrapeResult({ provider: 'bangumi', id: 'b1', title: 'T', coverUrl: 'not a url' })
  assert.ok(r)
  assert.equal(r.coverUrl, undefined)
})

test('数组字段：非数组原样不写', () => {
  const r = sanitizeScrapeResult({ provider: 'vndb', id: 'v1', title: 'T', tags: 'not-array' })
  assert.ok(r)
  assert.equal(r.tags, undefined)
})
