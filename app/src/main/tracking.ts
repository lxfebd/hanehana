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
            seenIds: Array.isArray(e.seenIds) ? e.seenIds.filter((x): x is string => typeof x === 'string').slice(0, 500) : [],
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
  developers?: { developer?: { name?: string } }[]
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
 */
async function queryKeyword(keyword: string, sinceDate: string): Promise<VndbReleaseVN[]> {
  const mock = mockFromEnv() ?? mockResults
  if (mock) {
    const kw = keyword.toLowerCase()
    return mock.filter((v) => {
      const title = (v.title ?? '').toLowerCase()
      if (title.includes(kw)) return true
      return (v.developers ?? []).some((d) => (d.developer?.name ?? '').toLowerCase().includes(kw))
    })
  }
  const body = {
    filters: ['and', ['released', '>=', sinceDate]],
    fields: 'id,title,released,developers.developer.name',
    sort: 'released',
    reverse: true,
    page: 1,
    results: RESULTS,
  }
  const j = await fetchVndb(body)
  const kw = keyword.toLowerCase()
  const hits = (j.results ?? []).filter((v) => {
    const title = (v.title ?? '').toLowerCase()
    if (title.includes(kw)) return true
    return (v.developers ?? []).some((d) => (d.developer?.name ?? '').toLowerCase().includes(kw))
  })
  return hits.slice(0, RESULTS)
}

/** ISO 日期（yyyy-mm-dd）。from 是 epoch ms。 */
function isoDate(ts: number): string {
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/**
 * 检查所有订阅：每个订阅词查一遍 VNDB，识别「新」作（id 不在 seenIds 里、且非
 * 用户此前手动标记过已见的），更新 lastCheck/seenIds，返回命中与新作清单。
 */
export async function checkTracks(): Promise<TrackCheckResult> {
  const all = loadTracking()
  if (!all.length) return { ok: true, hits: [], fresh: [] }
  const hits: TrackHit[] = []
  const fresh: TrackHit[] = []
  try {
    for (const e of all) {
      const since = isoDate(e.lastCheck + 1)
      const found = await queryKeyword(e.keyword, since)
      for (const v of found) {
        const hit: TrackHit = { vnId: v.id, title: v.title, released: v.released ?? '', keyword: e.keyword }
        hits.push(hit)
        if (!e.seenIds.includes(v.id)) fresh.push(hit)
      }
      // 更新 seen：老 + 新（最多留 500 防膨胀），时间推进到今天
      const seen = [...e.seenIds, ...found.map((v) => v.id)]
      e.seenIds = [...new Set(seen)].slice(-500)
      e.lastCheck = Date.now()
    }
    persist()
    return { ok: true, hits, fresh }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}