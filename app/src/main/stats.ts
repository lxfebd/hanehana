/**
 * 统计报表聚合（G5）。
 *
 * 数据源：store 里的 PlaySession 记录（游戏退出时追加）+ games.json 里的
 * playMs 总量（兼容没有会话记录的老库）。聚合在主进程算，渲染层只消费结果。
 */
import type { DayStat, Game, PlaySession, OverviewStats, SessionQuery } from '../shared/types'

export type { OverviewStats } from '../shared/types'

const DAY_MS = 86400000
/** 会话查询默认/最大条数：界面只要一屏，不要把整份会话表灌进渲染进程。 */
export const SESSION_LIMIT_DEFAULT = 100
export const SESSION_LIMIT_MAX = 500


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

  // 兼容老库：games.json 里的 playMs 总量（无会话记录时也算进总时长）。
  // playMs 是权威口径——games.ts 每次游戏退出都会把本次时长累加进 playMs，
  // 同时才追加会话记录，所以 legacyTotal 恒 ≥ sessionTotal（老库只有 playMs、
  // 新库两边都有），取 max 得到的就是完整累计时长。保留双口径仅为了
  // 老库（有 playMs 无会话）也能统计出总量。
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
    .map(([gameId, v]) => ({
      gameId,
      title: v.title,
      ms: v.ms,
      sessions: v.sessions,
      lastPlayed: v.lastPlayed || undefined,
    }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 10)

  return { monthMs, weekMs, totalMs, playedGames, todayMs, days, topGames }
}

/**
 * 把渲染层传来的会话查询规整成可信形状。
 *
 * window.hh 谁都能调（渲染层是不可信输入），所以类型、NaN、limit=1e9
 * 都要在这里夹掉：一个坏 limit 会把整份会话表灌进渲染进程。
 */
export function normalizeSessionQuery(q: unknown): SessionQuery {
  const src = q && typeof q === 'object' ? (q as Record<string, unknown>) : {}
  const out: SessionQuery = {}
  if (typeof src.gameId === 'string' && src.gameId.trim()) out.gameId = src.gameId
  if (typeof src.since === 'number' && Number.isFinite(src.since)) out.since = src.since
  const raw = typeof src.limit === 'number' && Number.isFinite(src.limit) ? src.limit : SESSION_LIMIT_DEFAULT
  out.limit = Math.max(1, Math.min(SESSION_LIMIT_MAX, Math.floor(raw)))
  return out
}

/** 按查询取会话记录，结束时间倒序——活动流要的就是「最近发生的排最前」。 */
export function selectSessions(sessions: PlaySession[], q: SessionQuery = {}): PlaySession[] {
  const limit = q.limit ?? SESSION_LIMIT_DEFAULT
  return sessions
    .filter(
      (s) =>
        (!q.gameId || s.gameId === q.gameId) &&
        (q.since === undefined || s.end >= q.since) &&
        Number.isFinite(s.end) &&
        Number.isFinite(s.ms),
    )
    .sort((a, b) => b.end - a.end)
    .slice(0, limit)
}

/**
 * 按日时长序列，**缺日补 0**。
 *
 * 补零不是美化：只把有记录的日子排进 X 轴，一条「周末玩了 5 小时」会被
 * 画成连着一串没玩过的日子，曲线的形状就开始说谎。
 * 口径与 computeOverview 的 days 相同（按会话结束时间归日，本地时区）。
 */
export function dailySeries(
  sessions: PlaySession[],
  opts: { gameId?: string; fromTs: number; toTs?: number },
): DayStat[] {
  const from = dayStart(opts.fromTs)
  const to = dayStart(opts.toTs ?? Date.now())
  const fromKey = dayKey(from)
  const toKey = dayKey(to)
  const map = new Map<string, { ms: number; games: Set<string> }>()
  for (const s of sessions) {
    if (opts.gameId && s.gameId !== opts.gameId) continue
    if (!Number.isFinite(s.end) || !Number.isFinite(s.ms) || s.ms <= 0) continue
    const k = dayKey(s.end)
    if (k < fromKey || k > toKey) continue
    const d = map.get(k) ?? { ms: 0, games: new Set<string>() }
    d.ms += s.ms
    d.games.add(s.gameId)
    map.set(k, d)
  }
  const span = Math.max(0, Math.round((to - from) / DAY_MS))
  const out: DayStat[] = []
  for (let i = span; i >= 0; i--) {
    const ts = dayStart(to) - i * DAY_MS
    const k = dayKey(ts)
    const d = map.get(k)
    out.push({ date: k, ms: d?.ms ?? 0, games: d?.games.size ?? 0 })
  }
  return out
}
