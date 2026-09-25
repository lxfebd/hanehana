/**
 * Rust 下载引擎封装。
 *
 * 通信协议是换行 JSON，稳定不变：
 *   - 每个任务一个独立 Rust 子进程（tokio + reqwest）
 *   - stdin 写一行 JSON 命令，stdout 读一行 JSON 事件
 *   - 先 probe（算分段 + 读断点）再 run；之后 pause/resume/stop/set_threads
 *
 * 为什么引擎单独跑进程：下载 I/O 密集，不放进 Electron 主进程才不会阻塞
 * UI 线程和 IPC 分发。Rust 进程本身是独立的，崩溃也只影响单个任务。
 *
 * 引擎复用 FastDrop 的 fastdrop-engine（engine-rs，含多线程分块下载/断点续传/
 * 校验和），打包后随 extraResources 一起分发，不进 asar。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { app } from 'electron'
import type { EngineCommand, EngineEvent, ErrorParams, TaskSnapshot } from '../shared/types'
import { engineProxyFor } from './netConfig'
import { dataDir } from './store'

const CHUNK = 64 * 1024

/** 暂停/停止命令的确认等待上限。超时按「引擎没听见」处理，见 pause()/discard()。 */
const PAUSE_ACK_MS = 1500
const STOP_ACK_MS = 1000
/** probe/run 阶段的心跳超时。正常 probe 是毫秒级，60s 只拦「引擎进程整个挂死」这一种情形。 */
const PROBE_TIMEOUT_MS = 60_000

/** 定位 fastdrop-engine 可执行文件。 */
export function enginePath(): string {
  const root = dirname(process.env.HANEHANA_ROOT ?? process.cwd())
  const exe = process.platform === 'win32' ? 'fastdrop-engine.exe' : 'fastdrop-engine'
  // 打包后引擎在 resources 下（extraResources 放进目录根）；开发时走 engine-rs/target/{release,debug}
  for (const p of [
    join(process.resourcesPath ?? '', exe),
    join(root, 'engine-rs', 'target', 'release', exe),
    join(root, 'engine-rs', 'target', 'debug', exe),
  ]) {
    if (existsSync(p)) return p
  }
  return join(root, 'engine-rs', 'target', 'release', exe)
}

export interface EngineStatus {
  ok: boolean
  path: string
  hint: string
}

/**
 * 引擎自检。
 *
 * 为什么启动就查：引擎缺失（打包漏了 extraResources、开发时忘了 cargo build）
 * 的表现是「应用一切正常，一点下载就失败」，用户几乎不可能自己想到是引擎不在。
 * 结论交给设置页展示，见 Ipc.Hello。
 */
export function engineStatus(): EngineStatus {
  const path = enginePath()
  if (existsSync(path)) return { ok: true, path, hint: '' }
  const hint = app.isPackaged
    ? '安装包里没带下载引擎（fastdrop-engine.exe），下载功能不可用。请重新安装，或把这个情况反馈给开发者。'
    : `没找到下载引擎，下载功能不可用。在仓库根目录执行：cd engine-rs && cargo build --release（期望路径 ${path}）`
  return { ok: false, path, hint }
}

function emptySnap(url: string, dest: string, state: string): TaskSnapshot {
  return {
    url,
    dest,
    filename: basename(dest),
    total: 0,
    downloaded: 0,
    progress: 0,
    speed: 0,
    eta: 0,
    state: state as TaskSnapshot['state'],
    error: '',
    error_code: '',
    error_params: null,
    threads: 0,
    segments: [],
    finished_at: 0,
    verifying: false,
  }
}

/** 包装单个任务的引擎子进程。对外接口与老 RustTask 一致。 */
export class EngineTask {
  state: TaskSnapshot['state'] = 'idle'
  error = ''
  /**
   * 与 `error` 配套的稳定错误码，'' = 没有错误或主进程自产的失败。
   * 必须和 error 同时改：只改原文的话界面会拿上一条错误的码去查文案，
   * 报出来的病因和原文对不上。一律走 setError()/clearError()。
   */
  errorCode = ''
  errorParams: ErrorParams = null
  speed = 0

