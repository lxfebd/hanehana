/**
 * 统计报表聚合（G5）。
 *
 * 数据源：store 里的 PlaySession 记录（游戏退出时追加）+ games.json 里的
 * playMs 总量（兼容没有会话记录的老库）。聚合在主进程算，渲染层只消费结果。
 */
import type { DayStat, Game, PlaySession, OverviewStats } from '../shared/types'

export type { OverviewStats } from '../shared/types'

const DAY_MS = 86400000

/** yyyy-mm-dd（本地时区） */
function dayKey(ts: number): string {
  const d = new Date(ts)
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 该天的零点（本地） */
function dayStart(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function computeOverview(games: Game[], sessions: PlaySession[]): OverviewStats {
  const now = Date.now()
  const today = dayStart(now)

  // 会话口径：近 90 天按游戏聚合
  const since90 = now - 90 * DAY_MS
  const byGame = new Map<string, { title: string; ms: number; sessions: number; lastPlayed: number }>()
  let monthMs = 0
  let weekMs = 0
  let todayMs = 0
  const dayMap = new Map<string, { ms: number; games: Set<string> }>()
  for (const s of sessions) {
    if (s.end < since90) continue
    const g = byGame.get(s.gameId) ?? { title: s.title || '未知游戏', ms: 0, sessions: 0, lastPlayed: 0 }
    g.ms += s.ms
    g.sessions += 1
    if (s.end > g.lastPlayed) g.lastPlayed = s.end
    byGame.set(s.gameId, g)

    if (s.end >= today) todayMs += s.ms
    if (s.end >= now - 30 * DAY_MS) monthMs += s.ms
    if (s.end >= now - 7 * DAY_MS) weekMs += s.ms

    const k = dayKey(s.end)
    const d = dayMap.get(k) ?? { ms: 0, games: new Set() }
    d.ms += s.ms
    d.games.add(s.gameId)
    dayMap.set(k, d)
  }

  // 兼容老库：games.json 里的 playMs 总量（无会话记录时也算进总时长）
  const legacyTotal = games.reduce((a, g) => a + g.playMs, 0)
  const sessionTotal = sessions.reduce((a, s) => a + s.ms, 0)
  const totalMs = Math.max(legacyTotal, sessionTotal)
  const playedGames = new Set([...games.filter((g) => g.playMs > 0).map((g) => g.id), ...byGame.keys()]).size

  // 近 30 天按日（升序），缺日的补 0，保证图表连续
  const days: DayStat[] = []
  for (let i = 29; i >= 0; i--) {
    const ts = dayStart(now) - i * DAY_MS
    const k = dayKey(ts)
    const d = dayMap.get(k)
    days.push({ date: k, ms: d?.ms ?? 0, games: d?.games.size ?? 0 })
  }

  const topGames = [...byGame.entries()]
    .map(([gameId, v]) => ({ gameId, title: v.title, ms: v.ms, sessions: v.sessions, lastPlayed: v.lastPlayed || undefined }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 10)

  return { monthMs, weekMs, totalMs, playedGames, todayMs, days, topGames }
}
