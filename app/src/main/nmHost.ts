/**
 * native messaging 宿主模式：桌面端被当成「宿主进程」拉起来时的行为。
 *
 * 分工（为什么不是 Chrome 直接拉起本应用）：
 *   Chrome → 宿主中继 exe（fastdrop-nm-host，Rust 小程序）→ 本进程（Electron）
 * 中继存在的唯一理由是 **stdout 干净**：Electron 在 Windows 启动时会往 stdout 写
 * 一个 "\r\n"（原生代码，JS 里拦不掉），而 Chrome 把 stdout 首 4 字节当长度头，
 * 多 2 个字节整条链路就错位。中继的 stdout 没有 Electron 噪音。
 *
 * 触发方式：宿主中继把调用方 origin 通过环境变量 HANEHANA_NM_ORIGIN 传进来，
 * 本进程据此判断「我现在是不是被当成宿主拉起来的」。
 *
 * 宿主模式下这个进程**不开窗口**：它只做一件事——读 stdin 上的协议帧、
 * 把投递请求转给正在运行的主应用（见 nmBridge）、把结果写回 stdout，然后退出。
 *
 * stdout 是中继私有通道：本模式下所有日志一律走 stderr。
 */
import { spawn } from 'node:child_process'
import { createReadStream, type ReadStream } from 'node:fs'
import { app } from 'electron'
import {
  NM_EXTENSION_ID,
  NmFrameDecoder,
  encodeNmRelayFrame,
  validateNmDeliver,
  type NmDeliverResponse,
} from '../shared/nmProtocol'
import { appendNmPending, sendToNmBridge } from './nmBridge'
import { dataDir } from './store'

/** 宿主模式的启动识别结果。trusted=false 表示「是宿主，但不是我们的扩展」。 */
export interface NmHostDetection {
  origin: string
  trusted: boolean
}

/**
 * 从命令行里认宿主模式。
 *
 * 认两种形态：
 *   chrome-extension://<32位小写a-p>/   —— Chrome 扩展
 *   moz-extension://<uuid>/             —— Firefox（清单格式一样，但本项目只保证 Chromium 系可用）
 * 认到 Firefox 的 origin 也返回 trusted=false：Firefox 会把宿主名映射到自己的
 * 清单路径，行为与 Chrome 不同，这里不做承诺。
 *
 * 正常路径是**环境变量**（HANEHANA_NM_ORIGIN）：Chrome 只把 origin 作为命令行
 * 第一个参数追加给宿主 exe，而 Electron 会把第一个位置参数当成「要加载的应用路径」
 * ——直接拿 Electron 当宿主，这条路走不通。宿主中继 exe 会把 origin 转成环境变量
 * 再拉起本进程（见 nmHostInstall.ts 里的中继说明）。命令行那条保留下来，
 * 是为了让人能手工带 origin 启动本进程做调试。
 */
export function detectNmHostLaunch(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): NmHostDetection | null {
  const fromEnv = env.HANEHANA_NM_ORIGIN
  if (fromEnv) {
    const detected = detectOrigin(fromEnv)
    if (detected) return detected
  }
  for (const arg of argv) {
    const detected = detectOrigin(arg)
    if (detected) return detected
  }
  return null
}

/** 认一个 origin 字符串；形状不对就当没这个 origin。 */
function detectOrigin(arg: string): NmHostDetection | null {
  const m = /^chrome-extension:\/\/([a-p]{32})\/$/.exec(arg)
  if (m) {
    return { origin: arg, trusted: m[1] === NM_EXTENSION_ID }
  }
  if (/^moz-extension:\/\/[0-9a-f-]{36}\/$/.test(arg)) {
    return { origin: arg, trusted: false }
  }
  return null
}

