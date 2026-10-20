/**
 * 刮削净化规则（零依赖，可独立测试）。
 *
 * 从 scraper.ts 提出：scraper.ts 顶部 import 了 gameStore（含 fs/electron 副作用），
 * 直接 import 会让测试拖起整条依赖链。这里只存「净化 + 白名单」纯逻辑：
 *   - seenCoverHosts：本次会话观察到的 https 封面主机（模块态，纯内存 Set）
 *   - rememberCoverHost：刮削源给过封面 URL 时记录主机（只记 https）
 *   - coverUrlAllowed：封面 URL 能否被下载（https + 见过的域名）
 *   - sanitizeScrapeResult：外部 unknown 数据 → 安全 ScrapeResult 的唯一关口
 */
import type { ScrapeResult } from '../shared/types'

// ---------------------------------------------------------------- 封面 URL 白名单（防 SSRF）

/** 本次会话见过（从站点响应观察过）的 https 封面主机。 */
export const seenCoverHosts = new Set<string>()

/** 只认 https：http 封面会被主进程原样 fetch，明文内容可被中间人篡改成
 * 任意字节写进游戏封面（图像解码层以外的攻击面）。VNDB/Bangumi 的 CDN
 * 全部支持 https，收紧到只记 https 不影响正常刮削。 */
export function rememberCoverHost(url: string | undefined): void {
  if (!url) return
  try {
    const u = new URL(url)
    if (u.protocol === 'https:') seenCoverHosts.add(u.host.toLowerCase())
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

/**
 * 封面 URL 白名单（防 SSRF 的净化边界）：只放行 https 且域名出现在
 * seenCoverHosts（从站点响应里观察过的主机）。导出给测试钉死——
 * 这是渲染层/刮削源不可信 URL 能否被下载的唯一关口。
 */
export function coverUrlAllowed(url: string): boolean {
  try {
    const u = new URL(url)
    // 双层收紧：rememberCoverHost 只记 https，这里再明文拒绝 http——
    // 万一未来有人往 Set 塞了 http 域名，也不能凭它放行明文封面。
    if (u.protocol !== 'https:') return false
    return seenCoverHosts.has(u.host.toLowerCase())
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- 净化

/** 渲染层能提交的刮削字段（白名单）。 */
export function sanitizeScrapeResult(raw: unknown): ScrapeResult | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  const provider = d.provider
  if (provider !== 'vndb' && provider !== 'bangumi' && provider !== 'ymgal') return null
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
    out.tags = d.tags
      .filter((t): t is string => typeof t === 'string')
      .slice(0, 64)
      .map((t) => t.slice(0, 64))
  }
  const developer = str(d.developer, 200)
  if (developer) out.developer = developer
  if (Array.isArray(d.series)) {
    out.series = d.series
      .filter((t): t is string => typeof t === 'string')
      .slice(0, 16)
      .map((t) => t.slice(0, 200))
  }
  if (Array.isArray(d.aliases)) {
    out.aliases = d.aliases
      .filter((t): t is string => typeof t === 'string')
      .slice(0, 32)
      .map((t) => t.slice(0, 200))
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
