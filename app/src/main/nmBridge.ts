/**
 * native messaging 的本机桥：把「Chrome 拉起的宿主进程」和「正在跑的主应用」接起来。
 *
 * 为什么需要桥：Chrome 每次发消息都会**新拉起一个宿主进程**（sendNativeMessage 的语义），
 * 这个进程和主应用是两个独立进程，没有共享内存，也没法用 Electron 的单实例通道
 * 回话（那边只有 argv，没有应答通道）。而应答必须回到同一条 stdout 管道，
 * 扩展等的就是这个应答。
 *
 * 所以：主应用在 127.0.0.1 上开一个只做一件事的小 TCP 服务，把端口和一个随机
 * token 写在数据目录的 nm-bridge.json 里；宿主进程读这个文件、连上去、把扩展的
 * 消息递过去、拿回应答、写回 stdout。
 *
 * 安全口径：
 *   - 只监听 127.0.0.1，不对外网开洞
 *   - 每次启动换新 token，文件在用户数据目录里，其它本机程序读不到就进不来
 *   - 桥上再校验一次 origin：必须是钉死的那个扩展（宿主清单已经挡过一层，这里是第二层）
 *   - 单条消息上限 1 MiB，防止本机程序往里灌超大包
 *
 * 为什么数据目录是参数而不是这里自己算：这个模块被 Node 单测直接引用（不经过
 * Electron），自己算就得 import electron，而 import 'electron' 在纯 Node 下会直接
 * 抛「没有 app 这个导出」。目录由调用方（主进程）传进来，模块本身保持零依赖。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { NM_EXTENSION_ID, type NmDeliverRequest, type NmDeliverResponse } from '../shared/nmProtocol.js'

/** 桥上的消息上限。超过就是有人在灌水，直接掐断。 */
const MAX_BRIDGE_MESSAGE = 1024 * 1024

/** 宿主进程等应答的上限。应用卡住时宁可排队也别把扩展挂死。 */
const BRIDGE_TIMEOUT_MS = 4000

export interface NmBridgeInfo {
  port: number
  token: string
  pid: number
  startedAt: number
}

export function nmBridgeFile(dir: string): string {
  return join(dir, 'nm-bridge.json')
}

/** 应用没开时收到的链接，排队落在这里；应用下次启动时接手。 */
export function nmPendingFile(dir: string): string {
  return join(dir, 'nm-pending.jsonl')
}

function writeBridgeInfo(dir: string, info: NmBridgeInfo): void {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(nmBridgeFile(dir), JSON.stringify(info), 'utf8')
  } catch {
    /* 写不进去也不致命：宿主会退回排队路径 */
  }
}

export function readNmBridgeInfo(dir: string): NmBridgeInfo | null {
  try {
    const raw = JSON.parse(readFileSync(nmBridgeFile(dir), 'utf8')) as Partial<NmBridgeInfo>
    if (typeof raw?.port !== 'number' || typeof raw?.token !== 'string') return null
    return { port: raw.port, token: raw.token, pid: raw.pid ?? 0, startedAt: raw.startedAt ?? 0 }
  } catch {
    return null
  }
}

/**
 * 启动桥服务。
 *
 * onDeliver 由调用方（主进程）提供：把投递请求变成下载任务或错误。
 * 返回的 close() 会在应用退出时调用，清掉桥信息文件——
 * 留着旧文件会让下一个宿主进程连上一个已经不存在的端口。
 */
export function startNmBridge(
  dir: string,
  onDeliver: (req: NmDeliverRequest, origin: string) => Promise<NmDeliverResponse>,
): { close: () => void; info: NmBridgeInfo } {
  const token = randomBytes(24).toString('hex')
  const info: NmBridgeInfo = { port: 0, token, pid: process.pid, startedAt: Date.now() }
  // 已建立的连接集合：close() 时统一 destroy——只 server.close() 的话，
  // 退出瞬间正连着的宿主进程会把句柄留到进程终结。
  const socks = new Set<Socket>()
  const server: Server = createServer((sock) => {
    socks.add(sock)
    sock.on('close', () => socks.delete(sock))
    handleConnection(sock, token, onDeliver)
  })

  server.on('error', (e) => {
    console.error('[nm] 桥服务出错：', e)
  })
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    info.port = port
    writeBridgeInfo(dir, info)
  })

  return {
    info,
    close: () => {
      try {
        server.close()
      } catch {
        /* 已经关了 */
      }
      for (const s of socks) {
        try {
          s.destroy()
        } catch {
          /* 对端可能已经断了 */
        }
      }
      socks.clear()
      try {
        rmSync(nmBridgeFile(dir), { force: true })
      } catch {
        /* 文件本来就不在 */
      }
    },
  }
}