  /** 记一次失败。主进程自己判定的失败没有码，传空串即可（界面退回原文匹配）。 */
  private setError(msg: string, code = '', params: ErrorParams = null): void {
    this.error = msg
    this.errorCode = code
    this.errorParams = params
  }

  private clearError(): void {
    this.setError('')
  }

  onState?: (task: EngineTask) => void
  onProgress?: (task: EngineTask) => void
  /** probe 报回长度、还没发 run 时被叫一次：主进程在这里做磁盘预检并决定是否放行。 */
  onProbed?: (task: EngineTask) => void

  private proc: ChildProcess | null = null
  private snap: TaskSnapshot | null = null
  private alive = false
  private pendingRun = false
  /** 当前这个子进程有没有已经 probe 过。换新进程必须重来——引擎是按命令记任务的。 */
  private probed = false
  private writeBuf: Buffer[] = []
  private draining = false
  private stdoutBuf = ''
  /** probe 发出后的心跳看门狗，见 sendStartCommands()。 */
  private probeWatchdog: ReturnType<typeof setTimeout> | null = null
  /** 挂在 stdin 上的 drain 回调（flush 里 once 注册的）。terminate 时摘掉，避免泄漏。 */
  private drainCb: (() => void) | null = null

  constructor(
    public readonly url: string,
    public readonly dest: string,
    public threads: number,
    /**
     * 用户在设置里填的代理原文（''=跟随系统代理）。不能直接下发给引擎：
     * 留空时要按目标地址问一次 Chromium（PAC 逐地址给结论），见 resolveThenSend()。
     */
    public proxySetting = '',
    public userAgent = '',
  ) {}

  /**
   * 换上当前设置里的代理与 UA。生效时机是「下一轮 probe/run」：
   * 正在跑的进程里 reqwest 的 client 已经建好了，换不了。
   */
  setNetworkConfig(proxySetting: string, userAgent: string): void {
    this.proxySetting = proxySetting
    this.userAgent = userAgent
  }

  /** 本轮实际生效的代理 URL，'' = 直连。run() 里解析出来，probe 命令带的是它。 */
  private effectiveProxy = ''

  /**
   * 建出「当前这条已探测计划」时用的网络出口（代理 + UA），probe 发出时记下。
   *
   * 为什么非得记：引擎的 reqwest client 只在 probe 时按代理建，`run` 命令里没有
   * 代理字段（引擎也读不到），而任务失败后子进程**不会退出**——于是「继续下载」
   * 会复用那个老 client。用户看到的正是「我按提示填了代理点了继续，怎么还是 403」。
   */
  private planNet = ''

  /** 出口指纹：代理 + UA。probe 与换进程判定必须用同一个算法，否则比对会长期错位。 */
  private netKey(): string {
    return `${this.effectiveProxy}\n${this.userAgent}`
  }

  /** 本任务限速，KiB/s，0 = 不限。改值要走 setRate()，才能立刻推给引擎。 */
  rateLimitKbps = 0
  /** 期望校验和，`算法:十六进制`；空串 = 下完不校验。 */
  checksum = ''

  snapshot(): TaskSnapshot {
    return this.snap ?? emptySnap(this.url, this.dest, this.state)
  }

