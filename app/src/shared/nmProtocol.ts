/**
 * 浏览器扩展 ↔ HaneHana 的 native messaging 契约（唯一真值）。
 *
 * 为什么单独一个文件：这条链上跑着三个互不共享内存的进程/上下文——
 * 扩展的 service worker、Chrome 拉起的宿主进程（我们自己的 exe 以宿主模式启动）、
 * 正在运行的主应用。它们的字段名一旦有一处对不上，表现是「点了没反应」，
 * 而且没有任何栈可查。三边都必须引用同一份定义，所以它必须能被纯 Node 单测。
 *
 * 线协议（Chrome 官方规定，不能自创）：
 *   - 每条消息 = 4 字节小端长度 + UTF-8 JSON
 *   - 宿主 → 浏览器单条上限 1 MiB；浏览器 → 宿主单条上限 64 MiB
 *   - Windows 上宿主 stdout 只能有协议帧，任何日志都必须走 stderr
 *   - Chrome 启动宿主时，argv[1] 是调用方 origin（chrome-extension://<id>/）
 *
 * 扩展侧不引用本文件（扩展是独立的 JS 工程），它的同名字段由本文档与
 * app/extension/README.md 约束；两边不一致时以本文件为准。
 */

/** native messaging 宿主名。Chrome 侧用它查注册表/清单，两边必须一致。 */
export const NM_HOST_NAME = 'com.lxfebd.hanehana'

/** 协议版本。扩展带 v，主机不认识的版本直接拒（不猜、不兼容着跑）。 */
export const NM_PROTOCOL_VERSION = 1

/**
 * 扩展 ID（已用 manifest 里的 "key" 钉死）。
 *
 * 为什么必须钉死：宿主清单的 allowed_origins 不允许通配符，只能写死
 * `chrome-extension://<id>/`。不钉死的话，每台机器上「加载已解压的扩展程序」
 * 生成的 ID 都不同，主机清单得按机器生成——那就不是一键安装了。
 * 改这个 ID 必须同步改三处：本文件、扩展 manifest 的 key、
 * 以及 app/src/main/nmHostInstall.ts 写出的宿主清单。
 */
export const NM_EXTENSION_ID = 'jjoapnhpnedocdkfffpiccdehollooab'

/** 宿主 → 浏览器：Chrome 硬上限 1 MiB。 */
export const NM_MAX_HOST_MESSAGE = 1024 * 1024

/** 浏览器 → 宿主：Chrome 硬上限 64 MiB。 */
export const NM_MAX_CLIENT_MESSAGE = 64 * 1024 * 1024

export const NM_MAX_URL_LEN = 4096
export const NM_MAX_FILENAME_LEN = 255
export const NM_MAX_REFERER_LEN = 8192
export const NM_MAX_COOKIE_LEN = 8192
export const NM_MAX_UA_LEN = 512
export const NM_MAX_TITLE_LEN = 512

/** 可注册的浏览器。Chromium 系（Chrome / Edge / Brave / Chromium）。 */
export type NmBrowserId = 'chrome' | 'edge' | 'brave' | 'chromium'

/** 安装/注销宿主的结果（渲染层据此刷新状态）。 */
export interface NmActionResult {
  ok: boolean
  /** 本次成功注册（或注销）的浏览器。 */
  installed?: NmBrowserId[]
  removed?: NmBrowserId[]
  /** 失败原因，逐条列出（一个浏览器失败不该连累其它浏览器）。 */
  errors?: string[]
  /** 整体失败原因（如「没选择浏览器」）。 */
  error?: string
  /** 操作后的最新状态。 */
  status?: NmHostStatus
}

/**
 * 扩展投递请求。
 *
 * 字段全是可选的除了 url：扩展在不同页面能拿到的信息不一样
 * （右键菜单知道链接文字，弹窗知道用户手输的地址，下载事件知道文件名）。
 * 拿不到就少给，别编。
 */
export interface NmDeliverRequest {
  /** 协议版本，必须等于 NM_PROTOCOL_VERSION。 */
  v: number
  /** 动作。当前只有投递下载链接。 */
  action: 'deliver'
  /** 直链，http/https。 */
  url: string
  /** 建议的文件名（扩展从链接或 download 属性拿到的）。空则由主机从 URL 推断。 */
  filename?: string
  /** 来源页地址，作为 Referer 头带给服务器——不少站点靠它放行直链。 */
  referer?: string
  /** 来源页的 Cookie 串。登录态站点的直链离开浏览器就 403，只能靠它。 */
  cookie?: string
  /** 浏览器 UA。 */
  userAgent?: string
  /** 触发投递的页面地址，仅用于日志与界面提示。 */
  pageUrl?: string
  /** 链接文字/标题，仅用于界面提示。 */
  title?: string
}

