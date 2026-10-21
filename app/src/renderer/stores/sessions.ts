/**
 * 游玩会话域 store（活动流与时长曲线的数据层）。
 *
 * 主进程 play-sessions.json 是权威；这里只做「取 + 派生两种视图」：
 *  - 会话明细分页/筛选走 window.hh.statsSessions(q)（主进程 normalizeSessionQuery
 *    会夹 limit ≤ 500，渲染层不可信输入不直接进 IPC）
 *  - 缺日补零的日序列、按日分组在渲染层算——曲线要按当前区间实时切换，
 *    每次都回主进程让每次拖拽都过一次 IPC，不值
 *
 * 组件不直接碰 window.hh：调用 loadSessions/refreshActivity 即可。
 */
import { reactive } from 'vue'
import type { DayStat, PlaySession, SessionQuery } from '../../shared/types'
import { ONE_DAY_MS, dayKey, dayStart } from '../../shared/format'

export const sessionsState = reactive({
  list: [] as PlaySession[],
  loading: false,
  loaded: false,
})

/** 拉一批会话（默认最近 100 条）。失败时保留旧数据、error 由调用方处理。 */
export async function loadSessions(q: SessionQuery = {}): Promise<PlaySession[]> {
  sessionsState.loading = true
  try {
    const list = await window.hh.statsSessions(q)
    return Array.isArray(list) ? list : []
  } finally {
    sessionsState.loading = false
  }
}

/**
 * 刷新右栏活动流：最近 500 条（活动流一屏只显示几十条，500 足够覆盖
 * 「本周/昨天」分组的边界；再多只是浪费序列化成本）。
 */
export async function refreshActivity(): Promise<void> {
  const list = await loadSessions({ limit: 500 })
  sessionsState.list = list
  sessionsState.loaded = true
}

/**
 * 日序列（**缺日补 0**）。
 *
 * 补零不是美化：只把有记录的日子排进 X 轴，一条「周末玩了 5 小时」会被
 * 画成连着一串没玩过的日子，曲线的形状就开始说谎。区间两端闭区间，
 * 升序返回（图表从左往右读）。
 */
export function dailyFromSessions(
  list: PlaySession[],
  o: { fromTs: number; toTs?: number; gameId?: string },
): DayStat[] {
  const to = dayStart(o.toTs ?? Date.now())
  const from = dayStart(o.fromTs)
  const fromKey = dayKey(from)
  const toKey = dayKey(to)
  const map = new Map<string, DayStat>()
  for (const s of list) {
    if (o.gameId && s.gameId !== o.gameId) continue
    if (!Number.isFinite(s.end) || !Number.isFinite(s.ms) || s.ms <= 0) continue
    const k = dayKey(s.end)
    if (k < fromKey || k > toKey) continue
    const d = map.get(k) ?? { date: k, ms: 0, games: 0 }
    d.ms += s.ms
    d.games += 1
    map.set(k, d)
  }
  const span = Math.max(0, Math.round((to - from) / ONE_DAY_MS))
  const out: DayStat[] = []
  for (let i = span; i >= 0; i--) {
    const ts = to - i * ONE_DAY_MS
    const k = dayKey(ts)
    const d = map.get(k)
    out.push({ date: k, ms: d?.ms ?? 0, games: d?.games ?? 0 })
  }
  return out
}

/**
 * 会话所属日期的展示键：'today' / 'yesterday' / 'yyyy-mm-dd'。
 *
 * 今天/昨天是**相对当前时间**的——活动流里「2026-10-21」远不如「今天」
 * 直观（基准 ReinaManager 同做法）。绝对日期只给更早的日子。
 */
export function dayBucketKey(ts: number): string {
  const k = dayKey(ts)
  if (k === dayKey(Date.now())) return 'today'
  if (k === dayKey(Date.now() - ONE_DAY_MS)) return 'yesterday'
  return k
}

/** 按日分组（最近在前）：key 为 'today' / 'yesterday' / 'yyyy-mm-dd'。 */
export function groupByDay(list: PlaySession[]): { key: string; items: PlaySession[] }[] {
  const buckets = new Map<string, PlaySession[]>()
  for (const s of [...list].sort((a, b) => b.end - a.end)) {
    if (!Number.isFinite(s.end)) continue
    const key = dayBucketKey(s.end)
    const arr = buckets.get(key) ?? []
    arr.push(s)
    buckets.set(key, arr)
  }
  return [...buckets.entries()].map(([key, items]) => ({ key, items }))
}

/** 会话总时长（活动流「本周时长」等小统计用）。 */
export function sumMs(list: PlaySession[], sinceTs?: number): number {
  return list.reduce((acc, s) => (Number.isFinite(s.ms) && (sinceTs === undefined || s.end >= sinceTs) ? acc + s.ms : acc), 0)
}
