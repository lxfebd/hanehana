/**
 * 浏览器扩展投递的主进程接线：桥、注册、排队接手、界面推送。
 *
 * 一次投递的完整链路：
 *   扩展 service worker
 *     → chrome.runtime.sendNativeMessage('com.lxfebd.hanehana', msg)
 *     → Chrome 拉起我们的 exe（宿主模式，见 nmHost）
 *     → 宿主把消息递给本机桥（见 nmBridge）
 *     → 本模块把它变成一个下载任务
 *     → 渲染层收到推送，下载页出现这个任务
 *
 * 建任务的出口复用游戏站那条（manager.add），不另起一套：文件名净化、
 * 重名加后缀、目录补全、并发上限、任务持久化都已经在那一侧做好了。
 */
import { ipcMain, shell, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import {
  NM_EXTENSION_ID,
  NM_HOST_NAME,
  nmRequestHeaders,
  validateNmDeliver,
  type NmDeliverRequest,
  type NmDeliverResponse,
  type NmHostStatus,
  type NmLinkPush,
} from '../shared/nmProtocol'
import { Ipc } from '../shared/ipc'
import { defaultDownloadDir, safeFileName, dataDir } from './store'
import type { AddOutcome } from './manager'
import {
  clearNmPending,
  readNmPending,
  startNmBridge,
  type NmBridgeInfo,
} from './nmBridge'
import {
  NM_BROWSERS,
  nmExtensionDir,
  nmHostManifestPath,
  nmHostRegistration,
  registerNmHost,
  unregisterNmHost,
  type NmBrowserId,
} from './nmHostInstall'

export interface NmServiceDeps {
  /** 拿主窗口，用来推送事件 */
  getWindow: () => BrowserWindow | null
  /** 复用 Manager.add 建任务 */
  addTask: (input: {
    url: string
    dest: string
    threads?: number
    note?: string
    headers?: Record<string, string>
  }) => AddOutcome
  /** 渲染层当前选中的下载目录 */
  getDownloadDir: () => string
  /** 渲染层当前线程数设置 */
  getThreads: () => number
}

/** wireNm 的返回值：拆函数 + 补发排队推送。 */
export interface NmWire {
  /** 注销 IPC handler 并关掉桥。 */
  dispose: () => void
  /** 窗口就绪后补发「排队接手」那批推送。 */
  replayPending: () => void
}

/** 从 URL 里猜文件名：拿路径最后一段，跟游戏站捕获桥同一套口径。 */
function guessName(url: string): string {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
  } catch {
    return ''
  }
}