  private spawnProc(): void {
    // 只认「确实还活着」的进程。子进程已经退出、close 事件却还没送达时，
    // 句柄是非空但管道是死的——这时必须重新 spawn，否则命令全丢进死管道。
    if (this.proc && this.proc.exitCode === null && this.proc.signalCode === null) {
      this.alive = true
      return
    }
    const st = engineStatus()
    if (!st.ok) {
      // 这里给的是「怎么修」，不是「文件不在」：用户看到的是任务失败原因，
      // 一句路径帮不上忙（见 engineStatus）。hint 走 params 而不是靠正则认原文：
      // 开发态的 hint 是「去 cargo build」，安装态是「重装」，同一句固定 advice 盖不住。
      this.setError(st.hint, 'engine_missing', { hint: st.hint })
      this.setState('error')
      return
    }
    const exe = st.path
    const proc = spawn(exe, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // 不让子进程持有终端句柄，避免打包后残留窗口
      detached: false,
      windowsHide: true,
    })
    this.proc = proc
    this.alive = true
    // 新进程脑子里没有这个任务的任何上下文：不重新 probe 就发 run，它会当成
    // 「没我的事」而什么都不做，任务永远卡在准备中。
    this.probed = false
    // 上一任进程留下的半行不能拼到新进程的输出上
    this.stdoutBuf = ''
    this.writeBuf = []
    this.draining = false