/** 把 stdout 上的日志全部赶到 stderr，保住协议通道的干净。 */
function redirectStdoutToStderr(): void {
  const toErr = (...args: unknown[]): void => {
    console.error(...args)
  }
  // 直接改 console 的三个方法：宿主进程里任何模块打日志都该走 stderr，
  // stdout 是协议帧的专用车道，混进一个字节的日志 Chrome 就当帧解析，直接断连。
  // （用 Object.assign 而不是逐个赋值：ESLint 的 no-console 不认「赋值给 console.log」这种写法，
  //  但这里是刻意的重定向，不是新加日志。）
  Object.assign(console, { log: toErr, info: toErr, debug: toErr })
}

/**
 * 拉起图形界面（应用没在运行时）。
 *
 * 为什么要拉：用户点了扩展的「投递」，如果什么都没发生，他只会以为扩展坏了。
 * 把应用叫起来，用户至少能看到「链接已排队」。
 */
function launchGui(): void {
  try {
    const args = app.isPackaged ? [] : [app.getAppPath()]
    // 环境变量必须清干净再拉：
    //   HANEHANA_NM_ORIGIN —— 留着它，新起的图形界面会以为自己是宿主进程，
    //     于是不开窗口、转头去读 stdin，界面永远出不来。
    //   ELECTRON_RUN_AS_NODE —— 留着它，Electron 会退化成纯 Node 模式直接崩。
    const env = { ...process.env }
    delete env.HANEHANA_NM_ORIGIN
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env })
    child.unref()
  } catch (e) {
    console.error('[nm] 拉起界面失败：', e)
  }
}

/**
 * 跑宿主模式。这个函数不返回——进程一直活到 stdin 关闭（Chrome 读完应答就断管）。
 */
export function runNmHost(detection: NmHostDetection): void {
  redirectStdoutToStderr()

  if (!detection.trusted) {
    // 不是我们的扩展：明确拒掉并退出，绝不能默默开一个窗口出来。
    void writeFrame({ ok: false, error: '这个扩展没有投递权限' }).then(() => exitHost(0))
    return
  }

  const decoder = new NmFrameDecoder()
  let finished = false
  /** 最近一次应答的落盘进度：退出前必须等它写完，否则半截帧 = Chrome 侧通信错误。 */
  let lastWrite: Promise<void> = Promise.resolve()
  /** 消息处理链：保证一条接一条地应答。 */
  let chain: Promise<void> = Promise.resolve()
  /** 还没应答完的消息数：用来判断「可以收工退出了」。 */
  let inflight = 0

  const shutdown = (): void => {
    if (finished) return
    finished = true
    void lastWrite.then(
      () => exitHost(0, stdin),
      (e) => {
        console.error('[nm] 最后一帧写失败：', e)
        exitHost(1, stdin)
      },
    )
  }

  const stdin = openHostStdin()
  stdin.on('data', (chunk: string | Buffer) => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    const result = decoder.push(bytes)
    if (!result.ok) {
      lastWrite = writeFrame({ ok: false, error: result.error })
      shutdown()
      return
    }
    for (const raw of result.messages) {
      // 串行处理：一条消息的应答没写完，不接下一条（stdout 上帧不能交叠）。
      inflight += 1
      chain = chain
        .then(() => handleMessage(raw, detection.origin))
        .finally(() => {
          inflight -= 1
          // 应答写完就退出：Chrome 每次 sendNativeMessage 都是新拉一个宿主，
          // 拿到应答后不会主动关管道（真 Chrome 实测：宿主会一直挂着），
          // 不自己退就是每投递一次漏一套 Electron 进程（5 个进程）。
          // 这里退的是「最后一条消息应答完」的时刻，多条消息排队时不会提前退。
          if (inflight === 0) shutdown()
        })
    }
    lastWrite = chain
  })

  stdin.on('end', shutdown)
  stdin.on('close', shutdown)
  stdin.on('error', (e) => {
    console.error('[nm] 读 stdin 出错：', e)
    shutdown()
  })
}

