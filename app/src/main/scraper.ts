/**
 * 元数据刮削器 —— adapter 多源架构（业界共识）。
 *
 * VNDB 主源 + Bangumi 备源。单源失败不中断整体：某个源超时/被墙时
 * 只缺那一列结果，其余源照常返回。封面图下载到本地 covers/ 缓存，
 * 后续展示不依赖网络。
 *
 * 实测（2026-09-22）：
 *   - VNDB v2：POST https://api.vndb.org/kana/vn，body={filters,fields,page,results}
 *     filters: ['search','=',title]；fields 里每个字段名必须全对——错一个整条
 *     400 且响应体为空。2026-10-11 已按实测修正（developers.name / relations.* /
 *     aliases、不传 sort，逐字段二分过程见 searchVndb 内注释）。封面 CDN 在 t.vndb.org
 *   - Bangumi：POST https://api.bgm.tv/v0/search/subjects，body={keyword,filter:{type:[4]}}
 *     封面在 images.large；本机当前连不上 api.bgm.tv（超时），会静默缺源
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureCoversDir, getGame, updateGame } from './gameStore'
import { coverColorOf } from './coverColor'
import { coverQualityOk } from './coverQuality'
import { ensureThumb } from './thumbs'
import { rememberCoverHost, sanitizeScrapeResult } from './scrapeRules'
import { queryLadder } from './scrapeQuery'
import type { Game, ScrapeCandidate } from '../shared/types'

const UA = 'HaneHana/0.1 (galgame manager; contact: lxfebd)'
const TIMEOUT = 12000

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const r = await fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!r.ok) {
    // 错误体里有服务端给的真实原因（VNDB 400 会说哪个字段/过滤器不对），
    // 只抛 HTTP 状态码等于把线索扔掉——warnings 里只剩一句「HTTP 400」，
    // 用户和排查的人都不知道发生了什么。
    let detail = ''
    try {
      const t = await r.text()
      detail = t.slice(0, 300)
      try {
        const j = JSON.parse(t) as { error?: string; message?: string }
        detail = j.error || j.message || detail
      } catch {
        /* 非 JSON 就用原文 */
      }
    } catch {
      /* 读不到就只报状态码 */
    }
    throw new Error(detail ? `HTTP ${r.status}：${detail}` : `HTTP ${r.status}`)
  }
  // 2xx 但空体/非 JSON（代理或 CDN 回了个怪东西）：r.json() 会抛裸 SyntaxError，
  // 进 warnings 又变一句没人看得懂的英文——报清楚状态。
  try {
    return await r.json()
  } catch {
    throw new Error(`HTTP ${r.status}：响应不是 JSON`)
  }
}

// ---------------------------------------------------------------- 按源搜索 + 熔断

/**
 * 网络熔断器（per-source）：连续失败后一段时间内直接短路返回「熔断」，
 * 不再发出真实请求。为什么需要：Bangumi 在当前网络下固定 12s 超时，每次
 * 刮削 UI 都要空转等满最慢源（Promise.allSettled 两源齐回才返回）。
 * 熔断后这一源立即返回，另一源正常出结果——UI 体感从「卡 12 秒」变「秒出」。
 *
 * 熔断窗口内仍计失败（保持熔断），窗口过后清除计数进入探测期（允许一次
 * 真实请求验证恢复）。按 key（源名）隔离，互不拖累。
 */
interface Breaker {
  failures: number
  openUntil: number
  openAfter: number
  windowMs: number
}

const breakers: Record<string, Breaker> = {}

function breakerFor(key: string): Breaker {
  if (!breakers[key]) {
    breakers[key] = { failures: 0, openUntil: 0, openAfter: 2, windowMs: 60_000 }
  }
  return breakers[key]
}

/** 是否熔断中。是 → 该源直接短路失败，不发起请求。 */
function isBreakerOpen(key: string): boolean {
  const b = breakerFor(key)
  const now = Date.now()
  if (b.openUntil > now) {
    b.failures++ // 窗口内仍算失败，保持熔断直到窗口结束
    return true
  }
  if (b.openUntil !== 0 && now >= b.openUntil) {
    // 窗口已过：清零进入探测期，允许一次真实请求验证恢复
    b.failures = 0
    b.openUntil = 0
  }
  return false
}

function breakerSuccess(key: string): void {
  const b = breakerFor(key)
  b.failures = 0
  b.openUntil = 0
}

function breakerFail(key: string): void {
  const b = breakerFor(key)
  b.failures++
  if (b.failures >= b.openAfter) b.openUntil = Date.now() + b.windowMs
}

function breakerMessage(key: string): string {
  const b = breakerFor(key)
  if (b.openUntil > Date.now()) {
    return `${key} 连续失败已暂停（${Math.ceil((b.openUntil - Date.now()) / 1000)} 秒后重试）`
  }
  return `${key} 搜索失败`
}

