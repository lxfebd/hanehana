/**
 * 元数据刮削器 —— adapter 多源架构（业界共识）。
 *
 * VNDB 主源 + Bangumi 备源。单源失败不中断整体：某个源超时/被墙时
 * 只缺那一列结果，其余源照常返回。封面图下载到本地 covers/ 缓存，
 * 后续展示不依赖网络。
 *
 * 实测（2026-09-22）：
 *   - VNDB v2：POST https://api.vndb.org/kana/vn，body={filters,fields,page,results}
 *     filters: ['search','=',title]，fields: id,title,alttitle,released,rating,image.url,description,tags.name
 *     封面 CDN 在 t.vndb.org
 *   - Bangumi：POST https://api.bgm.tv/v0/search/subjects，body={keyword,filter:{type:[4]}}
 *     封面在 images.large；本机当前连不上 api.bgm.tv（超时），会静默缺源
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureCoversDir, getGame, updateGame } from './gameStore'
import { coverColorOf } from './coverColor'
import { ensureThumb } from './thumbs'
import type { ScrapeResult, ScrapeCandidate } from '../shared/types'

const UA = 'HaneHana/0.1 (galgame manager; contact: lxfebd)'
const TIMEOUT = 12000

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const r = await fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

// ---------------------------------------------------------------- VNDB

interface VndbVN {
  id: string
  title: string
  alttitle?: string
  released?: string
  rating?: number
  description?: string
  image?: { url: string }
  tags?: { id: string; name: string }[]
  /** VNDB v2 的 developers 是关联结构（开发厂商） */
  developers?: { developer?: { name?: string } }[]
  /** VNDB v2 的 relations 是关联结构（前作/续作/系列/外传） */
  relations?: { relation?: string; vn?: { id?: string; title?: string } }[]
  aliases?: { alias?: string }[]
  /** VNDB v2 length_minutes 是可选数字 */
  length_minutes?: number
}

async function searchVndb(title: string): Promise<ScrapeCandidate[]> {
  const body = {
    filters: ['search', '=', title],
    fields: 'id,title,alttitle,released,rating,image.url,description,tags.name,developers.developer.name,relations.relation,relations.vn.title,aliases.alias,length_minutes',
    sort: 'id',
    page: 1,
    results: 8,
  }
  const j = (await fetchJson('https://api.vndb.org/kana/vn', {
    method: 'POST',
    body: JSON.stringify(body),
  })) as { results: VndbVN[] }
  return (j.results ?? []).map((v) => ({
    provider: 'vndb' as const,
    id: v.id,
    title: v.title,
    titleNative: v.alttitle,
    description: v.description,
    releaseDate: v.released,
    rating: v.rating ? v.rating / 10 : undefined,
    coverUrl: v.image?.url,
    tags: (v.tags ?? []).slice(0, 12).map((t) => t.name),
    developer: v.developers?.find((d) => d.developer?.name)?.developer?.name,
    series: (v.relations ?? [])
      .filter((r) => r.relation === 'seq' || r.relation === 'series' || r.relation === 'side story' || r.relation === 'fan disc')
      .map((r) => r.vn?.title)
      .filter((t): t is string => !!t)
      .slice(0, 8),
    aliases: (v.aliases ?? []).map((a) => a.alias).filter((a): a is string => !!a).slice(0, 12),
    lengthMinutes: v.length_minutes,
  }))
}

// ---------------------------------------------------------------- Bangumi

interface BgmSubject {
  id: number
  name: string
  name_cn?: string
  date?: string
  summary?: string
  rating?: { score: number }
  images?: { large?: string; medium?: string; small?: string }
  /** Bangumi 制作方（发行/制作公司） */
  producers?: { id?: number; name?: string }[]
}

async function searchBangumi(title: string): Promise<ScrapeCandidate[]> {
  const j = (await fetchJson('https://api.bgm.tv/v0/search/subjects', {
    method: 'POST',
    body: JSON.stringify({ keyword: title, filter: { type: [4] }, limit: 8 }),
  })) as { data?: BgmSubject[] }
  return (j.data ?? []).map((s) => ({
    provider: 'bangumi' as const,
    id: String(s.id),
    title: s.name_cn || s.name,
    titleNative: s.name_cn ? s.name : undefined,
    description: s.summary,
    releaseDate: s.date,
    rating: s.rating?.score,
    coverUrl: s.images?.large ?? s.images?.medium,
    developer: (s.producers ?? []).find((p) => p?.name)?.name,
    lengthMinutes: undefined,
  }))
}

// ---------------------------------------------------------------- 对外接口

/**
 * 多源并行搜索。返回 { results, warnings }：
 *   warnings 记录某个源失败的原因（如「Bangumi 连接超时」），
 *   供 UI 提示，不让用户以为搜索结果就是全部。
 */
