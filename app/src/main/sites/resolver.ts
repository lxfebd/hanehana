/**
 * 镜像解析器：把「网盘分享页 / gofile 文件夹」解析成可下载的直链。
 *
 * FastDrop 的 Rust 引擎只吃 HTTP/HTTPS 直链（预签名 URL 最理想，不需要
 * Cookie）。这里把能解析的尽量解析出来，解析不了的返回 page 镜像让用户在
 * webview 里手动处理。
 *
 * 实测结论（2026-09-10，全部联网验证）：
 * - gofile 文件夹 API 需要 guest token，但测试到的文件夹返回 error-notPremium，
 *   解析失败时回退为页面链接。
 * - pan.nekogal.top 是 Cloudreve v4，匿名 API 已完全打通：
 *     GET  /share/info/{id}                        分享信息
 *     GET  /file?uri=cloudreve://{id}@share        列目录（type 1=目录 0=文件）
 *     POST /file/url {uris:[path], download:true}  S3 预签名直链（约 1 小时有效）
 *   直链带 AWS4-HMAC-SHA256 签名，无需 Cookie/Referer，且支持 Range 分片
 *   （实测 HEAD 200 + accept-ranges: bytes，GET Range 0-1023 返回 206），
 *   可以直接喂给 Rust 引擎。
 */
import type { Mirror, ResolvedFile, ResolveOutcome } from '../../shared/sites'
import { fetchText, getJson, httpFailureMessage, networkLayerHint, parseJson } from './http'

/** 常见网盘域名。命中这些的镜像无法转直链，返回明确提示。 */
const PAN_HOSTS = [
  'pan.baidu.com',
  'pan.quark.cn',
  'pan.xunlei.com',
  'www.123pan.com',
  'www.123684.com',
  'www.aliyundrive.com',
  'www.alipan.com',
  'mega.nz',
  'drive.google.com',
]

export async function resolveMirror(m: Mirror): Promise<ResolveOutcome> {
  if (m.kind === 'direct' || m.kind === 'torrent') {
    return { ok: true, url: m.url, filename: filenameFromUrl(m.url) }
  }
  if (m.kind === 'gofile') return resolveGofile(m)
  if (m.kind === 'cloudreve' || /pan\.nekogal\.top/i.test(m.url)) return resolveCloudreve(m)
  const host = hostOf(m.url)
  if (host && PAN_HOSTS.some((h) => host === h || host.endsWith('.' + h))) {
    return {
      ok: false,
      message: `${m.name} 需要登录/App 才能下载，FastDrop 无法直接解析。请在游戏页签的浏览器里打开它。`,
    }
  }
  return { ok: false, message: '该链接不是可直接下载的文件地址，请在浏览器里打开。' }
}

// --------------------------------------------------------------- gofile

/**
 * gofile 的 API：POST /accounts 拿 guest token → GET /contents/{id}?wt={token}
 * 列文件 → 文件有 direct link。测试到的文件夹返回 error-notPremium，
 * 说明该文件夹被设为 premium-only。能解析时返回直链，否则回退页面链接。
 */
async function resolveGofile(m: Mirror): Promise<ResolveOutcome> {
  const id = /gofile\.io\/d\/([A-Za-z0-9]+)/i.exec(m.url)?.[1]
  if (!id) return { ok: false, message: '无法识别 gofile 文件夹 ID。' }
  try {
    let token: string | undefined
    for (const method of ['GET', 'POST'] as const) {
      const r = await fetchText('https://api.gofile.io/accounts', { method, headers: { accept: 'application/json' } })
      const j = (r.ok ? parseJson(r.text) : null) as { data?: { token?: string } } | null
      if (j?.data?.token) {
        token = j.data.token
        break
      }
    }
    if (!token) return { ok: false, message: '无法获取 gofile 匿名 token。请在浏览器里打开。', mirrors: [m] }

    const content = (await getJson(`https://api.gofile.io/contents/${id}?wt=${token}`)) as {
      status?: string
      data?: { children?: Record<string, { name?: string; link?: string; type?: string }> }
    } | null
    if (content?.status === 'ok' && content.data?.children) {
      const files = Object.values(content.data.children)
        .filter((k) => k.type === 'file' && k.link)
        .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', undefined, { numeric: true }))
      if (files.length) {
        const resolved = files.map((f) => ({
          url: f.link!,
          filename: f.name ?? filenameFromUrl(f.link!),
        }))
        return resolved.length === 1
          ? { ok: true, url: resolved[0].url, filename: resolved[0].filename }
          : { ok: true, files: resolved }
      }
    }
    return { ok: false, message: 'gofile 文件夹需要 premium 或未公开，请在浏览器里打开。', mirrors: [m] }
  } catch (e) {
    return { ok: false, message: `gofile API 访问失败：${reason(e)}。请在浏览器里打开。`, mirrors: [m] }
  }
}