/** 令牌比较：时序安全 + 长度预判（timingSafeEqual 不等长会抛）。 */
function tokenEq(given: unknown, expect: string): boolean {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(expect, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function handleConnection(
  sock: Socket,
  token: string,
  onDeliver: (req: NmDeliverRequest, origin: string) => Promise<NmDeliverResponse>,
): void {
  // 按**字节**攒缓冲：UTF-8 序列被切在 TCP 分片里时，逐块 toString('utf8')
  // 会把残缺序列换成不可逆的 U+FFFD（中文文件名/Cookie 一冲就坏），随后
  // JSON.parse 失败、用户看到跟真实原因毫不相干的「消息不是合法 JSON」。
  // 必须 Buffer.concat 攒够一整行再一次性解码（与 NmFrameDecoder 同口径）。
  let chunks: Buffer[] = []
  let bytes = 0
  let answered = false
  sock.setTimeout(BRIDGE_TIMEOUT_MS * 2, () => sock.destroy())

  const finish = (payload: unknown): void => {
    if (answered) return
    answered = true
    try {
      sock.write(JSON.stringify(payload) + '\n')
    } catch {
      /* 对端已断开 */
    }
    sock.end()
  }

  sock.on('data', (chunk: Buffer) => {
    chunks.push(chunk)
    bytes += chunk.length
    if (bytes > MAX_BRIDGE_MESSAGE) {
      finish({ ok: false, error: '消息过大' })
      sock.destroy()
      return
    }
    const joined = Buffer.concat(chunks)
    const nl = joined.indexOf(0x0a)
    if (nl < 0) return
    const line = joined.subarray(0, nl).toString('utf8')
    chunks = [joined.subarray(nl + 1)]
    bytes = chunks[0].length

    let parsed: { token?: string; origin?: string; request?: unknown }
    try {
      parsed = JSON.parse(line) as typeof parsed
    } catch {
      finish({ ok: false, error: '消息不是合法 JSON' })
      return
    }
    if (!tokenEq(parsed.token, token)) {
      finish({ ok: false, error: '桥令牌不匹配' })
      return
    }
    // 第二道 origin 校验：只认钉死的那个扩展。
    const origin = parsed.origin ?? ''
    if (origin !== `chrome-extension://${NM_EXTENSION_ID}/`) {
      finish({ ok: false, error: '来源扩展不匹配' })
      return
    }
    void onDeliver(parsed.request as NmDeliverRequest, origin)
      .then((response) => finish({ ok: true, response }))
      .catch((e: unknown) =>
        finish({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      )
  })

  sock.on('error', () => {
    /* 宿主进程可能已经退出（sendNativeMessage 每次都新起一个） */
  })
}

/**
 * 宿主进程侧：把请求递给正在运行的应用。
 *
 * 返回值区分两种「没拿到应答」：
 *   null                                   —— 应用没在跑/连不上（调用方走排队路径）
 *   { ok: false, error: '主应用应答超时…' }  —— 连上了但超时（**不是**没开）
 * 以前两种都返回 null，排队路径会把「应用只是慢」也当成没开：多写一行
 * nm-pending.jsonl，而下次启动接手时那条排队行**不带 Cookie**（凭据只活在
 * 内存），manager 又按 URL 判重不重建任务——登录态站点的续传就此 403。
 */
export function sendToNmBridge(
  dir: string,
  request: NmDeliverRequest,
  origin: string,
  timeoutMs = BRIDGE_TIMEOUT_MS,
): Promise<NmDeliverResponse | null> {
  const info = readNmBridgeInfo(dir)
  if (!info || !info.port) return Promise.resolve(null)

  return new Promise((resolve) => {
    let done = false
    const finish = (v: NmDeliverResponse | null): void => {
      if (done) return
      done = true
      resolve(v)
    }
    const sock = connect({ host: '127.0.0.1', port: info.port })
    // 应答方向同样按字节攒：dest 路径/标题带中文时，逐块 toString 会把
    // 跨分片的序列换成不可逆的 U+FFFD。
    let chunks: Buffer[] = []
    sock.setTimeout(timeoutMs, () => {
      sock.destroy()
      finish({ ok: false, error: '主应用应答超时（任务可能已创建，请到下载页查看）' })
    })
    sock.on('error', () => {
      finish(null)
    })
    sock.on('connect', () => {
      sock.write(JSON.stringify({ token: info.token, origin, request }) + '\n')
    })
    sock.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      const joined = Buffer.concat(chunks)
      const nl = joined.indexOf(0x0a)
      if (nl < 0) return
      chunks = [joined.subarray(nl + 1)]
      try {
        const parsed = JSON.parse(joined.subarray(0, nl).toString('utf8')) as {
          ok?: boolean
          response?: NmDeliverResponse
          error?: string
        }
        if (parsed.ok && parsed.response) finish(parsed.response)
        else finish({ ok: false, error: parsed.error ?? '主应用没有应答' })
      } catch {
        finish({ ok: false, error: '主应用应答无法解析' })
      }
    })
  })
}

/** 链接排队：应用没在运行时的落脚点。 */
export function appendNmPending(dir: string, request: NmDeliverRequest): void {
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(nmPendingFile(dir), JSON.stringify(request) + '\n', 'utf8')
  } catch (e) {
    console.error('[nm] 排队写入失败：', e)
  }
}

/** 读排队里的链接（应用启动时接手）。 */
export function readNmPending(dir: string): NmDeliverRequest[] {
  if (!existsSync(nmPendingFile(dir))) return []
  const out: NmDeliverRequest[] = []
  try {
    for (const line of readFileSync(nmPendingFile(dir), 'utf8').split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        out.push(JSON.parse(t) as NmDeliverRequest)
      } catch {
        /* 坏行跳过：别让一行垃圾把整个队列卡死 */
      }
    }
  } catch {
    return out
  }
  return out
}

/** 清空排队（接手之后调用）。 */
export function clearNmPending(dir: string): void {
  try {
    rmSync(nmPendingFile(dir), { force: true })
  } catch {
    /* 本来就不在 */
  }
}