/**
 * 单源搜索（G20）：带熔断 + 搜索词清洗梯。失败抛中文错误，成功时记住封面域名供 apply 白名单。
 *
 * 为什么要清洗梯（实测 2026-10-16 打 VNDB search）：VNDB 的 search 是精确标题匹配，
 * galgame 目录名带【汉化组】/[DL版]/（中文版）/尾缀一律 0 命中——「批量刮削什么都没发生」
 * 就是这个。做法：原词先搜（干净标题一发命中，不多花请求）；只有 0 结果才按 queryLadder
 * 逐级放宽（剥括号→剥版本尾缀→截主标题→逐词裁剪），第一个非空即返回。
 * 注意「空结果」不是错误：继续下一候选；真正的网络/HTTP 错误则立即抛出并计熔断——
 * 源不通时换词重试没意义（也避免把已挂的 Bangumi 按候选数翻倍打超时）。
 */
export async function searchSource(
  source: 'vndb' | 'bangumi',
  title: string,
): Promise<{ results: ScrapeCandidate[]; warnings: string[] }> {
  if (isBreakerOpen(source)) {
    // 熔断中：直接短路，UI 立即看到原因，不发起请求
    return { results: [], warnings: [breakerMessage(source)] }
  }
  const search = source === 'vndb' ? searchVndb : searchBangumi
  const ladder = queryLadder(title)
  for (const q of ladder) {
    try {
      const results = await search(q)
      // 通了就清失败计数（哪怕这条词 0 结果——源是活的，只是这个词没命中）
      breakerSuccess(source)
      if (results.length) {
        for (const c of results) rememberCoverHost(c.coverUrl)
        return { results, warnings: [] }
      }
      // 0 结果：源活着但这个词搜不到，放宽到下一个更干净的候选词
    } catch (e) {
      breakerFail(source)
      // { cause: e } 保留原始错误链：调试时能看到超时/DNS 失败的底层原因
      throw new Error(reasonText(e), { cause: e })
    }
  }
  // 所有候选词都空手而归：正常返回空结果（不报错，UI 显示「没找到」）
  return { results: [], warnings: [] }
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
  /** developers 展开字段 developers.name 返回扁平 [{id,name}]（2026-10-11 实测） */
  developers?: { id?: string; name?: string }[]
  /** relations 合法展开是 relations.relation / relations.title；relations.vn.* 不存在，一写就 400 */
  relations?: { relation?: string; title?: string }[]
  /** aliases 是字符串数组（兼容个别返回 {alias} 的老结构） */
  aliases?: (string | { alias?: string })[]
  /** VNDB v2 length_minutes 是可选数字 */
  length_minutes?: number
}