/**
 * 测试缝：HANEHANA_SCRAPE_MOCK_FILE 指向 JSON。
 * 形状 `{ [query: string]: ScrapeCandidate[] }`，键按 query 精确命中；
 * 未命中返回空结果。仅验收脚本设，生产不设（与 tracking 的 VNDB_MOCK 同约定）。
 */
function scrapeMock(title: string): { results: ScrapeCandidate[]; warnings: string[] } | null {
  const f = process.env.HANEHANA_SCRAPE_MOCK_FILE
  if (!f) return null
  try {
    const map = JSON.parse(readFileSync(f, 'utf8')) as Record<string, ScrapeCandidate[]>
    return { results: map[title] ?? [], warnings: [] }
  } catch {
    return null
  }
}

export async function searchScrape(
  title: string,
): Promise<{ results: ScrapeCandidate[]; warnings: string[] }> {
  const mock = scrapeMock(title)
  if (mock) {
    for (const c of mock.results) rememberCoverHost(c.coverUrl)
    return mock
  }
  const [vndb, bgm] = await Promise.allSettled([searchVndb(title), searchBangumi(title)])

  const results: ScrapeCandidate[] = []
  const warnings: string[] = []
  if (vndb.status === 'fulfilled') results.push(...vndb.value)
  else warnings.push(`VNDB：${reasonText(vndb.reason)}`)

  if (bgm.status === 'fulfilled') results.push(...bgm.value)
  else warnings.push(`Bangumi：${reasonText(bgm.reason)}`)

  // 发出去的封面域名记下来，applyScrape 只认这些（见 seenCoverHosts）
  for (const c of results) rememberCoverHost(c.coverUrl)

  return { results, warnings }
}

function reasonText(e: unknown): string {
  if (e instanceof Error) {
    const m = e.message
    if (m.includes('timeout') || m.includes('abort')) return '连接超时'
    return m
  }
  return String(e)
}

// ---------------------------------------------------------------- 应用刮削结果

/**
 * 本次搜索发出过的封面域名。
 *
 * 为什么需要它：applyScrape 的 coverUrl 来自渲染层，直接 fetch 就是 SSRF——
 * 填一个 http://169.254.169.254/ 或 http://127.0.0.1:8080/ 就能让主进程替
 * 攻击者去敲内网。只认「我们自己搜出来给过界面」的域名，等于把出口锁死在
 * VNDB / Bangumi 的 CDN 上，正常用户一个都不会被拦。
 */
const seenCoverHosts = new Set<string>()

function rememberCoverHost(url: string | undefined): void {
  if (!url) return
  try {
    const u = new URL(url)
    if (u.protocol === 'https:' || u.protocol === 'http:') seenCoverHosts.add(u.host.toLowerCase())
  } catch {
    // 非法 URL 不记，applyScrape 那边自然会被拒
  }
  // 无上限的 Set 会随搜索次数一直长。真实域名就几个，超了清掉最老的。
  if (seenCoverHosts.size > 128) {
    for (const k of seenCoverHosts) {
      seenCoverHosts.delete(k)
      if (seenCoverHosts.size <= 64) break
    }
  }
}

/** 这个封面 URL 是不是本次搜索发出过的。 */
function coverUrlAllowed(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    return seenCoverHosts.has(u.host.toLowerCase())
  } catch {
    return false
  }
}

/** 封面下载上限。galgame 封面是几百 KB 量级，给到 16 MB 已经足够宽。 */
const MAX_COVER_BYTES = 16 * 1024 * 1024

