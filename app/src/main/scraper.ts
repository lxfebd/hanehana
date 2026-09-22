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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
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
}

async function searchVndb(title: string): Promise<ScrapeCandidate[]> {
  const body = {
    filters: ['search', '=', title],
    fields: 'id,title,alttitle,released,rating,image.url,description,tags.name',
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
  }))
}

// ---------------------------------------------------------------- 对外接口

/**
 * 多源并行搜索。返回 { results, warnings }：
 *   warnings 记录某个源失败的原因（如「Bangumi 连接超时」），
 *   供 UI 提示，不让用户以为搜索结果就是全部。
 */
export async function searchScrape(
  title: string,
): Promise<{ results: ScrapeCandidate[]; warnings: string[] }> {
  const [vndb, bgm] = await Promise.allSettled([searchVndb(title), searchBangumi(title)])

  const results: ScrapeCandidate[] = []
  const warnings: string[] = []
  if (vndb.status === 'fulfilled') results.push(...vndb.value)
  else warnings.push(`VNDB：${reasonText(vndb.reason)}`)

  if (bgm.status === 'fulfilled') results.push(...bgm.value)
  else warnings.push(`Bangumi：${reasonText(bgm.reason)}`)

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

/** 应用刮削结果：更新游戏字段 + 下载封面到本地缓存。 */
export async function applyScrape(gameId: string, r: ScrapeResult): Promise<{ ok: boolean; error?: string }> {
  const g = getGame(gameId)
  if (!g) return { ok: false, error: '游戏不在库中' }

  try {
    let coverPath: string | undefined
    if (r.coverUrl) {
      coverPath = await downloadCover(r.provider, r.id, r.coverUrl)
    }
    const tagSet = new Set([...(g.tags ?? []), ...(r.tags ?? [])])
    updateGame(gameId, {
      title: r.title || g.title,
      titleNative: r.titleNative,
      description: r.description,
      releaseDate: r.releaseDate,
      rating: r.rating,
      coverPath,
      color: coverPath ? coverColorOf(coverPath) : undefined,
      tags: [...tagSet],
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
    const file = `${provider}-${id.replace(/[^a-z0-9]/gi, '')}.${ext}`
    const dest = join(dir, file)
    if (existsSync(dest)) return dest
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT) })
    if (!r.ok) return undefined
    const buf = Buffer.from(await r.arrayBuffer())
    writeFileSync(dest, buf)
    return dest
  } catch (e) {
    console.error('[hanehana] 封面下载失败：', e)
    return undefined
  }
}