/**
 * 主机回给扩展的结果。
 *
 * mode 三种：
 *   engine  —— 已交给下载引擎，任务在下载页里能看见
 *   queued  —— 应用没在运行，链接已排队，下次启动自动接手
 *   error   —— 拒了（原因给用户看，所以是中文短句）
 */
export type NmDeliverResponse =
  | { ok: true; mode: 'engine' | 'queued'; taskId?: string; dest?: string; message?: string }
  | { ok: false; error: string }

/** 投递校验的结果。错误文案是给用户看的，短句即可。 */
export type NmValidateResult =
  | { ok: true; value: NmDeliverRequest }
  | { ok: false; error: string }

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function optionalText(
  raw: Record<string, unknown>,
  key: string,
  max: number,
): { value?: string; error?: string } {
  const v = raw[key]
  if (v === undefined || v === null) return {}
  if (typeof v !== 'string') return { error: `${key} 必须是字符串` }
  if (v.length > max) return { error: `${key} 太长（上限 ${max} 字符）` }
  const s = v.trim()
  return s ? { value: s } : {}
}

/**
 * 校验并归一一条投递请求。
 *
 * 这是安全边界：宿主进程是本机进程，浏览器里任何扩展都可能往这条管道里写东西
 * （宿主清单的 allowed_origins 已经挡掉大部分，但主机自己不校验就等于没有第二道门）。
 * 只认 http/https，挡掉 file://、smb://、data: 这类——它们能读本机文件或打内网。
 */
export function validateNmDeliver(raw: unknown): NmValidateResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: '消息格式不对' }
  }
  const r = raw as Record<string, unknown>
  if (r.v !== NM_PROTOCOL_VERSION) return { ok: false, error: '协议版本不支持' }
  if (r.action !== 'deliver') return { ok: false, error: '不认识的动作' }

  const url = str(r.url)?.trim() ?? ''
  if (!url) return { ok: false, error: '缺少下载链接' }
  if (url.length > NM_MAX_URL_LEN) return { ok: false, error: '下载链接过长' }
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: '只支持 http/https 链接' }

  const filename = optionalText(r, 'filename', NM_MAX_FILENAME_LEN)
  if (filename.error) return { ok: false, error: filename.error }
  const referer = optionalText(r, 'referer', NM_MAX_REFERER_LEN)
  if (referer.error) return { ok: false, error: referer.error }
  const cookie = optionalText(r, 'cookie', NM_MAX_COOKIE_LEN)
  if (cookie.error) return { ok: false, error: cookie.error }
  const userAgent = optionalText(r, 'userAgent', NM_MAX_UA_LEN)
  if (userAgent.error) return { ok: false, error: userAgent.error }
  const pageUrl = optionalText(r, 'pageUrl', NM_MAX_URL_LEN)
  if (pageUrl.error) return { ok: false, error: pageUrl.error }
  const title = optionalText(r, 'title', NM_MAX_TITLE_LEN)
  if (title.error) return { ok: false, error: title.error }

  const out: NmDeliverRequest = { v: NM_PROTOCOL_VERSION, action: 'deliver', url }
  if (filename.value) out.filename = filename.value
  if (referer.value) out.referer = referer.value
  if (cookie.value) out.cookie = cookie.value
  if (userAgent.value) out.userAgent = userAgent.value
  if (pageUrl.value) out.pageUrl = pageUrl.value
  if (title.value) out.title = title.value
  return { ok: true, value: out }
}

/**
 * 把投递请求翻译成下载引擎要的请求头。
 *
 * 只有 Referer / Cookie / User-Agent 三个：它们是「离开浏览器就下不动」的三个原因，
 * 也正是扩展唯一拿得到、且下载源确实会认的东西。
 * 注意：这个 map 是**运行期**的，不进任务存档——Cookie 是凭据，不该明文躺在
 * tasks.json 里。代价是重启后续传会缺登录态，引擎会照常报 403。
 */
export function nmRequestHeaders(req: NmDeliverRequest): Record<string, string> {
  const h: Record<string, string> = {}
  if (req.referer) h['Referer'] = req.referer
  if (req.cookie) h['Cookie'] = req.cookie
  if (req.userAgent) h['User-Agent'] = req.userAgent
  return h
}

/**
 * 编一帧：4 字节小端长度 + UTF-8 JSON。
 *
 * 长度是**字节数**不是字符数——Chrome 按字节算，写成字符串长度会在有中文时错位。
 */