async function searchVndb(title: string): Promise<ScrapeCandidate[]> {
  // fields 串里每个字段名都必须是 VNDB 认识的：错一个整条查询就 400，而且
  // VNDB 的 400 响应体经常是空的，症状只剩 warnings 里一句「HTTP 400」——
  // 旧串三个坏字段（developers.developer.name / relations.vn.title /
  // aliases.alias）+ 非法 sort:'id'，等于 VNDB 源从未工作过。
  // 2026-10-11 逐字段二分实测：developers.name / relations.title /
  // aliases / 无 sort 全部 200 且带封面。sort 默认即按 id 排，不传。
  const body = {
    filters: ['search', '=', title],
    fields:
      'id,title,alttitle,released,rating,image.url,description,tags.name,developers.name,relations.relation,relations.title,aliases,length_minutes',
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
    developer: (v.developers ?? []).find((d) => !!d.name)?.name,
    // 关系码实测（2026-10-11 打 Muv-Luv/Fate 逐条核对）：seq 同系列续作、
    // set 合集、side 外传、fan 同人、preq 前作、orig 原作、char 登场作。
    // 旧过滤串里的 'series'/'side story'/'fan disc' 三个码在 VNDB 不存在，
    // 只有 seq 能命中——合集/外传/同人全被丢。series 只收这四种「系列向」码。
    series: (v.relations ?? [])
      .filter((x) => x.relation === 'seq' || x.relation === 'set' || x.relation === 'side' || x.relation === 'fan')
      .map((x) => x.title)
      .filter((t): t is string => !!t)
      .slice(0, 8),
    aliases: (v.aliases ?? [])
      .map((a) => (typeof a === 'string' ? a : a?.alias))
      .filter((a): a is string => !!a)
      .slice(0, 12),
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

/**
 * 多源并行搜索。返回 { results, warnings }：
 *   warnings 记录某个源失败的原因（如「Bangumi 连接超时」），
 *   供 UI 提示，不让用户以为搜索结果就是全部。
 */
export async function searchScrape(title: string): Promise<{ results: ScrapeCandidate[]; warnings: string[] }> {
  const mock = scrapeMock(title)
  if (mock) {
    for (const c of mock.results) rememberCoverHost(c.coverUrl)
    return mock
  }
  const [vndb, bgm] = await Promise.allSettled([searchSource('vndb', title), searchSource('bangumi', title)])

  const results: ScrapeCandidate[] = []
  const warnings: string[] = []
  // searchSource 返回 { results, warnings }（熔断短路时 results 为空、warnings 说明原因）
  if (vndb.status === 'fulfilled') {
    results.push(...vndb.value.results)
    warnings.push(...vndb.value.warnings)
  } else warnings.push(`VNDB：${reasonText(vndb.reason)}`)

  if (bgm.status === 'fulfilled') {
    results.push(...bgm.value.results)
    warnings.push(...bgm.value.warnings)
  } else warnings.push(`Bangumi：${reasonText(bgm.reason)}`)

  // 发出去的封面域名记下来，applyScrape 只认这些（见 seenCoverHosts）
  for (const c of results) rememberCoverHost(c.coverUrl)

  return { results, warnings }
}

function reasonText(e: unknown): string {
  if (e instanceof Error) {
    const m = e.message
    if (m.includes('timeout') || m.includes('abort')) return '连接超时'
    // fetch 的底层错误（fetch failed / ENOTFOUND / ECONNREFUSED…）直接进 UI
    // 是一串英文，用户看不懂原因——归成中文，底层细节（e.cause）跟在括号里。
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|getaddrinfo|socket hang up|network/i.test(m)) {
      const c = (e as { cause?: unknown }).cause
      const detail = c instanceof Error ? c.message : c ? String(c) : ''
      return detail ? `网络不可达（${detail.slice(0, 120)}）` : '网络不可达'
    }
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
/** 封面下载上限。galgame 封面是几百 KB 量级，给到 16 MB 已经足够宽。 */
const MAX_COVER_BYTES = 16 * 1024 * 1024

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
    const patch: Partial<Game> = {
      title: manual && g.title ? g.title : r.title || g.title,
      tags: [...tagSet],
      sources: [...(g.sources ?? []).filter((s) => s.provider !== r.provider), { provider: r.provider, id: r.id }],
    }
    // 可选元数据只在新值存在时才写。旧写法把这些键无条件放进 patch，站点没给
    // 的字段就是 undefined——Object.assign 拿 undefined 直接覆盖，等于一次不带
    // 某字段的刮削（如 Bangumi 没有 series/aliases/lengthMinutes）就能把上一源
    // 刮来的对应字段全清空，与「无封面刮削清封面」是同一类 bug。
    const put = <K extends keyof Game>(k: K, v: Game[K] | undefined): void => {
      if (v !== undefined) patch[k] = v
    }
    put('titleNative', manual && g.titleNative ? g.titleNative : r.titleNative)
    put('description', manual && g.description ? g.description : r.description)
    put('releaseDate', manual && g.releaseDate ? g.releaseDate : r.releaseDate)
    put('rating', manual && g.rating ? g.rating : r.rating)
    put('developer', manual && g.developer ? g.developer : r.developer)
    put('series', manual && g.series ? g.series : r.series)
    put('aliases', manual && g.aliases ? g.aliases : r.aliases)
    put('lengthMinutes', manual && g.lengthMinutes ? g.lengthMinutes : r.lengthMinutes)
    // 封面只在真下到合格图时才写。没有 coverUrl（源没给）或下载失败时
    // 不碰这两个字段——旧写法无条件传 coverPath: undefined，一次不带封面的
    // 刮削就能把已有封面连 color 一起清空（刮完封面消失，正是「封面不出」的帮凶）。
    if (coverPath) {
      patch.coverPath = coverPath
      patch.color = coverColorOf(coverPath) ?? g.color
    }
    updateGame(gameId, patch)
    // 封面换了就同步生成缩略图（失败不致命，UI 走占位色）。
    // 并发下游戏可能已被删：updateGame 对不存在的 id 是 no-op，这里现取一次，
    // 不用非空断言——取不到就跳过，已落盘的封面成无主缓存文件，无害。
    if (coverPath) {
      const fresh = getGame(gameId)
      if (fresh) await ensureThumb(fresh)
    }
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
    // 缓存命中也要过质量闸：老版本可能已把废图（源站错误页/占位图）写进了
    // covers/，直接复用等于把 bug 永久化。不合格就删掉重下。
    if (existsSync(dest)) {
      if (coverQualityOk(dest)) return dest
      try {
        unlinkSync(dest)
      } catch {
        return undefined // 删不掉就别再引用它，宁可没封面
      }
    }
    const r = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(TIMEOUT),
      // 不跟随重定向：白名单只校验了源站 host，默认 redirect 会让主进程替
      // 攻击者 fetch 任意重定向目标（白名单域名被攻破/配错时 = 间接 SSRF）。
      // 3xx 一律拒绝，封面不存在可重试路径。
      redirect: 'manual',
    })
    if (!r.ok) return undefined
    const buf = await readBodyCapped(r, MAX_COVER_BYTES)
    if (!buf) {
      console.error('[hanehana] 封面超过大小上限，已丢弃：', url.slice(0, 200))
      return undefined
    }
    writeFileSync(dest, buf)
    // 质量闸：解码失败（HTML 错误页冒充图片）、几何异常、近纯色占位图
    // 一律拒绝并删除——废图进库就是「封面墙上一块黑」的老路。
    if (!coverQualityOk(dest)) {
      try {
        unlinkSync(dest)
      } catch {
        /* 删不掉也绝不引用 */
      }
      console.error('[hanehana] 封面质量不合格，已丢弃：', url.slice(0, 200))
      return undefined
    }
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