// --------------------------------------------------------------- Cloudreve v4

/**
 * 网盘 API 基址。FD_CLOUDREVE_BASE 用来把解析层指向本地假 Cloudreve（联调 /
 * 离线回归，大分享的计数只有像满量列目录这种路径才测得出）；不设置就是真实
 * 分享域名。这条链全程匿名、不带任何 Cookie，所以指错地址也泄露不了登录态。
 */
const CR_BASE = process.env.FD_CLOUDREVE_BASE ?? 'https://pan.nekogal.top/api/v4'

/**
 * 一次分享解析的收尾播报。
 *
 * 解析层现在不截断：分享里列出的每个文件都进了 resolved，入队节奏交给调用方
 * （渲染层逐个建任务，Manager 自带排队与 max_concurrent）。这里只负责把
 * 「到底全到了没有」说清楚——历史上这几行正是「吞掉信息」的老毛病：
 * 拿一句「还有 N 个文件未加入」把缺件包装成可接受提示，用户到解压才发现。
 * 所以文案反过来写：
 * - 全部换到直链，才允许说「已全部加入队列」；
 * - 换直链失败的那几个（failed）必须点名数量，一个都不许静默消失。
 * missing 是给渲染层的机器可读计数（决定要不要把分享页摊回浏览器），别让它去读中文。
 *
 * truncated：列目录撞上翻页上限（CR_MAX_PAGES），分享里还有没列出来的文件。
 * 这时不能说「已全部加入」——那等于在 1 万阈值上复现静默缺件。文案直说
 * 「已达单次解析上限 N，请打开分享页取剩余」，并把 missing 留给「换直链失败」
 * 的语义（截断走 ResolveOutcome.truncated 单独报，两件事别混成一个数）。
 */
export function crBundleNote(
  shareName: string,
  total: number,
  failed: number,
  truncated = false,
): { message: string; missing: number } {
  if (truncated) {
    // 截断与「换直链失败」是两件事：前者是「列都没列完」，后者是「列到了但换不到直链」。
    // 两个都要说，否则用户以为剩下的只是取直链失败、没想到还有没列出来的文件。
    const extra = failed > 0 ? `，另有 ${failed} 个取直链失败` : ''
    return {
      message: `${shareName} 已达单次解析上限 ${CR_MAX_PAGES * CR_PAGE_SIZE} 个文件${extra}，请打开分享页取剩余`,
      missing: failed,
    }
  }
  const body =
    failed > 0
      ? `共 ${total} 个文件，已加入 ${total - failed} 个，另有 ${failed} 个取直链失败`
      : `共 ${total} 个文件已全部加入队列`
  return { message: `${shareName} ${body}`, missing: failed }
}

const CR_MAX_DEPTH = 8
const CR_PAGE_SIZE = 500
/** 列目录翻页上限：500/页 × 20 = 一万个文件，远超任何真实分享；防服务端异常。
 *  触顶不是静默收手：crList 会带 truncated=true，调用方据此提示「已达单次
 *  解析上限，请打开分享页取剩余」，而不是谎称「已全部加入队列」。 */
const CR_MAX_PAGES = 20

interface CrEntry {
  type: number
  name: string
  path: string
  size: number
}

/**
 * pan.nekogal.top 的 Cloudreve v4 分享页。全程匿名，不需要登录：
 * 列目录拿 path，再用 /file/url 换 S3 预签名直链。分卷按名称做 numeric 排序，
 * 保证 .part1 在前。
 */