export function encodeNmFrame(payload: unknown, maxBytes = NM_MAX_HOST_MESSAGE): Buffer {
  const json = Buffer.from(JSON.stringify(payload), 'utf8')
  if (json.length > maxBytes) throw new Error(`消息过大（${json.length} 字节）`)
  const frame = Buffer.allocUnsafe(4 + json.length)
  frame.writeUInt32LE(json.length, 0)
  json.copy(frame, 4)
  return frame
}

/**
 * 中继私有帧的魔数（桌面端 → 宿主中继 exe）。
 *
 * 为什么要有这层：桌面端是 Electron 应用，它在 Windows 上启动时会往 stdout 写
 * 一个 "\r\n"（原生代码，JS 里拦不掉）。Chrome 把 stdout 的**首 4 字节**当长度头，
 * 多出来的 2 个字节会让整条链路错位——扩展那边表现为「通信错误 / 一直转圈」。
 * 所以桌面端不直接对 Chrome 说话，而是先把应答包成带魔数的私有帧，
 * 由宿主中继 exe 剥掉魔数、按 Chrome 协议重新封好再转发。
 * 中继 exe 的 stdout 没有任何 Electron 噪音，天然干净。
 */
export const NM_RELAY_MAGIC = 'HHNM'

/** 编一帧中继私有帧：魔数 + 4 字节小端长度 + UTF-8 JSON。 */
export function encodeNmRelayFrame(payload: unknown, maxBytes = NM_MAX_HOST_MESSAGE): Buffer {
  const json = Buffer.from(JSON.stringify(payload), 'utf8')
  if (json.length > maxBytes) throw new Error(`消息过大（${json.length} 字节）`)
  const head = Buffer.allocUnsafe(8)
  head.write(NM_RELAY_MAGIC, 0, 4, 'ascii')
  head.writeUInt32LE(json.length, 4)
  return Buffer.concat([head, json])
}

/** 解帧结果。协议层出错时整条连接都得弃掉——长度前缀错位后没有补救办法。 */
export type NmDecodeResult =
  | { ok: true; messages: unknown[] }
  | { ok: false; error: string }

/**
 * 流式解帧器：把 stdin 的任意切块拼成完整消息。
 *
 * 为什么不能假设「一次 read 收到一条完整帧」：管道读是任意切分的，
 * 一帧 300KB 的 JSON 会被拆成几十块。半帧当完整帧解析 = 直接解析失败。
 */
export class NmFrameDecoder {
  private buf: Buffer = Buffer.alloc(0)

  constructor(private readonly maxBytes: number = NM_MAX_CLIENT_MESSAGE) {}

  /** 喂一段数据，返回本次能解出的消息。出错时返回 error，调用方应当终止连接。 */
  push(chunk: Buffer): NmDecodeResult {
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk])
    const messages: unknown[] = []
    for (;;) {
      if (this.buf.length < 4) break
      const len = this.buf.readUInt32LE(0)
      if (len > this.maxBytes) {
        return { ok: false, error: `消息长度超限（${len} 字节）` }
      }
      if (this.buf.length < 4 + len) break
      const body = this.buf.subarray(4, 4 + len).toString('utf8')
      this.buf = this.buf.subarray(4 + len)
      try {
        messages.push(JSON.parse(body))
      } catch {
        return { ok: false, error: '消息不是合法 JSON' }
      }
    }
    return { ok: true, messages }
  }
}

/** 宿主状态（设置页展示用）。 */
export interface NmHostStatus {
  /** native messaging 宿主名。 */
  hostName: string
  /** 扩展 ID。 */
  extensionId: string
  /** 扩展目录（加载已解压扩展时选它）。 */
  extensionDir: string
  /** 宿主清单文件路径。 */
  manifestPath: string
  /** 主应用是否在跑、桥是否在监听。 */
  bridgeRunning: boolean
  /** 桥端口（0 = 没监听）。 */
  bridgePort: number
  /** 各浏览器的宿主注册情况。 */
  registered: Record<NmBrowserId, boolean>
  /** 排队待处理（应用没开时收到）的链接数。 */
  pending: number
}

/**
 * 扩展投递事件（主进程 → 渲染层）。
 *
 * source 区分「扩展实时投递」和「应用启动时接手排队」——后者发生在界面还没起来的
 * 时候，渲染层要等窗口就绪后才听得见推送，所以两种来源的界面提示不一样。
 */
export interface NmLinkPush {
  /** 是否已经建出下载任务 */
  ok: boolean
  /** 被投递的链接 */
  url: string
  /** 链接文字（可选，用于提示） */
  title?: string
  /** 建成的任务 id */
  taskId?: string
  /** 保存路径 */
  dest?: string
  /** 失败原因（ok=false 时有） */
  error?: string
  /** 来源 */
  source: 'extension' | 'pending'
}
