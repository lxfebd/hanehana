/**
 * touchgal.ink 适配器（Next.js 站点，前置 Cloudflare）。
 *
 * 实测（2026-11-06，经内嵌 webview 真 Chromium 过 CF 后由 CDP 取样）：
 *   列表  GET {HOME}/galgame   → SSR 渲染卡片 <a href="/<8位hex>">，锚点文本含「标题 评分 浏览量 平台 语言」
 *   详情  GET {HOME}/<8hex>    → 详情页；「资源链接」页签由客户端 API 加载，SSR HTML 里没有下载地址
 *   搜索  官方 API（developer.touchgal.com/api/v1/games/search）业务接口需要 API token，
 *         匿名不可调；站内 /search 页是客户端渲染，SSR 骨架无结果。
 *
 * 因此：
 *   - search 走「列表页 SSR 卡片 + 标题过滤」（真实可解析，不猜接口）；
 *   - mirrors 诚实说明：资源链接在站内客户端加载，请在内嵌浏览器里点（会被捕获桥自动接住）。
 * 站点有多个镜像域（.ink/.com/.co/.io/.me/.moe/.net/.one/.org/.us）与资源 CDN cloud.touchgaloss.com，
 * 全部归入 hosts——内嵌浏览器里点任意镜像域的下载，都会被 siteIdForUrl 认回 touchgal。
 */
import type { SiteMirrorOutcome, SiteSearchOutcome, SiteSearchResult } from '../../shared/sites'
import { extractTitle, fetchText, httpFailureMessage, networkLayerHint, withRetry } from './http'

export const SITE_ID = 'touchgal'
const HOME = 'https://www.touchgal.ink'

/** 详情/卡片路径是 8 位小写 hex 短哈希，如 /bf4abf5a。 */
const CARD_HREF_RE = /^\/[0-9a-f]{8}$/

// --------------------------------------------------------------- 搜索

export async function search(keyword: string): Promise<SiteSearchOutcome> {
  const kw = keyword.trim().toLowerCase()
  try {
    const r = await withRetry(() => fetchText(`${HOME}/galgame`))
    const http = httpFailureMessage(r)
    if (http) return { ok: false, siteId: SITE_ID, message: `TouchGAL ${http}` }
    const all = parseCards(r.text)
    if (!all.length) {
      return {
        ok: false,
        siteId: SITE_ID,
        message: `列表页（HTTP ${r.status}，${r.text.length} 字节）解析不出卡片——可能仍被 Cloudflare 拦截（先在内嵌浏览器里打开一次该站）或列表结构已改版。`,
      }
    }
    const results = kw ? all.filter((x) => x.title.toLowerCase().includes(kw) || (x.info || '').toLowerCase().includes(kw)) : all
    if (kw && !results.length) {
      return {
        ok: true,
        siteId: SITE_ID,
        results: [],
        message: `在列表页前 ${all.length} 条中没有匹配「${keyword.trim()}」的标题。TouchGAL 全量搜索是客户端行为，请在内嵌浏览器中使用站内搜索。`,
      }
    }
    return { ok: true, siteId: SITE_ID, results }
  } catch (e) {
    return {
      ok: false,
      siteId: SITE_ID,
      message: `搜索失败：${networkLayerHint(e)}。若内嵌浏览器能打开 touchgal，说明抓取层需要先在内嵌浏览器里逛一次以通过 Cloudflare 校验。`,
    }
  }
}

/**
 * 解析列表页 SSR 卡片：<a href="/<8hex>">…</a>。
 * 锚点文本形如「はぴねす！ 浏览量 1.7w PC 中文」「誰ソ彼の… 评分 5.6 浏览量 5.6w PC 中文」，
 * 把「 浏览量/评分」之前的部分当标题，其余放 info（平台/语言/热度）。
 */
export function parseCards(html: string): SiteSearchResult[] {
  const out: SiteSearchResult[] = []
  const seen = new Set<string>()
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const href = m[1]
    if (!CARD_HREF_RE.test(href)) continue
    const url = `${HOME}${href}`
    if (seen.has(url)) continue
    const raw = stripTags(m[2]).replace(/\s+/g, ' ').trim()
    if (!raw) continue
    seen.add(url)
    let title = raw
    let info = ''
    const bi = raw.search(/\s+(?:浏览量|评分)\s/)
    if (bi > 0) {
      title = raw.slice(0, bi).trim()
      info = raw.slice(bi).trim()
    }
    out.push({ siteId: SITE_ID, title, url, info })
  }
  return out
}

// --------------------------------------------------------------- 详情 → 镜像

export async function mirrors(detailUrl: string): Promise<SiteMirrorOutcome> {
  let title = ''
  try {
    const r = await withRetry(() => fetchText(detailUrl))
    const http = httpFailureMessage(r)
    if (http) return { ok: false, siteId: SITE_ID, message: `TouchGAL ${http}` }
    title = extractTitle(r.text).replace(/\s*-\s*TouchGal\s*$/i, '').trim()
    // SSR 详情页不含下载地址；「资源链接」页签由站内客户端 API（需 token）加载，不做猜测式解析。
    return {
      ok: false,
      siteId: SITE_ID,
      title,
      message:
        'TouchGAL 详情页的资源链接由站内客户端加载（官方 API 需 token），未接入自动解析。请在内嵌浏览器打开该页 →「资源链接」页签点击下载，会被自动捕获建任务。',
    }
  } catch (e) {
    return { ok: false, siteId: SITE_ID, title, message: `解析失败：${networkLayerHint(e)}` }
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}