/**
 * 打开真正的 stdin。
 *
 * 坑（端到端实测踩出来的）：Electron 主进程的 `process.stdin` 是个**空壳**——
 * `fd` 是 undefined，而且连接会立刻 end。照着常规 Node 写法监听它的 'data'，
 * 宿主会在 Chrome 还没递消息之前就退掉，扩展那边只看到「宿主已退出」，
 * 现场完全看不出是哪一环错了（stdout 里连一个协议帧都没有）。
 * 真 stdin 只能按 fd 0 自己开流；这个流是异步的，不会卡住事件循环，
 * 所以桥的应答照常能回来。
 *
 * autoClose 必须开着（默认）：应答写完要 destroy() 这个流来退场，
 * 而只有 autoClose 才会真正把 fd 0 关掉、释放掉 libuv 的句柄——
 * 否则事件循环里永远挂着这个句柄，进程退不掉（每次投递漏一整套 Electron 进程）。
 */
function openHostStdin(): ReadStream {
  return createReadStream('', { fd: 0 })
}

/**
 * 写一帧应答。
 *
 * stdout 是**中继私有通道**，不是直接给 Chrome 的：桌面端写的是
 * 「魔数 + 长度 + JSON」（见 shared/nmProtocol.ts 的 NM_RELAY_MAGIC），
 * 宿主中继 exe 剥掉魔数、按 Chrome 协议重新封帧后才转发给 Chrome。
 * 这样 Electron 启动时写进 stdout 的 "\r\n" 就碰不到 Chrome 的协议车道。
 *
 * 写完等回调（数据已交给内核管道）再允许退出，否则 app.exit() 会截断半截帧。
 */
function writeFrame(payload: unknown): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const done = (): void => {
      if (!settled) {
        settled = true
        resolve()
      }
    }
    // 写回调可能永不来（中继已退/管道读端消失）：挂个 2s 竞速兜底，
    // 否则 shutdown() 的 lastWrite.then(...) 永远不跑，process.exit 轮不到。
    const timer = setTimeout(() => {
      console.error('[nm] 写应答超时（管道可能已断）')
      done()
    }, 2000)
    timer.unref()
    try {
      process.stdout.write(encodeNmRelayFrame(payload), () => {
        clearTimeout(timer)
        done()
      })
    } catch (e) {
      clearTimeout(timer)
      console.error('[nm] 写应答失败：', e)
      done()
    }
  })
}

/**
 * 宿主退场。
 *
 * 坑（真 Chrome 实测踩出来的）：宿主模式（不开窗口、不等 app.whenReady）里
 * **app.exit() 退不掉**——它把 Electron 的消息循环停掉，进程既不退（fd 0 的读流
 * 还挂着，libuv 认为还有活干）又不再跑任何回调（后面的代码全都不执行，
 * 连 process.exit 都轮不到执行）。
 *
 * 真正的退场办法是应答写完之后直接 `process.exit(0)`：数据已经交给内核管道，
 * 进程先走数据也不丢。实测退出码 0，Electron 的子进程也跟着收干净，
 * 一次投递不残留任何进程。
 */
function exitHost(code: number, stdin?: ReadStream | null): void {
  try {
    stdin?.destroy()
  } catch (e) {
    console.error('[nm] 断 stdin 失败：', e)
  }
  process.exit(code)
}

async function handleMessage(raw: unknown, origin: string): Promise<void> {
  const checked = validateNmDeliver(raw)
  if (!checked.ok) {
    await writeFrame({ ok: false, error: checked.error })
    return
  }
  const req = checked.value

  const viaApp = await sendToNmBridge(dataDir(), req, origin)
  if (viaApp) {
    await writeFrame(viaApp)
    return
  }

  // 应用没在跑（或正卡住）：排队 + 把应用叫起来。
  appendNmPending(dataDir(), req)
  launchGui()
  const response: NmDeliverResponse = {
    ok: true,
    mode: 'queued',
    message: 'HaneHana 未在运行，链接已排队，启动后自动接手',
  }
  await writeFrame(response)
}