async function resolveCloudreve(m: Mirror): Promise<ResolveOutcome> {
  const shareId = /pan\.nekogal\.top\/s\/([A-Za-z0-9_-]+)/i.exec(m.url)?.[1]
  if (!shareId) return { ok: false, message: '无法识别 NekoGAL 网盘分享 ID。' }
  const rootUri = `cloudreve://${shareId}@share`

  try {
    const info = (await getJson(`${CR_BASE}/share/info/${shareId}`)) as {
      code?: number
      data?: { name?: string }
    } | null
    const shareName = info?.data?.name ?? m.name
    if (info?.code !== 0) {
      return {
        ok: false,
        message: 'NekoGAL 网盘分享不存在、已过期或需要密码。请在浏览器里打开该分享页。',
        mirrors: [{ kind: 'page', name: shareName, url: m.url }],
      }
    }

    // 列目录会带一个 truncated：撞上翻页上限（CR_MAX_PAGES）时说明分享里还有
    // 没列出来的文件。以前这里直接 break、结果看起来像全集——A5 修的正是它。
    const collected = await crCollect(rootUri, [], 0)
    const files = collected.entries
    const truncated = collected.truncated
    if (!files.length) {
      return {
        ok: false,
        message: 'NekoGAL 网盘里没有可下载的文件。',
        mirrors: [{ kind: 'page', name: shareName, url: m.url }],
      }
    }
    // 分卷要按 .part1/.part2 顺序入队
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

    // 解析层不截断：多分卷 galgame 常有 60+ 文件，以前在这里砍掉第 61 个之后的
    // 文件，界面却长得像成功，用户到解压才发现缺件。现在分享里的每个文件都
    // 换成直链交回去；一次入队多少、要不要分批提示，是调用方和 Manager 队列
    // （max_concurrent）的事——解析层的职责是报全量，不是替用户裁剪。
    const resolved: ResolvedFile[] = []
    let failed = 0
    for (const f of files) {
      // 单个文件换直链失败只算这一条（failed++），绝不能把异常冒到外层 catch：
      // 外层 catch 会把整个分享判成「访问失败」，连已经换到的直链一起作废——
      // 失败半径从「1 个文件」放大成「整批」。
      // 为什么保持串行：resolved 的顺序要与 files 的 numeric 排序一致（分卷
      // .part1 在前），并发 4 路得额外做一次保序收尾，收益只是解析时间；
      // 本次修的是爆炸半径，不动行为与请求压力。
      try {
        const url = await crDirectUrl(f.path)
        if (url) resolved.push({ url, filename: f.name, size: f.size })
        else failed++
      } catch {
        // crDirectUrl 内部已经兜住异常；这里再拦一层，保证「一条失败」永远
        // 不会升级成「整批作废」（防御未来 crDirectUrl 内部改动）。
        failed++
      }
    }
    if (!resolved.length) {
      return {
        ok: false,
        message: 'NekoGAL 网盘直链获取失败，请在浏览器里打开该分享页。',
        mirrors: [{ kind: 'page', name: shareName, url: m.url }],
      }
    }

    const { message, missing } = crBundleNote(shareName, files.length, failed, truncated)
    const only = resolved[0]
    // 单文件直返的快速路只在「没有失败且没有截断」时走：触顶时哪怕只解析出
    // 一个文件，也必须带上 message/truncated，让用户知道分享里还有剩下的。
    if (resolved.length === 1 && !failed && !truncated) {
      // 一个文件、全部成功：没有要告知的事，别把「共 1 个文件」当成结果播报刷在屏幕上
      return { ok: true, url: only.url, filename: only.filename, size: only.size }
    }
    const outcome: ResolveOutcome = { ok: true, files: resolved, message, missing }
    if (truncated) outcome.truncated = true
    return outcome
  } catch (e) {
    return {
      ok: false,
      message: `NekoGAL 网盘访问失败：${reason(e)}。请在浏览器里打开。`,
      mirrors: [{ kind: 'page', name: m.name, url: m.url }],
    }
  }
}

/**
 * 失败原因。网络层的异常交给 networkLayerHint 分层（DNS/TCP/TLS/代理/超时），
 * 已经写成人话的（HTTP 状态、返回的不是 JSON）原样带上——吞掉原因等于让用户
 * 自己去猜该换网络、该配代理还是该重新分享。
 */
function reason(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return /net::|ERR_|ECONN|ENOTFOUND|ETIMEDOUT|abort|超时|没有响应/i.test(msg) ? networkLayerHint(e) : msg
}

