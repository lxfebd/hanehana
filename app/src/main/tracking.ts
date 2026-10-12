/**
 * 新作追踪（G16）：订阅开发商/系列/关键词，定时查 VNDB 有没有新作。
 *
 * 协议：VNDB v2 API（与 scraper.ts 同款）POST /kana/vn。
 *   过滤条件：released >= 上次检查时间，且 title/开发商 模糊匹配订阅词。
 * 无第三方依赖：查询用原生 fetch + AbortSignal.timeout。
 *
 * 通知：检查出「新」作（id 不在上次 seen 里）时才弹系统通知，
 * 由 index.ts 注入带窗口激活的回调，避免主进程文件与 UI 纠缠。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dataDir } from './store'
import type { TrackCheckResult, TrackEntry, TrackHit } from '../shared/types'

const UA = 'HaneHana/0.1 (galgame manager; contact: lxfebd)'
const TIMEOUT = 12000
/** 单次检查的 VNDB 每页数量 */
const RESULTS = 20
/** 一天（ms）：lastCheck 推进用「下一天」而不是 +1ms，否则当天发帖会被反复漏检 */
const DAY_MS = 86400000

// ---------------------------------------------------------------- 存储

function trackFile(): string {
  return join(dataDir(), 'tracking.json')
}

let entries: TrackEntry[] | null = null

export function loadTracking(): TrackEntry[] {
  if (entries) return entries
  try {
    if (existsSync(trackFile())) {
      const data = JSON.parse(readFileSync(trackFile(), 'utf8')) as unknown
      if (Array.isArray(data)) {
        entries = data
          .filter((x): x is TrackEntry => !!x && typeof x === 'object' && typeof (x as TrackEntry).keyword === 'string')
          .map((e) => ({
            id: typeof e.id === 'string' && e.id ? e.id : crypto.randomUUID(),
            keyword: e.keyword.slice(0, 200),
            lastCheck: typeof e.lastCheck === 'number' ? e.lastCheck : Date.now(),
            seenIds: Array.isArray(e.seenIds)
              ? e.seenIds.filter((x): x is string => typeof x === 'string').slice(0, 500)
              : [],
          }))
        return entries
      }
    }
    entries = []
  } catch {
    entries = []
  }
  return entries
}

function persist(): void {
  mkdirSync(dirname(trackFile()), { recursive: true })
  const tmp = trackFile() + '.tmp'
  writeFileSync(tmp, JSON.stringify(entries ?? [], null, 2), 'utf8')
  renameSync(tmp, trackFile())
}

export function addTrack(keyword: string): TrackEntry {
  const kw = keyword.trim().slice(0, 200)
  const all = loadTracking()
  // 同词不重复订阅
  const existing = all.find((e) => e.keyword.toLowerCase() === kw.toLowerCase())
  if (existing) return existing
  const e: TrackEntry = { id: crypto.randomUUID(), keyword: kw, lastCheck: Date.now(), seenIds: [] }
  all.push(e)
  persist()
  return e
}

export function removeTrack(id: string): boolean {
  const all = loadTracking()
  const before = all.length
  entries = all.filter((e) => e.id !== id)
  persist()
  return entries.length !== before
}

// ---------------------------------------------------------------- VNDB 查询

interface VndbReleaseVN {
  id: string
  title: string
  released?: string
  // VNDB schema：vn.developers 直接 _inherit /producer（扁平 {name}），没有
  // developer 子键——曾误写成 developers.developer.name，整条请求 400，
  // 新作追踪功能整体失效（已对照官方 schema 核实）。
  developers?: { name?: string }[]
}

async function fetchVndb(body: unknown): Promise<{ results: VndbReleaseVN[] }> {
  const r = await fetch('https://api.vndb.org/kana/vn', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!r.ok) throw new Error('VNDB HTTP ' + r.status)
  return r.json() as Promise<{ results: VndbReleaseVN[] }>
}

/** 测试缝：HANEHANA_VNDB_MOCK=1 时返回固定数据，供验收脚本离线验证（生产不设）。 */
let mockResults: VndbReleaseVN[] | null = null
export function setMockResults(r: VndbReleaseVN[] | null): void {
  mockResults = r
}

/** HANEHANA_VNDB_MOCK_FILE：验收脚本指定一个 JSON 文件当作 VNDB 返回（离线测试）。 */
function mockFromEnv(): VndbReleaseVN[] | null {
  const f = process.env.HANEHANA_VNDB_MOCK_FILE
  if (!f) return null
  try {
    const data = JSON.parse(readFileSync(f, 'utf8')) as unknown
    return Array.isArray(data) ? (data as VndbReleaseVN[]) : null
  } catch {
    return null
  }
}