export function wireNm(deps: NmServiceDeps): NmWire {
  /**
   * 排队接手的推送要补发一次。
   *
   * 接手发生在启动早期，那时窗口还不存在，推给渲染层等于丢进虚空——
   * 用户看到的现象是「链接明明排上了队，下载列表里却什么都没有」。
   * 所以这批推送先存着，等窗口建好由主进程调 replayPending() 重发。
   */
  const pendingPushes: NmLinkPush[] = []
  const push = (p: NmLinkPush): void => {
    if (p.source === 'pending') pendingPushes.push(p)
    deps.getWindow()?.webContents.send(Ipc.NmLink, p)
  }

  /**
   * 把一条投递变成下载任务。
   *
   * 校验在这一层再走一遍：宿主进程已经校验过一次，但桥是本机 TCP 端口，
   * 校验放在真正建任务的地方才不依赖「上一个环节一定靠谱」。
   */
  const deliver = async (
    req: NmDeliverRequest,
    source: 'extension' | 'pending',
  ): Promise<NmDeliverResponse> => {
    const checked = validateNmDeliver(req)
    if (!checked.ok) {
      push({ ok: false, url: typeof (req as { url?: unknown })?.url === 'string' ? (req as { url: string }).url : '', error: checked.error, source })
      return { ok: false, error: checked.error }
    }
    const r = checked.value
    const rawName = r.filename || guessName(r.url)
    const name = rawName ? safeFileName(rawName) : ''
    const dir = deps.getDownloadDir() || defaultDownloadDir()
    // dest 给目录时由 Manager 补全文件名并去重；给文件名时它负责加「(1)」后缀。
    const dest = name ? join(dir, name) : dir
    const headers = nmRequestHeaders(r)
    let outcome: AddOutcome
    try {
      outcome = deps.addTask({
        url: r.url,
        dest,
        threads: deps.getThreads(),
        note: '浏览器扩展',
        headers,
      })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      push({ ok: false, url: r.url, title: r.title, error, source })
      return { ok: false, error }
    }
    push({
      ok: true,
      url: r.url,
      title: r.title,
      taskId: outcome.def.id,
      dest: outcome.def.dest,
      source,
    })
    return {
      ok: true,
      mode: 'engine',
      taskId: outcome.def.id,
      dest: outcome.def.dest,
      message: outcome.duplicate ? '这个链接已经在下载列表里了' : '已加入下载队列',
    }
  }

  const bridge = startNmBridge(dataDir(), (req) => deliver(req, 'extension'))

  /** 应用没开时收到的链接，启动后接手（一条一条来，别并发炸引擎）。 */
  const importPending = async (): Promise<void> => {
    const pending = readNmPending(dataDir())
    if (!pending.length) return
    for (const req of pending) {
      await deliver(req, 'pending')
    }
    clearNmPending(dataDir())
  }

  const status = async (): Promise<NmHostStatus> => {
    const info: NmBridgeInfo = bridge.info
    return {
      hostName: NM_HOST_NAME,
      extensionId: NM_EXTENSION_ID,
      extensionDir: nmExtensionDir(),
      manifestPath: nmHostManifestPath(),
      bridgeRunning: info.port > 0,
      bridgePort: info.port,
      registered: await nmHostRegistration(),
      pending: readNmPending(dataDir()).length,
    }
  }

  ipcMain.handle(Ipc.NmStatus, () => status())

  ipcMain.handle(Ipc.NmInstall, async (_e, browsers: unknown) => {
    const list = Array.isArray(browsers)
      ? (browsers.filter((b): b is NmBrowserId => NM_BROWSERS.includes(b as NmBrowserId)))
      : []
    if (!list.length) return { ok: false, error: '没有选择浏览器' }
    const r = await registerNmHost(list)
    return { ok: r.ok, installed: r.installed, errors: r.errors, status: await status() }
  })

  ipcMain.handle(Ipc.NmUninstall, async (_e, browsers: unknown) => {
    const list = Array.isArray(browsers)
      ? (browsers.filter((b): b is NmBrowserId => NM_BROWSERS.includes(b as NmBrowserId)))
      : []
    if (!list.length) return { ok: false, error: '没有选择浏览器' }
    const r = await unregisterNmHost(list)
    return { ok: r.ok, removed: r.removed, errors: r.errors, status: await status() }
  })

  ipcMain.handle(Ipc.NmOpenExtDir, async () => {
    const dir = nmExtensionDir()
    if (!dir) return { ok: false, error: '没找到扩展目录' }
    const err = await shell.openPath(dir)
    return err ? { ok: false, error: err } : { ok: true, path: dir }
  })

  // 桥起来之后立刻接手排队链接：这时窗口还没建好，推送会丢，
  // 所以推送要等窗口就绪——主进程在窗口建好后调 replayPending() 补发。
  void importPending()

  return {
    dispose: () => {
      ipcMain.removeHandler(Ipc.NmStatus)
      ipcMain.removeHandler(Ipc.NmInstall)
      ipcMain.removeHandler(Ipc.NmUninstall)
      ipcMain.removeHandler(Ipc.NmOpenExtDir)
      bridge.close()
    },
    /** 窗口就绪后补发「排队接手」那批推送。 */
    replayPending: () => {
      const win = deps.getWindow()
      if (!win) return
      for (const p of pendingPushes) win.webContents.send(Ipc.NmLink, p)
    },
  }
}
