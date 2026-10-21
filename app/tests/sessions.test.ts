/**
 * stats.ts 会话查询/按日序列契约（右栏活动流 + 详情页时长曲线的底座）。
 *
 * 三件事必须钉住：
 *  1) 渲染层是不可信输入——limit 要夹、类型要校验，坏查询不能把整份会话表灌进界面；
 *  2) 活动流要「最近在前」，并且能按游戏筛；
 *  3) 按日序列必须缺日补 0——只排有记录的日子，曲线形状会说谎（对标项目就栽在这）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SESSION_LIMIT_DEFAULT,
  SESSION_LIMIT_MAX,
  dailySeries,
  normalizeSessionQuery,
  selectSessions,
} from '../src/main/stats.js'
import type { PlaySession } from '../src/shared/types.js'

/** 本地时区构造时间戳，避免测试跟着 UTC 漂 */
function at(y: number, mo: number, d: number, h = 12, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi).getTime()
}
/** 本地 yyyy-mm-dd，与 stats.ts 的 dayKey 同口径 */
function key(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`
}
function sess(gameId: string, end: number, ms: number, start = end - ms): PlaySession {
  return { gameId, title: gameId, start, end, ms }
}

test('normalizeSessionQuery：坏输入一律夹成可信形状', () => {
  assert.deepEqual(normalizeSessionQuery(undefined), { limit: SESSION_LIMIT_DEFAULT })
  assert.deepEqual(normalizeSessionQuery('乱码'), { limit: SESSION_LIMIT_DEFAULT })
  assert.deepEqual(normalizeSessionQuery({ limit: 1e9 }), { limit: SESSION_LIMIT_MAX })
  assert.deepEqual(normalizeSessionQuery({ limit: 0 }), { limit: 1 })
  assert.deepEqual(normalizeSessionQuery({ limit: -7 }), { limit: 1 })
  assert.deepEqual(normalizeSessionQuery({ limit: NaN }), { limit: SESSION_LIMIT_DEFAULT })
  assert.deepEqual(normalizeSessionQuery({ limit: '30' }), { limit: SESSION_LIMIT_DEFAULT })
  assert.deepEqual(normalizeSessionQuery({ since: NaN }), { limit: SESSION_LIMIT_DEFAULT })
  assert.deepEqual(normalizeSessionQuery({ gameId: '  ' }), { limit: SESSION_LIMIT_DEFAULT })
  assert.deepEqual(normalizeSessionQuery({ gameId: 'g1', since: 100, limit: 5 }), {
    gameId: 'g1',
    since: 100,
    limit: 5,
  })
})

test('selectSessions：最近在前、能按游戏筛、limit 生效', () => {
  const all = [sess('a', at(2026, 10, 1), 60_000), sess('b', at(2026, 10, 9), 90_000), sess('a', at(2026, 10, 5), 30_000)]
  const recent = selectSessions(all)
  assert.deepEqual(
    recent.map((s) => s.end),
    [at(2026, 10, 9), at(2026, 10, 5), at(2026, 10, 1)],
  )
  assert.deepEqual(
    selectSessions(all, { gameId: 'a' }).map((s) => s.gameId),
    ['a', 'a'],
  )
  assert.equal(selectSessions(all, { limit: 2 }).length, 2)
  assert.equal(selectSessions(all, { since: at(2026, 10, 5) }).length, 2)
})

test('selectSessions：坏记录（NaN 时间/时长）不进活动流', () => {
  const all = [sess('a', Number.NaN, 1000), sess('b', at(2026, 10, 2), Number.NaN), sess('c', at(2026, 10, 3), 1000)]
  assert.deepEqual(
    selectSessions(all).map((s) => s.gameId),
    ['c'],
  )
})

test('dailySeries：没玩过的日子补 0，序列连续', () => {
  const from = at(2026, 10, 1)
  const to = at(2026, 10, 5)
  const out = dailySeries([sess('a', at(2026, 10, 1, 20), 3600_000), sess('a', at(2026, 10, 4, 9), 600_000)], {
    fromTs: from,
    toTs: to,
  })
  assert.equal(out.length, 5, '连续 5 天，一天不少')
  assert.deepEqual(
    out.map((d) => d.date),
    [key(at(2026, 10, 1)), key(at(2026, 10, 2)), key(at(2026, 10, 3)), key(at(2026, 10, 4)), key(at(2026, 10, 5))],
  )
  assert.deepEqual(
    out.map((d) => d.ms),
    [3600_000, 0, 0, 600_000, 0],
  )
})

test('dailySeries：按游戏筛，跨游戏的日只算这一款', () => {
  const sessions = [sess('a', at(2026, 10, 2, 10), 1000), sess('b', at(2026, 10, 2, 20), 4000)]
  const only = dailySeries(sessions, { gameId: 'a', fromTs: at(2026, 10, 2), toTs: at(2026, 10, 2) })
  assert.deepEqual(only, [{ date: key(at(2026, 10, 2)), ms: 1000, games: 1 }])
  const both = dailySeries(sessions, { fromTs: at(2026, 10, 2), toTs: at(2026, 10, 2) })
  assert.deepEqual(both, [{ date: key(at(2026, 10, 2)), ms: 5000, games: 2 }])
})

test('dailySeries：范围外的会话不掺进来，同一天多次会话合并', () => {
  const sessions = [
    sess('a', at(2026, 9, 30, 23, 59), 1000),
    sess('a', at(2026, 10, 3, 8), 1000),
    sess('a', at(2026, 10, 3, 22), 2000),
    sess('a', at(2026, 10, 6, 1), 1000),
  ]
  const out = dailySeries(sessions, { fromTs: at(2026, 10, 1), toTs: at(2026, 10, 4) })
  assert.equal(out.length, 4)
  assert.deepEqual(
    out.map((d) => d.ms),
    [0, 0, 3000, 0],
  )
})

test('dailySeries：今天开始到今天结束至少有一天', () => {
  const now = Date.now()
  const out = dailySeries([], { fromTs: now, toTs: now })
  assert.equal(out.length, 1)
  assert.deepEqual(out[0], { date: key(now), ms: 0, games: 0 })
})