    // Rust 引擎的 stderr 是诊断信息（HTTP 错误、panic），收集起来便于排错。
    proc.stderr?.on('data', (d: Buffer) => {
      appendFileSync(logPath(), `[engine ${this.url.slice(0, 80)}] ${d.toString('utf8')}`)
    })

    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      if (this.proc === proc) this.onStdout(chunk)
    })

    // 往已死的管道写数据（例如刚 kill 完又发了一条命令）会异步抛 EPIPE。
    // 没有这个监听器就是 uncaughtException —— 整个主进程连同所有正在下载的任务
    // 一起没掉，一个任务的取消不该有这种代价。
    proc.stdin?.on('error', () => {
      this.writeBuf = []
    })

    proc.on('error', (e) => {
      if (this.proc !== proc) return
      this.setError(`引擎启动失败: ${e.message}`, 'engine_spawn_failed')
      this.setState('error')
    })
    proc.on('close', () => {
      // 只处理当前这个实例。retry 会先杀旧进程再立刻 spawn 新的，旧 child 的
      // close 事件晚一拍到达；不判断就会把新进程的句柄清掉，任务从此卡死。
      if (this.proc !== proc) return
      this.alive = false
      this.proc = null
      this.clearProbeWatchdog()
      // 管道死了，drain 事件永远不会再来；不清掉的话下个进程的第一次写
      // 会卡在 draining=true 上，命令永远进不了管道。
      this.draining = false
      if (this.drainCb) {
        this.drainCb = null
      }
      // 子进程意外退出（非 stop 触发）视为失败
      if (this.state !== 'done' && this.state !== 'cancelled') {
        this.setState('error')
      }
    })
  }

  /** 启动/恢复这一轮下载。真正发命令在 resolveThenSend() 里——代理要先按地址解析。 */
  run(): void {
    if (this.state === 'downloading' || this.state === 'done') return
    this.clearPauseWatchdog()
    this.clearProbeWatchdog()
    this.clearError()
    this.spawnProc()
    // 「引擎到底起没起来」只能看子进程，不能看状态。失败任务的状态本来就是 error，
    // 拿状态当闸门会让「继续下载」「全部开始」「重试全部失败」全部静默变成空操作，
    // 而 IPC 照样回 ok —— 用户看到的正是「点了没反应，按钮像坏的」。
    if (!this.alive) return
    this.setState('preparing')
    // 上一轮的失败原因不能留着：重下的一瞬间界面还写着「磁盘空间不足」，
    // 用户会以为点了没生效。状态已经是准备中了，理由就该清空，等新错误再说。
    if (this.snap && (this.snap.error || this.snap.error_code)) {
      this.snap = { ...this.snap, error: '', error_code: '', error_params: null }
    }
    void this.resolveThenSend()
  }

  /**
   * 发命令之前先把代理定下来。
   *
   * 两件事决定了不能拿构造时的值：
   * 1. 用户在设置里改完代理，下一个动作就该用新值——构造期定死的话，
   *    老任务会一路用旧代理直到进程结束；
   * 2. 「留空 = 跟随系统代理」在 Windows 上意味着注册表设置 + PAC + 按地址例外，
   *    只有 Chromium 知道结果，而那是异步的、逐目标地址的。
   */
  private async resolveThenSend(): Promise<void> {
    try {
      this.effectiveProxy = await engineProxyFor(this.url, this.proxySetting)
    } catch (e) {
      this.setError(
        `代理配置没能生效：${e instanceof Error ? e.message : String(e)}`,
        'proxy_resolve_failed',
      )
      this.setState('error')
      return
    }
    // 出口和建计划时不一样就得换进程重探：老进程里的 client 是上一轮的代理建的，
    // run 命令改不动它（见 planNet 的注释）。terminate 不发 stop，断点保留。
    if (this.alive && this.probed && this.netKey() !== this.planNet) {
      this.terminate()
      this.spawnProc()
    }
    // 解析这一会儿用户可能已经点了暂停/取消，也可能进程已经退了
    if (!this.alive || this.state !== 'preparing') return
    this.sendStartCommands()
  }

  /** 引擎里 probe 和 run 是两条命令：probe 只算分段和续传偏移，
   *  状态停在 idle；要真正开始得再发 run。 */
  private sendStartCommands(): void {
    try {
      if (!this.probed) {
        // 这份计划（以及引擎里那个 client）就是用当前出口建出来的，记下来；
        // 下一轮出口变了就换进程重探，见 planNet。
        this.planNet = this.netKey()
        // probe 之后先停一手，等主进程回答「这块盘装得下吗」再发 run。
        // 引擎收到 run 干的第一件事就是把 .part 预分配成 total 那么大，
        // 等进度事件出来再拦，磁盘上已经躺着一个巨无霸了。
        this.pendingRun = true
        // 心跳看门狗：probe/run 的正常路程是毫秒级，超时只可能是引擎进程
        // 挂死（不退出、不报事件）。挂死的任务永远占着并发槽，排队任务整队
        // 卡死——超时就按失败处理，断点保留，用户点「继续」重新拉起进程。
        this.armProbeWatchdog()
        this.send({
          cmd: 'probe',
          url: this.url,
          dest: this.dest,
          threads: this.threads,
          proxy: this.effectiveProxy,
          user_agent: this.userAgent,
          rate_limit_kbps: this.rateLimitKbps,
          checksum: this.checksum,
        })
        return
      }
      // run 也带上限速与校验和：同一个子进程可能被 resume/pause 反复拉起，
      // 期间用户在设置里改过限速，只靠 probe 那条就把新值漏掉了。
      this.sendRun()
    } catch (e) {
      this.setError(e instanceof Error ? e.message : String(e), 'engine_unavailable')
      this.setState('error')
    }
  }

  /**
   * probe 报回长度之后的放行关口：先让主进程做磁盘预检，通过才真正开下。
   *
   * 这也是唯一能挡住「站点谎报 Content-Length」的位置——预分配一旦做了，
   * 轻则任务失败留下半截文件，重则把用户的盘撑到红线。
   */
  private confirmRun(): void {
    if (!this.pendingRun) return
    this.pendingRun = false
    this.probed = true
    this.onProbed?.(this)
    // 回调里可能就 fail() 了（磁盘装不下）：那时进程已被终止、状态已是 error，
    // 再发 run 等于对着一具尸体下命令。
    if (!this.alive || this.state === 'error' || this.state === 'cancelled') return
    // 探测期间用户点了暂停：不能把 run 发出去。发了就是「按了暂停它还在下」——
    // probed 已经记下，resume 走 run() 时会直接发 run，不用重探。
    if (this.state === 'paused') return
    this.sendRun()
  }

  /** 发 run 命令（带上本轮的限速与校验和）。失败就地报成 error，不让它静默卡住。 */
  private sendRun(): void {
    try {
      this.send({ cmd: 'run', rate_limit_kbps: this.rateLimitKbps, checksum: this.checksum })
    } catch (e) {
      this.setError(e instanceof Error ? e.message : String(e), 'engine_unavailable')
      this.setState('error')
    }
  }

  pause(): void {
    if (this.state !== 'downloading' && this.state !== 'preparing') return
    this.setState('paused')
    try {
      this.send({ cmd: 'pause' })
    } catch (e) {
      this.setError(e instanceof Error ? e.message : String(e), 'engine_unavailable')
      this.setState('error')
      return
    }
    // 兜底：分段正卡在 socket 读上时，引擎可能几秒都不回暂停确认，而界面已经
    // 写着「已暂停」、速率却还在涨——用户看到的正是「暂停没用」。1.5s 没等到
    // 确认就终止进程。不发 stop，所以 .part 与 sidecar 都留着，继续下载能接着下。
    this.clearPauseWatchdog()
    this.pauseWatchdog = setTimeout(() => {
      this.pauseWatchdog = null
      if (this.state === 'paused') this.terminate()
    }, PAUSE_ACK_MS)
  }

  /** 暂停确认看门狗，见 pause()。任何离开 paused 的路径都必须清掉它。 */
  private pauseWatchdog: ReturnType<typeof setTimeout> | null = null

  private clearPauseWatchdog(): void {
    if (!this.pauseWatchdog) return
    clearTimeout(this.pauseWatchdog)
    this.pauseWatchdog = null
  }

  /**
   * 上 probe 心跳看门狗，见 sendStartCommands()。
   * 进程被 terminate 时同步清掉：挂着的定时器会在新进程的头上炸，
   * 把刚恢复的任务误判成「引擎挂死」。
   */
  private armProbeWatchdog(): void {
    this.clearProbeWatchdog()
    this.probeWatchdog = setTimeout(() => {
      this.probeWatchdog = null
      // 只有还停在准备中才判死：这段时间用户可能已经点了暂停/取消，
      // 那些路径都自带了状态迁移，不该被这里覆盖。
      if (this.state !== 'preparing') return
      this.fail(
        'engine process hung during probe/run; try resume',
        'engine_hang',
        {},
      )
    }, PROBE_TIMEOUT_MS)
  }

  private clearProbeWatchdog(): void {
    if (!this.probeWatchdog) return
    clearTimeout(this.probeWatchdog)
    this.probeWatchdog = null
  }

  resume(): void {
    this.clearPauseWatchdog()
    this.run()
  }

  setThreads(n: number): void {
    this.threads = Math.max(1, Math.floor(n))
    if (!this.proc) return
    try {
      this.send({ cmd: 'set_threads', n: this.threads })
    } catch {
      // 引擎拒绝（例如分段不支持）就忽略，下次 probe 会重算
    }
  }

  /**
   * 改限速，KiB/s（0 = 不限）。
   *
   * 没有活进程时只记在字段上：下一条 probe/run 会带上它。发 set_rate 给一个
   * 已经退出的子进程只会写进死管道，那个成本是这个任务不该付的。
   */
  setRate(kbps: number): void {
    this.rateLimitKbps = Math.max(0, Math.floor(kbps))
    if (!this.proc) return
    try {
      this.send({ cmd: 'set_rate', rate_limit_kbps: this.rateLimitKbps })
    } catch {
      // 引擎版本不认识这条命令时会回 error，忽略即可：下次 probe 带上值
    }
  }

  /**
   * 终止子进程并保留断点（移除任务、退出程序都用它）。
   *
   * 这里绝不能发 `stop`：引擎侧 stop 的语义是「放弃下载」，它会删掉 .part 和
   * sidecar。以前 kill() 无条件先发 stop，于是每次关窗退出都把正在下的文件连进度
   * 一起删干净，下次启动从零重下。引擎每 100ms 自己落一次 sidecar，
   * 直接杀进程最多丢 100ms 的偏移量。
   */
  kill(): void {
    this.terminate()
    this.setState('cancelled')
  }

  /**
   * 放弃已下进度并终止子进程：只有「重新下载」(retry) 该用。
   *
   * 必须等引擎对 `stop` 作出反应再 kill：引擎收到 stop 要收尾分段、删 .part 与
   * sidecar，那是一串磁盘操作。以前这里发完命令立刻 proc.kill()，stop 有没有被
   * 处理全看运气，剩下的半截文件就留在磁盘上（retry 的调用方随后补删，但那是
   * 兜底，不是设计）。1s 没退出就强杀。
   */
  async discard(): Promise<void> {
    const proc = this.proc
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      try {
        this.send({ cmd: 'stop' })
      } catch {
        // 进程可能已经退出
      }
      await waitExit(proc, STOP_ACK_MS)
    }
    this.terminate()
    this.setState('cancelled')
  }

  /**
   * 由主进程判定失败（例如磁盘快满了，继续写下去只会写坏）。
   *
   * 保留断点：腾出空间后点「继续下载」应当接着下，而不是从零重下——所以这里
   * 走 kill 而不是 discard。error 必须先进快照再改状态，理由同 handleEvent 的
   * error 分支：反过来的话失败原因落不进盘。
   */
  fail(reason: string, code = '', params: ErrorParams = null): void {
    if (this.state === 'done' || this.state === 'error') return
    this.terminate()
    this.setError(reason, code, params)
    this.snap = {
      ...(this.snap ?? emptySnap(this.url, this.dest, 'error')),
      error: reason,
      error_code: code,
      error_params: params,
    }
    this.forceState('error')
    this.emitProgress()
  }

  private terminate(): void {
    this.alive = false
    this.writeBuf = []
    this.draining = false
    if (this.drainCb) {
      // 旧进程的 stdin 已经死了，drain 事件永远不会再来；不摘掉这个 once
      // 监听就会泄漏一个闭包，还会让下个进程的第一次写卡在 draining=true。
      this.proc?.stdin?.off('drain', this.drainCb)
      this.drainCb = null
    }
    this.clearPauseWatchdog()
    this.clearProbeWatchdog()
    if (this.proc) {
      this.proc.kill()
      this.proc = null
    }
  }

  /**
   * 写一行命令到 stdin。引擎按行解析，不做流式。
   *
   * 必须同步落笔：调用方（stop/kill/pause）紧接着就 proc.kill()。
   * 之前这里把字节塞进 writeBuf、用 setImmediate 到下一个 tick 才写，于是
   * 「发 stop」和「杀进程」之间隔了一个事件循环轮次——stop 永远没机会进管道，
   * 引擎被 SIGTERM 直接打死，来不及把分段进度写回 .part.meta，重启后已下的
   * 部分只能重下。
   */
  private send(cmd: EngineCommand): void {
    const stdin = this.proc?.stdin
    if (!stdin || !stdin.writable) {
      throw new Error('引擎进程不可用')
    }
    this.writeBuf.push(Buffer.from(JSON.stringify(cmd) + '\n', 'utf8'))
    this.flush()
  }

  private flush(): void {
    const stdin = this.proc?.stdin
    if (!stdin || !stdin.writable) {
      // 进程没了，残留在缓冲里的命令也没有接收方了
      this.writeBuf = []
      this.draining = false
      return
    }
    while (this.writeBuf.length) {
      if (this.draining || !stdin.write(this.writeBuf[0])) {
        // 管道满：等 'drain' 再续写。没有 drain 监听就会一直漏写或重复挂监听。
        if (!this.draining) {
          this.draining = true
          this.drainCb = () => {
            this.draining = false
            this.drainCb = null
            this.flush()
          }
          stdin.once('drain', this.drainCb)
        }
        return
      }
      this.writeBuf.shift()
    }
  }

  /** 消费 stdout 的 JSON 事件，转成内存快照。 */
  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk
    let idx: number
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim()
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1)
      if (line) this.handleEvent(line)
    }
    // 防止进程退出前未 flush 的尾部
    if (this.stdoutBuf.length > CHUNK * 8) {
      this.stdoutBuf = this.stdoutBuf.slice(-CHUNK)
    }
  }

  private handleEvent(line: string): void {
    let msg: EngineEvent
    try {
      msg = JSON.parse(line) as EngineEvent
    } catch {
      return // 非 JSON 行（引擎的诊断输出）忽略
    }

    switch (msg.event) {
      case 'progress': {
        const data = msg.data ?? {}
        // preparing 阶段只发 {"state":"preparing"}，其余字段全缺。用空快照打底
        // 再覆盖，保证 UI 依赖的键永远存在——否则行刷新会在 snap.progress 上炸。
        const cur: TaskSnapshot = {
          ...emptySnap(this.url, this.dest, this.state),
          ...(this.snap ?? {}),
          ...data,
        }
        cur.url = cur.url || this.url
        cur.dest = cur.dest || this.dest
        cur.filename = cur.filename || basename(this.dest)
        cur.progress = Number(cur.progress) || 0
        cur.speed = Number(cur.speed) || 0
        cur.eta = Number(cur.eta) || 0
        cur.finished_at = Number(cur.finished_at) || 0
        cur.error = cur.error ?? ''
        cur.error_code = cur.error_code ?? ''
        cur.error_params = cur.error_params ?? null
        // 码必须跟原文同生共死：原文空了码也得空。否则界面会拿上一条错误的码
        // 去查文案，报出来的病因和任务当前的实际状态对不上。
        if (!cur.error) {
          cur.error_code = ''
          cur.error_params = null
        }
        cur.segments = cur.segments ?? []
        // 校验标志只认当前这一条应答，不继承上一条：preparing 的 ack 不带这个字段，
        // 用展开留下的旧值会让任务从上一轮就一直挂着「校验中」。
        cur.verifying = data.verifying === true
        if (data.state) cur.state = data.state
        this.snap = cur
        if (data.state) {
          // probe 回来的快照状态是 idle。但这一瞬我们其实正卡在「等主进程放行 run」
          // 上：状态要是退成排队中，用户在这毫秒级窗口点暂停会被 pause() 直接 return
          // 掉，命令却照样发出去——所以这一段对外一律显示准备中。
          let ns: TaskSnapshot['state'] =
            this.pendingRun && data.state === 'idle' ? 'preparing' : data.state
          // 迟到的暂停确认不算数：pause() 先置 paused 再发命令，用户紧接着点
          // 「继续」会连带发 run；引擎处理完 pause 才回的 {"state":"paused"} 到达
          // 时任务已经在恢复途中，拿它改状态会把「正在跑」打回「已暂停」，
          // UI 上看到的就是「我按了继续它还是停着」。看门狗还挂着 = 仍在等这条
          // 确认，这时才认；恢复路径已经把看门狗清了，迟到的这条直接忽略——
          // 保持当前状态（preparing/downloading 都如实），等下一条真正的
          // 带 state 的 progress 再纠正。
          if (ns === 'paused' && !this.pauseWatchdog) {
            ns = this.state
          }
          cur.state = ns
          this.setState(ns)
          // 引擎自己报「已暂停」= 它听见了 pause 命令，看门狗可以撤了
          if (ns === 'paused') this.clearPauseWatchdog()
          // 走出准备中就撤心跳看门狗：probe/run 已经走通，剩下的进度事件
          // 源源不断，它没用了。留着只会等 60s 后白跑一趟。
          if (ns !== 'preparing' && ns !== 'idle') this.clearProbeWatchdog()
          if (this.state !== 'downloading') this.speed = 0
        } else {
          this.speed = Number(data.speed ?? 0) || 0
        }
        // 只在「探测完成」那条快照上放行。引擎收到 probe 后先回一条只有
        // {"state":"preparing"} 的应答——它里面的 total 是从上一轮继承来的，
        // 拿它当放行时机等于让预检用旧长度把重下瞬间再拦一次，站点根本没被重新
        // 问过（用户腾完空间点继续，看到的还是同一条「磁盘空间不足」）。
        if (this.pendingRun && data.state === 'idle') this.confirmRun()
        this.emitProgress()
        break
      }
      case 'done': {
        const total = Number(msg.total || this.snap?.total || 0)
        this.snap = {
          ...(this.snap ?? emptySnap(this.url, this.dest, 'done')),
          downloaded: total,
          total,
          progress: 1,
          speed: 0,
          eta: 0,
          // done 之后不可能还在校验。不落 false 的话，界面会在「已完成」的任务上
          // 一直挂着「校验中」——而校验中是不给点暂停的。
          verifying: false,
          finished_at: Date.now() / 1000,
        }
        this.speed = 0
        this.forceState('done')
        this.emitProgress()
        break
      }
      case 'error': {
        // 码只认这条事件自己带的，不去继承上一条：任务重试成功后老码还留在快照里，
        // 继承过来就是「新错误配旧病因」。
        const code = typeof msg.code === 'string' ? msg.code : ''
        const params = (msg.params ?? null) as ErrorParams
        this.setError(String(msg.error ?? '未知错误'), code, params)
        // 错误文案也要先进快照，再通知状态——反过来的话 onState 读到的还是旧快照，
        // 失败原因就落不到盘上，重启后列表只剩一个「失败」而没有为什么。
        // 校验失败也走这条：文件留着，进度留着，只把「校验中」摘掉。
        this.snap = {
          ...(this.snap ?? emptySnap(this.url, this.dest, 'error')),
          error: this.error,
          error_code: code,
          error_params: params,
          verifying: false,
        }
        this.forceState('error')
        this.emitProgress()
        break
      }
      default:
        break
    }
  }

  /**
   * 改状态。
   *
   * 除了更新内存里的 this.state，还必须把新状态同步回 this.snap：
   * snapshot() 返回的是缓存的快照，而 progress 事件在 preparing 阶段写进去的
   * state 是 'preparing'。如果只改 this.state，失败或暂停的任务在 UI 上会永远
   * 卡在「准备中」——用户看到引擎进程已经死透了，状态却纹丝不动。
   * speed 只在非下载态清零，避免把正在跑的实时速率抹掉。
   */
  private setState(next: TaskSnapshot['state']): void {
    if (this.state === next) return
    this.state = next
    this.snap = {
      ...(this.snap ?? emptySnap(this.url, this.dest, next)),
      state: next,
    }
    if (next !== 'downloading') this.snap.speed = 0
    this.onState?.(this)
  }

  /**
   * 终态专用通知：即使 this.state 已经是这个值，也照样回调一次 onState。
   *
   * 引擎经常先用一条 `{"state":"done"}` 的 progress 把状态报上来，随后的 done
   * 事件才补上完成时间。走 setState 的话第二次因为「状态没变」直接 return，
   * manager 就不会把 finished_at 落盘——重启后列表里的任务永远显示「完成于 –」。
   * error 同理：错误原因可能只在 error 事件里出现一次。
   */
  private forceState(next: TaskSnapshot['state']): void {
    this.state = next
    this.snap = {
      ...(this.snap ?? emptySnap(this.url, this.dest, next)),
      state: next,
    }
    if (next !== 'downloading') this.snap.speed = 0
    this.onState?.(this)
  }

  private emitProgress(): void {
    try {
      this.onProgress?.(this)
    } catch {
      // UI 回调不应影响下载本身
    }
  }
}

/**
 * 等子进程退出，最多等 ms 毫秒。
 *
 * 用途是「发了收尾命令再给它一点时间做完」：直接 kill 会把它正在写的东西截断。
 * 超时也算正常返回——调用方接着强杀，语义是「等过了，它没动静」。
 */
function waitExit(proc: ChildProcess, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.off('exit', onExit)
      resolve()
    }, ms)
    function onExit(): void {
      clearTimeout(timer)
      resolve()
    }
    proc.once('exit', onExit)
  })
}

function logPath(): string {
  const dir = dataDir()
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // 忽略
  }
  return join(dir, '.engine-stderr.log')
}

/** 数据目录（G15 便携模式后与 store.ts 同源）：日志落盘位置与下载引擎无关，仅复用目录。 */
export { dataDir } from './store'