/**
 * 查一个订阅词的新作：released >= upperBound（上次检查的下一天，防止漏当天）。
 * keyword 同时匹配 title 与开发商名（VNDB search 已带模糊，这里补一层保险）。
 *
 * 分页直到「不满一页」或超过上限页数：一次发帖量 >20 的新作若只查第一页，
 * 第 21 条以后既不上通知、也不进 seenIds，而 lastCheck 照常前移——这批新作
 * 从此被基准永远跳过，属永久漏检。分页代价是每订阅最多 MAX_PAGES 次请求，
 * 由并发信号量（SEMAPHORE）压住总量。
 */
const MAX_PAGES = 5
const TOP_RESULTS = 100
/** 单次检查对 VNDB 的最大并发请求数：订阅词多时不一次性打爆上游。 */
const SEMAPHORE = 4

async function queryKeyword(keyword: string, sinceDate: string): Promise<VndbReleaseVN[]> {
  const mock = mockFromEnv() ?? mockResults
  if (mock) {
    const kw = keyword.toLowerCase()
    return mock.filter((v) => {
      const title = (v.title ?? '').toLowerCase()
      if (title.includes(kw)) return true
      return (v.developers ?? []).some((d) => (d.name ?? '').toLowerCase().includes(kw))
    })
  }
  const kw = keyword.toLowerCase()
  const hits: VndbReleaseVN[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = {
      filters: ['and', ['released', '>=', sinceDate]],
      fields: 'id,title,released,developers.name',
      sort: 'released',
      reverse: true,
      page,
      results: RESULTS,
    }
    const j = await fetchVndb(body)
    const found = (j.results ?? []).filter((v) => {
      const title = (v.title ?? '').toLowerCase()
      if (title.includes(kw)) return true
      return (v.developers ?? []).some((d) => (d.name ?? '').toLowerCase().includes(kw))
    })
    hits.push(...found)
    // 不满一页 = 没有下一页了；超过收集上限也停
    if ((j.results ?? []).length < RESULTS || hits.length >= TOP_RESULTS) break
  }
  return hits.slice(0, TOP_RESULTS)
}

/** ISO 日期（yyyy-mm-dd）。from 是 epoch ms。 */
function isoDate(ts: number): string {
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** 单次检查进行中标记：防连点「立即检查」并发交错读写 tracking.json（重复通知）。 */
let checkInFlight = false

/**
 * 检查所有订阅：每个订阅词查一遍 VNDB（并行，订阅多时不串行卡死），识别
 * 「新」作（id 不在 seenIds 里），更新 lastCheck/seenIds，返回命中与新作清单。
 */
export async function checkTracks(): Promise<TrackCheckResult> {
  if (checkInFlight) return { ok: true, hits: [], fresh: [] }
  checkInFlight = true
  const all = loadTracking()
  if (!all.length) {
    checkInFlight = false
    return { ok: true, hits: [], fresh: [] }
  }
  const hits: TrackHit[] = []
  const fresh: TrackHit[] = []
  try {
    // 并发信号量：VNDB 最多同时 4 个请求（订阅多时不突发），各自分页内部串行。
    // 失败单独收进 errors，不拖垮其余订阅词的检查（此前 Promise.all 一个 reject
    // 整轮检查全废）。
    let cursor = 0
    let active = 0
    const results: { e: TrackEntry; found: VndbReleaseVN[] }[] = []
    const errors: string[] = []
    await new Promise<void>((resolve) => {
      const pump = (): void => {
        if (cursor >= all.length && active === 0) {
          resolve()
          return
        }
        while (active < SEMAPHORE && cursor < all.length) {
          const e = all[cursor++]
          active++
          void queryKeyword(e.keyword, isoDate(e.lastCheck + DAY_MS))
            .then((found) => results.push({ e, found }))
            .catch((err: unknown) => errors.push(`${e.keyword}: ${err instanceof Error ? err.message : String(err)}`))
            .finally(() => {
              active--
              pump()
            })
        }
      }
      pump()
    })
    for (const { e, found } of results) {
      // seenIds 最多留 500 条，逐条 includes 是 O(n) 线性扫；每个关键词转一次
      // Set（O(1) 判重），多关键词 × 多命中时省掉重复扫描。
      const seenSet = new Set(e.seenIds)
      for (const v of found) {
        const hit: TrackHit = { vnId: v.id, title: v.title, released: v.released ?? '', keyword: e.keyword }
        hits.push(hit)
        if (!seenSet.has(v.id)) fresh.push(hit)
      }
      // 更新 seen：老 + 新（最多留 500 防膨胀），时间推进到今天
      const seen = [...e.seenIds, ...found.map((v) => v.id)]
      e.seenIds = [...new Set(seen)].slice(-500)
      e.lastCheck = Date.now()
    }
    persist()
    return { ok: true, hits, fresh, ...(errors.length ? { error: errors.join('；') } : {}) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    checkInFlight = false
  }
}