/** 渲染层能提交的刮削字段（白名单）。 */
export function sanitizeScrapeResult(raw: unknown): ScrapeResult | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  const provider = d.provider
  if (provider !== 'vndb' && provider !== 'bangumi') return null
  const id = typeof d.id === 'string' ? d.id.trim().slice(0, 64) : ''
  const title = typeof d.title === 'string' ? d.title.slice(0, 500) : ''
  if (!id || !title) return null
  const str = (v: unknown, max: number): string | undefined =>
    typeof v === 'string' && v ? v.slice(0, max) : undefined
  const out: ScrapeResult = { provider, id, title }
  const titleNative = str(d.titleNative, 500)
  if (titleNative) out.titleNative = titleNative
  const description = str(d.description, 20000)
  if (description) out.description = description
  const releaseDate = str(d.releaseDate, 32)
  if (releaseDate) out.releaseDate = releaseDate
  if (typeof d.rating === 'number' && Number.isFinite(d.rating)) {
    out.rating = Math.min(10, Math.max(0, d.rating))
  }
  if (Array.isArray(d.tags)) {
    out.tags = d.tags.filter((t): t is string => typeof t === 'string').slice(0, 64).map((t) => t.slice(0, 64))
  }
  const developer = str(d.developer, 200)
  if (developer) out.developer = developer
  if (Array.isArray(d.series)) {
    out.series = d.series.filter((t): t is string => typeof t === 'string').slice(0, 16).map((t) => t.slice(0, 200))
  }
  if (Array.isArray(d.aliases)) {
    out.aliases = d.aliases.filter((t): t is string => typeof t === 'string').slice(0, 32).map((t) => t.slice(0, 200))
  }
  if (typeof d.lengthMinutes === 'number' && Number.isFinite(d.lengthMinutes)) {
    out.lengthMinutes = Math.min(100000, Math.max(0, Math.floor(d.lengthMinutes)))
  }
  const coverUrl = str(d.coverUrl, 2000)
  if (coverUrl) {
    // 不在白名单里就当没有封面：元数据其余部分照旧写入，而不是整条失败。
    if (!coverUrlAllowed(coverUrl)) {
      console.error('[hanehana] 拒绝抓取白名单外的封面地址：', coverUrl.slice(0, 200))
    } else {
      out.coverUrl = coverUrl
    }
  }
  return out
}

/** 应用刮削结果：更新游戏字段 + 下载封面到本地缓存。 */
export async function applyScrape(gameId: string, raw: unknown): Promise<{ ok: boolean; error?: string }> {
  const g = getGame(gameId)
  if (!g) return { ok: false, error: '游戏不在库中' }
  const r = sanitizeScrapeResult(raw)
  if (!r) return { ok: false, error: '刮削结果不完整：需要来源、id 与标题' }

  try {
    let coverPath: string | undefined
    if (r.coverUrl) {
      coverPath = await downloadCover(r.provider, r.id, r.coverUrl)
    }
    const tagSet = new Set([...(g.tags ?? []), ...(r.tags ?? [])])
    // manualEdit 标记过手填的字段，刮削不再覆盖（用户手改优先于站点数据）
    const manual = g.manualEdit === true
    updateGame(gameId, {
      title: manual && g.title ? g.title : r.title || g.title,
      titleNative: manual && g.titleNative ? g.titleNative : r.titleNative,
      description: manual && g.description ? g.description : r.description,
      releaseDate: manual && g.releaseDate ? g.releaseDate : r.releaseDate,
      rating: manual && g.rating ? g.rating : r.rating,
      coverPath,
      color: coverPath ? coverColorOf(coverPath) : undefined,
      tags: [...tagSet],
      developer: manual && g.developer ? g.developer : r.developer,
      series: manual && g.series ? g.series : r.series,
      aliases: manual && g.aliases ? g.aliases : r.aliases,
      lengthMinutes: manual && g.lengthMinutes ? g.lengthMinutes : r.lengthMinutes,
      sources: [...(g.sources ?? []).filter((s) => s.provider !== r.provider), { provider: r.provider, id: r.id }],
    })
    // 封面换了就同步生成缩略图（失败不致命，UI 走占位色）
    if (coverPath) await ensureThumb(getGame(gameId)!)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 下载封面到 covers/{provider}-{id}.jpg，失败不致命（无封面也能用）。 */
async function downloadCover(provider: string, id: string, url: string): Promise<string | undefined> {
  try {
    const dir = ensureCoversDir()
    const ext = /\.png$/i.test(url) ? 'png' : 'jpg'
    // id 来自渲染层，直接拼进文件名就是路径穿越（../../）。只留字母数字。
    const safeId = id.replace(/[^a-z0-9]/gi, '').slice(0, 32)
    if (!safeId) return undefined
    const dest = join(dir, `${provider}-${safeId}.${ext}`)
    if (existsSync(dest)) return dest
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT) })
    if (!r.ok) return undefined
    const buf = await readBodyCapped(r, MAX_COVER_BYTES)
    if (!buf) {
      console.error('[hanehana] 封面超过大小上限，已丢弃：', url.slice(0, 200))
      return undefined
    }
    writeFileSync(dest, buf)
    return dest
  } catch (e) {
    console.error('[hanehana] 封面下载失败：', e)
    return undefined
  }
}

/**
 * 读响应体，超过上限就放弃（返回 null）。
 *
 * 不能先 arrayBuffer() 再判断大小：一个谎报 Content-Length 的服务器能让主进程
 * 把任意大的东西读进内存，而主进程 OOM 是整个应用一起死。
 */
async function readBodyCapped(r: Response, max: number): Promise<Buffer | null> {
  const body = r.body
  if (!body) return Buffer.alloc(0)
  const declared = Number(r.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > max) return null
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}
