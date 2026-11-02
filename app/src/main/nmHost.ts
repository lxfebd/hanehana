/**
 * native messaging 宿主模式：Chrome 把我们这个 exe 当成「宿主进程」拉起来时的行为。
 *
 * 触发方式：Chrome 启动宿主时，命令行第一个参数是调用方 origin
 * （chrome-extension://<扩展ID>/），Windows 还会追加 --parent-window=<句柄>。
 * 所以判断「我现在是不是被当成宿主拉起来的」不靠我们自己加的开关——
 * 开关 Chrome 没法传（宿主清单没有 args 字段），只能认 origin。
 *
 * 宿主模式下这个进程**不开窗口**：它只做一件事——读 stdin 上的协议帧、
 * 把投递请求转给正在运行的主应用（见 nmBridge）、把结果写回 stdout，然后退出。
 *
 * stdout 是协议通道：Chrome 按「4 字节小端长度 + JSON」切分收到的字节，
 * 任何一行多余日志都会让 Chrome 把后面的内容当成长度/正文解析，表现为
 * 「扩展一直转圈或报通信错误」。所以本模式下所有日志一律走 stderr。
 */
import { spawn } from 'node:child_process'
import { app } from 'electron'
import {
  NM_EXTENSION_ID,
  NmFrameDecoder,
  encodeNmFrame,
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
 */
export function detectNmHostLaunch(argv: string[]): NmHostDetection | null {
  for (const arg of argv) {
    const m = /^chrome-extension:\/\/([a-p]{32})\/$/.exec(arg)
    if (m) {
      return { origin: arg, trusted: m[1] === NM_EXTENSION_ID }
    }
    if (/^moz-extension:\/\/[0-9a-f-]{36}\/$/.test(arg)) {
      return { origin: arg, trusted: false }
    }
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

function writeFrame(payload: unknown): void {
  try {
    process.stdout.write(encodeNmFrame(payload))
  } catch (e) {
    console.error('[nm] 写应答失败：', e)
  }
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
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' })
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
    writeFrame({ ok: false, error: '这个扩展没有投递权限' })
    setTimeout(() => app.exit(0), 50)
    return
  }

  const decoder = new NmFrameDecoder()
  let finished = false

  const shutdown = (): void => {
    if (finished) return
    finished = true
    app.exit(0)
  }

  process.stdin.on('data', (chunk: Buffer) => {
    const result = decoder.push(chunk)
    if (!result.ok) {
      writeFrame({ ok: false, error: result.error })
      shutdown()
      return
    }
    for (const raw of result.messages) {
      void handleMessage(raw, detection.origin)
    }
  })

  process.stdin.on('end', shutdown)
  process.stdin.on('close', shutdown)
  process.stdin.on('error', shutdown)
  process.stdin.resume()
}

async function handleMessage(raw: unknown, origin: string): Promise<void> {
  const checked = validateNmDeliver(raw)
  if (!checked.ok) {
    writeFrame({ ok: false, error: checked.error })
    return
  }
  const req = checked.value

  const viaApp = await sendToNmBridge(dataDir(), req, origin)
  if (viaApp) {
    writeFrame(viaApp)
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
  writeFrame(response)
}