/**
 * 列一个目录（自动翻页）。uri 形如 cloudreve://OnPtr@share 或 ...@share/父目录名。
 *
 * 必须翻页：单页 page_size=500 只拿第一页的话，500+ 文件的大分享会被静默
 * 少计——crBundleNote 的「共 N 个文件」和 missing 计数全部偏小，用户以为
 * 全量到位了，解压才发现缺件（正是 crBundleNote 注释里说的那种吞信息）。
 * 翻到「不满一页」为止；页数设上限防异常服务端永远返回满页。
 *
 * 返回 truncated：第 CR_MAX_PAGES 页仍是满页时说明还有第 21 页。以前这里
 * 直接 return，调用方拿到「看起来完整」的清单还说「已全部加入队列」——
 * 1 万阈值上复现的静默缺件。触顶必须显式标记，由调用方改口提示。
 */
async function crList(uri: string): Promise<{ entries: CrEntry[]; truncated: boolean }> {
  const out: CrEntry[] = []
  for (let page = 1; page <= CR_MAX_PAGES; page++) {
    const r = await fetchText(`${CR_BASE}/file?uri=${encodeURIComponent(uri)}&page_size=${CR_PAGE_SIZE}&page=${page}`, {
      headers: { accept: 'application/json' },
    })
    const why = httpFailureMessage(r)
    if (why) throw new Error(`列目录 ${why}`)
    const j = parseJson(r.text) as {
      code?: number
      msg?: string
      data?: { files?: Array<Partial<CrEntry>> }
    } | null
    // 网关/风控经常拿 HTML 冒充 JSON，不点破的话用户只会看到「访问失败」
    if (!j) throw new Error(`列目录没有返回 JSON（HTTP ${r.status}，${r.contentType || '未知类型'}）`)
    if (j.code !== 0) throw new Error(j.msg ?? `code ${j.code} @ ${uri}`)
    const files = (j.data?.files ?? []).map((f) => ({
      type: f.type ?? 0,
      name: f.name ?? '',
      path: f.path ?? '',
      size: f.size ?? 0,
    }))
    out.push(...files)
    if (files.length < CR_PAGE_SIZE) return { entries: out, truncated: false }
    // 满页翻到上限还满：还有下一页，但这次不翻了
    if (page === CR_MAX_PAGES) return { entries: out, truncated: true }
  }
  return { entries: out, truncated: false }
}

/** 递归收集分享内所有文件（跳过目录），限深防止异常递归。
 *  truncated 会向上传递：任何一层子目录触到翻页上限，整个分享都按截断处理。 */
async function crCollect(
  uri: string,
  acc: CrEntry[],
  depth: number,
): Promise<{ entries: CrEntry[]; truncated: boolean }> {
  if (depth > CR_MAX_DEPTH) return { entries: acc, truncated: false }
  const listed = await crList(uri)
  let truncated = listed.truncated
  for (const k of listed.entries) {
    if (k.type === 1) {
      const sub = await crCollect(`${uri}/${k.name}`, acc, depth + 1)
      truncated = truncated || sub.truncated
    } else if (k.path) {
      acc.push(k)
    }
  }
  return { entries: acc, truncated }
}

/** 把文件 path 换成预签名直链（POST /file/url）。失败返回 null。
 *
 *  内部兜底：fetchText 在网络层的超时/断连是 **reject**，不接的话异常会冒到
 *  resolveCloudreve 的 catch，把整批已解析直链一起作废。一个文件取不到直链
 *  只该让 failed++，不该让整个分享解析失败。 */
async function crDirectUrl(path: string): Promise<string | null> {
  try {
    const r = await fetchText(`${CR_BASE}/file/url`, {
      method: 'POST',
      body: JSON.stringify({ uris: [path], download: true }),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    })
    if (!r.ok) return null
    const j = parseJson(r.text) as { code?: number; data?: { urls?: Array<{ url?: string }> } } | null
    return j?.code === 0 ? (j.data?.urls?.[0]?.url ?? null) : null
  } catch {
    return null
  }
}

// --------------------------------------------------------------- 工具

function filenameFromUrl(url: string): string {
  try {
    const p = new URL(url).pathname
    const last = p.split('/').filter(Boolean).pop() ?? ''
    return decodeURIComponent(last) || 'download'
  } catch {
    return 'download'
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}
