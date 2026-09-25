/**
 * HaneHana 主进程入口。
 *
 * 职责：起窗口（不透明底 + 网页层毛玻璃 + 自定义标题栏）、管托盘、
 * 持有下载调度器（Manager）、把任务事件透传给渲染进程。
 * 渲染进程不直接接触 Node 和文件系统——一切经由 preload 的 contextBridge。
 *
 * 窗口材质设计（实测结论）：
 *   - 窗口底色不透明（深 #0A0A0A / 浅 #F7F7F8）。不用 Mica：
 *     透明底 + backgroundMaterial:'mica' 在真机会直接漏出身后窗口（Mica 只采样壁纸），
 *     内容区无底时穿透，比纯色更糟。
 *   - 圆角：Win11 DWM 对所有顶层窗口自动绘制，无需任何 API。
 *   - 毛玻璃：全在网页层——.app-bg 动态模糊封面底 + 半透明面板 backdrop-filter。
 *   - 标题栏：titleBarStyle: 'hidden' + titleBarOverlay 保留系统三个按钮，
 *     渲染层用 app-region: drag 画自定义标题栏。
 */
import { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage, nativeTheme, Notification, powerSaveBlocker, protocol, shell, Tray } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Ipc } from '../shared/ipc'
import { explainError } from '../shared/errors'
import { fileName, fmtSize, fmtSpeed } from '../shared/format'
import type { Settings, TaskProgressPush, TaskRow } from '../shared/types'
import { normalizeChecksum } from '../shared/types'
import { loadGames, getGames, getGame, ensureCoversDir, sanitizeGamePatch } from './gameStore'
import { handleScan, handleRemove, handleUpdate, handleBatchUpdate, handleBatchRemove, handleOpenDir, handleLaunch, handleRunning, detachAllRunning, setSessionSink, setCrashNotifier, handleSteamImport, setAutoBackup, setToolPaths } from './games'
import { createSnapshot, deleteSnapshot, listAllBackups, restoreSnapshot, rotateSnapshots, syncToCloud } from './saves'
import { scanSteamLibrary } from './steam'
import { engineStatus } from './engine'
import { searchScrape, applyScrape } from './scraper'
import { backfillThumbs, handleHhProtocol, registerThumbProtocol } from './thumbs'
import { Manager } from './manager'
import { normalizeSettings, Store, dataDir, isPortable } from './store'
import { computeOverview } from './stats'
import { applyChromiumProxy } from './netConfig'
import { proxyFormatError } from '../shared/proxy'
import { TRAY_ICON_DATA_URL } from './trayIcon'
import { checkUpdate, initAutoUpdater, installUpdate, setUpdatePush, updateEnabled } from './updater'
import { wireSites } from './sites/bridge'
import { addTrack, checkTracks, loadTracking, removeTrack } from './tracking'
import type { TrackCheckResult } from '../shared/types'

const here = dirname(fileURLToPath(import.meta.url))
const preloadPath = join(here, '../preload/index.cjs')

app.setAppUserModelId('com.hanehana.app')

// 自定义 scheme 必须在 whenReady 之前注册（REDESIGN-SPEC §3.4）
registerThumbProtocol()

// 开发调试：设置 HANEHANA_DEBUG_PORT 时开启 CDP 端口，供 CDP 探针验证 UI。
// 打包产物一律不开——CDP 端口等于把渲染进程的控制权开放给本机任意进程。
if (process.env.HANEHANA_DEBUG_PORT && !app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.HANEHANA_DEBUG_PORT)
}

// 打包产物的 smoke 探活专用逃生门：仅当显式设置 HANEHANA_SMOKE_PORT 才开 CDP，
// 只服务 dist:dir 验收（scripts/smoke_packaged.mjs），与 HANEHANA_DEBUG_PORT
// 分开命名避免误用——日常启动不带这个变量，安全面与 D14 保持一致。
if (process.env.HANEHANA_SMOKE_PORT && app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.HANEHANA_SMOKE_PORT)
}

// 单实例锁：避免双开导致数据互踩（两份内存任务表全量覆盖写 tasks.json）。
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showWindow()
  })
}

let win: BrowserWindow | null = null
let tray: Tray | null = null
let trayTimer: ReturnType<typeof setInterval> | null = null
let store: Store
let manager: Manager

function showWindow(): void {
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function winBackground(dark: boolean): string {
  // 窗口必须不透明：实测 #00000000 + Mica 在真机是"穿透"的——
  // Mica 只采样壁纸、不模糊其后其它窗口，内容区无封面底时直接漏出桌面，
  // 比纯色更糟。圆角由 Win11 DWM 对所有顶层窗口自动绘制，不依赖 Mica；
  // "液态玻璃"改在网页层用「动态模糊封面底 + 半透明面板」实现，稳定可控。
  return dark ? '#0A0A0A' : '#F7F7F8'
}

/** 渲染层设置里的 dark → 主进程窗口与原生控件主题同步 */
function applyThemeToWindow(dark: boolean): void {
  nativeTheme.themeSource = dark ? 'dark' : 'light'
  if (win && !win.isDestroyed()) {
    win.setBackgroundColor(winBackground(dark))
    win.setTitleBarOverlay({ color: '#00000000', symbolColor: dark ? '#ffffff' : '#18181B', height: 40 })
  }
}

/**
 * 三态主题模式 → 主进程侧生效值。
 * - system：nativeTheme.themeSource = 'system'，由系统深浅决定
 * - dark/light：固定覆盖
 * 返回当前生效的 dark（供窗口/渲染层同步），系统模式时取 shouldUseDarkColors。
 */
function applyThemeMode(mode: 'system' | 'dark' | 'light'): boolean {
  if (mode === 'system') {
    nativeTheme.themeSource = 'system'
    return nativeTheme.shouldUseDarkColors
  }
  nativeTheme.themeSource = mode
  return mode === 'dark'
}

function createWindow(): void {
  const initialDark = store ? store.loadSettings().dark : true
  const winOpts: Electron.BrowserWindowConstructorOptions = {
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: winBackground(initialDark),
    title: 'HaneHana · 羽花',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: initialDark ? '#ffffff' : '#18181B', height: 40 },
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // 游戏站页签的内嵌浏览器（OOPIF，自带独立会话）
      webviewTag: true,
    },
  }

  win = new BrowserWindow(winOpts)
  // 三态：system 模式跟随系统当前深浅（而不是写死的 initialDark）
  const effDark = applyThemeMode(store ? store.loadSettings().theme_mode : 'dark')
  applyThemeToWindow(effDark)

  win.on('ready-to-show', () => {
    win?.show()
  })

  win.on('closed', () => {
    win = null
  })

  // 下载完成/失败时窗口不在前台会闪任务栏图标；用户一点回来就得停。
  win.on('focus', () => win?.flashFrame(false))

  // 窗口内的外链交给系统浏览器，不要开新的 Electron 窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 全屏状态变化：同步给渲染层（点系统手势 / Esc / 切走再切回都要一致）
  win.on('enter-full-screen', () => {
    win?.webContents.send(Ipc.FullscreenChanged, true)
  })
  win.on('leave-full-screen', () => {
    win?.webContents.send(Ipc.FullscreenChanged, false)
  })

  // 开发模式走 electron-vite dev server，生产加载打包产物。
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(here, '../renderer/index.html'))
  }
}

// ---------------------------------------------------------------- 托盘
function createTray(): void {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL)
  tray = new Tray(icon)
  tray.setToolTip('HaneHana · 羽花')
  tray.on('right-click', () => tray?.popUpContextMenu(buildTrayMenu()))
  tray.on('click', () => showWindow())
  refreshTray()
  trayTimer = setInterval(refreshTray, 1000)
}

/** 托盘悬浮提示：软件藏在托盘时，这是唯一的「它还在干活」的证据。 */
function trayTooltip(): string {
  if (!manager) return 'HaneHana · 羽花'
  const c = manager.statusCounts()
  const bits = [`HaneHana · ${c.downloading} 个下载中`]
  if (manager.totalSpeed() > 0) bits.push(fmtSpeed(manager.totalSpeed()))
  if (c.done) bits.push(`完成 ${c.done}`)
  if (c.error) bits.push(`失败 ${c.error}`)
  if (c.paused) bits.push(`暂停 ${c.paused}`)
  return bits.join(' · ')
}

function buildTrayMenu(): Menu {
  const c = manager?.statusCounts()
  return Menu.buildFromTemplate([
    { label: '显示窗口', click: () => showWindow() },
    { type: 'separator' },
    {
      label: '全部开始',
      enabled: !!c && (c.paused > 0 || c.queued > 0 || c.error > 0),
      click: () => void manager?.actionAll('start'),
    },
    {
      label: '全部暂停',
      enabled: !!c && c.downloading > 0,
      click: () => void manager?.actionAll('pause'),
    },
    {
      label: '重试全部失败',
      enabled: !!c && c.error > 0,
      click: () => void manager?.retryFailed(),
    },
    {
      label: '清空已完成',
      enabled: !!c && c.done > 0,
      click: () => void manager?.actionAll('clear-finished'),
    },
    { type: 'separator' },
    {
      label: '打开数据目录',
      click: () => {
        const why = shell.openPath(dataDir())
        if (why) dialog.showErrorBox('打不开数据目录', `${why}\n${dataDir()}`)
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => quit() },
  ])
}

/** 每秒同步一次托盘文字与系统休眠抑制。窗口关了也必须继续跑，所以走定时器。 */
function refreshTray(): void {
  if (!manager) return
  try {
    tray?.setToolTip(trayTooltip())
  } catch {
    // 托盘在某些时刻（系统休眠恢复的一瞬）会拒绝写入，不影响下载本身
  }
  syncKeepAwake()
}

// ---------------------------------------------------------------- 防休眠
//
// prevent-app-suspension 而不是 prevent-display-sleep：合集动辄十几 GB，要的是
// 「别睡过去把下载掐了」，不是「屏幕一直亮着」。默认关（keep_awake=false），
// 因为改变系统电源行为必须由用户点头。
let awakeBlockerId = -1

function releaseKeepAwake(): void {
  if (awakeBlockerId === -1) return
  if (powerSaveBlocker.isStarted(awakeBlockerId)) powerSaveBlocker.stop(awakeBlockerId)
  awakeBlockerId = -1
}

function syncKeepAwake(): void {
  const want = manager?.settings.keep_awake === true && manager.running() > 0
  if (want) {
    if (awakeBlockerId === -1) awakeBlockerId = powerSaveBlocker.start('prevent-app-suspension')
  } else {
    releaseKeepAwake()
  }
}

// ---------------------------------------------------------------- 系统通知
//
// 只有终态（done / error）才弹，去重已经做在 Manager.notifyTerminal 里。
// 失败通知必须带上 errors.ts 翻译过的中文原因和建议：窗口收起来时任务失败了，
// 用户唯一的线索就是这条 toast，光写「下载失败」等于没写。
function notifyTerminal(row: TaskRow): void {
  const s = store.loadSettings()
  const st = row.snap?.state ?? row.def.state
  const name = fileName(row.def.dest) || row.def.url
  const frontmost = !!win && !win.isDestroyed() && win.isVisible() && win.isFocused()
  if (st === 'done' && s.notify_on_finish) {
    const total = row.snap?.total || row.def.total
    notify(
      frontmost,
      `${name} 下载完成`,
      total ? `已保存到 ${dirname(row.def.dest)}（${fmtSize(total)}）` : `已保存到 ${dirname(row.def.dest)}`,
      row.id,
    )
  } else if (st === 'error' && s.notify_on_error) {
    // 原文和码取自同一份记录（理由同 TaskRow 的 err）：混着取会在
    // 「快照已清空、tasks.json 还没落盘」的窗口里把新错误配上旧病因。
    const snap = row.snap
    const src = snap?.error
      ? { raw: snap.error, code: snap.error_code, params: snap.error_params }
      : { raw: row.def.error, code: row.def.error_code ?? '', params: row.def.error_params ?? null }
    const e = explainError(src.raw, src.code, src.params)
    notify(
      frontmost,
      `${name} 下载失败`,
      e ? `${e.title}。${e.advice}` : '点开任务查看原因。',
      row.id,
    )
  }
  // 窗口不在前台时让任务栏图标闪起来：toast 会被自动收起，闪动的图标是第二次提醒。
  if (!frontmost && win && !win.isDestroyed()) win.flashFrame(true)
}

/**
 * 系统通知。窗口就在面前时不再弹 toast：用户正盯着进度条，跳出一条重复信息
 * 只是骚扰，而且 Windows 上连续 toast 还会进通知中心堆成一片。
 */
function notify(muted: boolean, title: string, body: string, taskId: string): void {
  if (muted) return
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body })
  n.on('click', () => {
    showWindow()
    win?.webContents.send(Ipc.TaskFocus, taskId)
  })
  n.show()
}

// ---------------------------------------------------------------- IPC 校验
//
// 渲染层的输入在这里全部当成不可信数据：类型不对就拒掉，而不是让主进程抛
// 未捕获异常（那会让整个调度器连同正在下载的任务一起没掉）。

const DOWNLOAD_URL_RE = /^(https?|ftp):\/\//i
/** 动作白名单：与 preload 暴露的 action() 以及 Manager.action 的分支一致。 */
const TASK_ACTIONS = new Set(['start', 'pause', 'resume', 'retry'])
const ALL_ACTIONS = new Set(['start', 'pause', 'clear-finished', 'retry-failed'])

function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 64
}

function err(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

/** G14：把导出行数组转成 CSV（值里带逗号/引号/换行时按 RFC4180 引号包裹）。 */
function gamesToCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return ''
  const keys = Object.keys(rows[0])
  const esc = (v: unknown): string => {
    const s = String(v ?? '')
    return /[",\n\r]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s
  }
  return [keys.join(','), ...rows.map((r) => keys.map((k) => esc(r[k])).join(','))].join('\r\n')
}

/**
 * 用户在原生「选择目录」对话框里亲自选过的目录（小写绝对路径）。
 *
 * 下载路径必须落在「设置的默认目录」或这里面的某一棵子树内：引擎会照着这个
 * 路径创建文件、预分配几个 GB 的 .part，路径由渲染层随意指定的话，一个被
 * 注入的界面就能往启动项、系统目录里写东西。用户手选的目录是他自己授权的，
 * 所以记下来放行；重启后清空——那时用户可以再选一次。
 */
const approvedDirs = new Set<string>()

/** dest 是不是落在允许的目录树里（默认下载目录 + 本次会话用户手选的目录）。 */
function isDestAllowed(dest: string, downloadDir: string): boolean {
  const p = resolve(dest).toLowerCase()
  const roots = [downloadDir, ...approvedDirs].filter((r): r is string => typeof r === 'string' && !!r)
  for (const r of roots) {
    const root = resolve(r).toLowerCase()
    if (p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)) return true
  }
  return false
}

function wireIpc(): void {
  const m = manager
  const s = store

  // 引擎自检结果搭 hello 一起下去：设置页靠它说明「下载为什么不可用、怎么修」。
  // 每次调用都重新查，用户在设置页点「重新检测」时不用重启应用。
  ipcMain.handle(Ipc.Hello, () => {
    const st = engineStatus()
    return {
      name: 'hanehana',
      version: app.getVersion(),
      engine_ok: st.ok,
      engine_path: st.path,
      engine_hint: st.hint,
      // G15 便携模式：让渲染层「关于」页直接显示真实数据目录，不用自己猜
      data_dir: dataDir(),
      portable: isPortable(),
    }
  })

  // 新作追踪（G16）：订阅/取消/检查 VNDB 新作，命中弹系统通知（带激活窗口）
  ipcMain.handle(Ipc.TrackList, () => loadTracking())
  ipcMain.handle(Ipc.TrackAdd, (_e, keyword: unknown) => {
    if (typeof keyword !== 'string' || !keyword.trim() || keyword.trim().length > 200) {
      return { ok: false as const, error: '订阅词不能为空且不超过 200 字' }
    }
    return { ok: true as const, entry: addTrack(keyword) }
  })
  ipcMain.handle(Ipc.TrackRemove, (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) return { ok: false as const, error: '订阅不存在' }
    return { ok: removeTrack(id) }
  })
  ipcMain.handle(Ipc.TrackCheck, async (): Promise<TrackCheckResult> => {
    const r = await checkTracks()
    // 有新作 → 系统通知（点击回到窗口）；无新作静默
    if (r.ok && r.fresh.length && Notification.isSupported()) {
      const names = r.fresh.slice(0, 3).map((h) => h.title).join('、')
      const n = new Notification({
        title: 'HaneHana 新作追踪',
        body: `发现 ${r.fresh.length} 部新作：${names}${r.fresh.length > 3 ? '…' : ''}`,
      })
      n.on('click', showWindow)
      n.show()
    }
    return r
  })

  // 游戏库
  ipcMain.handle(Ipc.GameList, () => getGames())
  // 统计报表：重放游玩会话聚合（量级小，无需缓存）
  ipcMain.handle(Ipc.StatsOverview, () => computeOverview(getGames(), store.loadPlaySessions()))

  // 全屏模式（G11）：切换主窗口全屏。渲染层只管调，窗口状态以主进程为准。
  // 测试缝：CDP 对 OS 真全屏截图会残留旧帧合成鬼影（probe 已证布局本身正确）。
  // HANEHANA_NO_OS_FULLSCREEN=1 时只回传目标态、不动 OS 全屏，视觉验收可干净截图。
  // 生产环境从不设置该变量，行为不变。
  ipcMain.handle(Ipc.FullscreenSet, (_e, on: unknown) => {
    if (!win || typeof on !== 'boolean') return false
    if (process.env['HANEHANA_NO_OS_FULLSCREEN'] === '1') return on
    win.setFullScreen(on)
    return win.isFullScreen()
  })
  ipcMain.handle(Ipc.FullscreenToggle, () => {
    if (!win) return false
    if (process.env['HANEHANA_NO_OS_FULLSCREEN'] === '1') return !win.isFullScreen()
    win.setFullScreen(!win.isFullScreen())
    return win.isFullScreen()
  })
  ipcMain.handle(Ipc.GameScan, (_e, root: unknown) => {
    if (typeof root !== 'string' || !root.trim() || root.length > 4000) {
      throw new Error('请先选择要扫描的目录')
    }
    return handleScan(root.trim())
  })
  // Steam 库导入（G4）：扫库目录 → 返回候选（含 appid/官方名）
  ipcMain.handle(Ipc.SteamScan, async () => {
    const candidates = await scanSteamLibrary()
    // 剔除已入库的（按 exe 去重，与扫描一致）
    const existing = new Set(getGames().map((g) => g.exePath.toLowerCase()))
    return candidates.filter((c) => !existing.has(c.exePath.toLowerCase()))
  })
  // 导入选中的 Steam 候选（渲染层传来的白名单形状：dir/exePath/rawTitle/appid）
  ipcMain.handle(Ipc.SteamImport, (_e, entries: unknown) => {
    if (!Array.isArray(entries) || entries.length > 500) return err('选择无效')
    const list = entries
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .filter(
        (x) =>
          typeof x.dir === 'string' && x.dir &&
          typeof x.exePath === 'string' && x.exePath &&
          typeof x.rawTitle === 'string' && x.rawTitle,
      )
      .map((x) => ({
        dir: x.dir as string,
        exePath: x.exePath as string,
        rawTitle: x.rawTitle as string,
        appid: typeof x.appid === 'string' ? x.appid : undefined,
      }))
    if (!list.length) return { ok: true as const, added: 0, skipped: 0 }
    const added = handleSteamImport(list)
    return { ok: true as const, ...added }
  })
  // 存档备份（G1）：快照创建/列出/恢复/删除 + WebDAV 云同步
  ipcMain.handle(Ipc.BackupsList, () => listAllBackups(getGames()))
  ipcMain.handle(Ipc.BackupCreate, (_e, id: unknown) => {
    if (!isId(id)) return err('游戏不存在')
    const g = getGame(id)
    if (!g) return err('游戏不在库中')
    const snap = createSnapshot(g)
    if (!snap) return err('游戏目录不存在，无法备份')
    rotateSnapshots(g.id, s.loadSettings().backup_keep)
    return snap
  })
  ipcMain.handle(Ipc.BackupRestore, (_e, id: unknown, snapshotDir: unknown) => {
    if (!isId(id)) return err('游戏不存在')
    const g = getGame(id)
    if (!g) return err('游戏不在库中')
    if (typeof snapshotDir !== 'string' || !snapshotDir) return err('快照路径无效')
    return restoreSnapshot(g, snapshotDir)
  })
  ipcMain.handle(Ipc.BackupDelete, (_e, id: unknown, snapshotDir: unknown) => {
    if (!isId(id)) return false
    if (typeof snapshotDir !== 'string' || !snapshotDir) return false
    return deleteSnapshot(id, snapshotDir)
  })
  ipcMain.handle(Ipc.BackupSync, async (_e, id: unknown, snapshotDir: unknown) => {
    if (!isId(id)) return err('游戏不存在')
    const g = getGame(id)
    if (!g) return err('游戏不在库中')
    if (typeof snapshotDir !== 'string' || !snapshotDir) return err('快照路径无效')
    const st = s.loadSettings()
    if (!st.webdav_url) return err('未配置 WebDAV 同步地址')
    return await syncToCloud(g, { url: st.webdav_url, user: st.webdav_user, pass: st.webdav_pass }, snapshotDir)
  })

  ipcMain.handle(Ipc.GameRemove, (_e, id: unknown) => {
    if (!isId(id)) return err('游戏不存在')
    handleRemove(id)
    return { ok: true as const }
  })
  // patch 走白名单：渲染层能改哪些字段由主进程说了算，见 sanitizeGamePatch
  ipcMain.handle(Ipc.GameUpdate, (_e, id: unknown, patch: unknown) => {
    if (!isId(id)) return err('游戏不存在')
    return handleUpdate(id, sanitizeGamePatch(patch))
  })
  // 批量：entries=[{id, patch}]，逐条过白名单；未知 id 静默跳过
  ipcMain.handle(Ipc.GameBatchUpdate, (_e, entries: unknown) => {
    if (!Array.isArray(entries) || entries.length > 500) return err('选择无效')
    const list = entries
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .filter((x) => isId(x.id))
      .map((x) => ({ id: x.id as string, patch: sanitizeGamePatch(x.patch) }))
    if (!list.length) return { ok: true as const, updated: 0, removed: 0 }
    return { ok: true as const, ...handleBatchUpdate(list) }
  })
  ipcMain.handle(Ipc.GameBatchRemove, (_e, ids: unknown) => {
    if (!Array.isArray(ids)) return err('选择无效')
    const list = ids.filter(isId)
    if (!list.length) return { ok: true as const, ...handleBatchRemove([]) }
    return { ok: true as const, ...handleBatchRemove(list) }
  })
  ipcMain.handle(Ipc.GameLaunch, async (_e, id: unknown) => {
    if (!isId(id)) return { ok: false as const, error: '游戏不存在' }
    return handleLaunch(id)
  })
  ipcMain.handle(Ipc.GameRunning, () => handleRunning())
  // 打开目录只接受磁盘上真实存在的路径：这个频道会在资源管理器里落地一个窗口，
  // 不该由渲染层随便指定去哪儿。
  ipcMain.handle(Ipc.OpenDir, (_e, dir: unknown) => {
    if (typeof dir !== 'string' || !dir.trim() || dir.length > 4000) return
    const p = dir.trim()
    if (!existsSync(p)) return
    handleOpenDir(p)
  })
  ipcMain.handle(Ipc.PickDir, async () => {
    const opts: Electron.OpenDialogOptions = {
      properties: ['openDirectory'],
      title: '选择游戏目录',
    }
    const r = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const picked = r.canceled ? '' : r.filePaths[0] ?? ''
    // 用户在原生对话框里亲自选过的目录 = 授权写入点，下载路径沙箱认它（见 isDestAllowed）
    if (picked) approvedDirs.add(resolve(picked).toLowerCase())
    return picked
  })

  // G2 工具路径选择：原生文件对话框选 exe（LEProc/Magpie）。返回绝对路径或空串（取消）。
  ipcMain.handle(Ipc.PickExe, async () => {
    const opts: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      title: '选择可执行文件',
      filters: [
        { name: '程序', extensions: ['exe'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    }
    const r = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? '' : r.filePaths[0] ?? ''
  })

  // G14 游戏库导出：弹保存对话框选 .csv / .json，把库里每个游戏的关键字段写出去。
  // 返回值 { ok, path } 让渲染层能提示落盘位置；用户取消返回 { ok: true, canceled: true }。
  ipcMain.handle(Ipc.ExportGames, async (_e, fmt: unknown) => {
    const format = fmt === 'csv' || fmt === 'json' ? fmt : 'json'
    const opts: Electron.SaveDialogOptions = {
      title: '导出游戏库',
      defaultPath: `hanehana-library.${format}`,
      filters: format === 'csv' ? [{ name: 'CSV 表格', extensions: ['csv'] }] : [{ name: 'JSON', extensions: ['json'] }],
    }
    // 测试缝：HANEHANA_EXPORT_DEST 存在时跳过保存对话框直接写该路径（验收脚本用，生产不设）。
    let filePath: string | undefined
    if (process.env['HANEHANA_EXPORT_DEST']) {
      filePath = process.env['HANEHANA_EXPORT_DEST']
    } else {
      const r = win && !win.isDestroyed() ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (r.canceled || !r.filePath) return { ok: true as const, canceled: true as const }
      filePath = r.filePath
    }
    try {
      const games = getGames().map((g) => ({
        title: g.title,
        titleNative: g.titleNative ?? '',
        rawTitle: g.rawTitle,
        developer: g.developer ?? '',
        series: (g.series ?? []).join('; '),
        releaseDate: g.releaseDate ?? '',
        rating: g.rating ?? '',
        tags: g.tags.join('; '),
        categories: g.categories.join('; '),
        dir: g.dir,
        exePath: g.exePath,
        playMs: g.playMs,
        playHours: +(g.playMs / 3600000).toFixed(2),
        lastPlayed: g.lastPlayed ? new Date(g.lastPlayed).toISOString() : '',
        lengthMinutes: g.lengthMinutes ?? '',
        favorite: g.favorite,
      }))
      const out = format === 'csv' ? gamesToCsv(games) : JSON.stringify(games, null, 2)
      writeFileSync(filePath, out, 'utf8')
      return { ok: true as const, canceled: false as const, path: filePath }
    } catch (e) {
      return err('导出失败：' + (e instanceof Error ? e.message : String(e)))
    }
  })

  // 自定义背景图：原生文件对话框返回路径（渲染层存进 settings.bg_image）。
  // 只放行图片格式；路径交给 normalizeSettings 的 existsSync 兜底。
  ipcMain.handle(Ipc.PickBgImage, async () => {
    const opts: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      title: '选择背景图',
      filters: [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] },
      ],
    }
    const r = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? '' : r.filePaths[0] ?? ''
  })

  // 元数据刮削
  ipcMain.handle(Ipc.ScrapeSearch, (_e, title: string) => searchScrape(title))
  ipcMain.handle(Ipc.ScrapeApply, (_e, gameId: unknown, result: unknown) => {
    if (!isId(gameId)) return { ok: false as const, error: '游戏不存在' }
    return applyScrape(gameId, result)
  })

  // ---- 下载引擎 ----
  // 返回 rows（定义 + 实时快照）而不是裸 listDefs：渲染进程靠它恢复断点进度
  ipcMain.handle(Ipc.TasksList, () => m.rows())

  ipcMain.handle(Ipc.TasksAdd, (_e, input) => {
    const raw = (input ?? {}) as Record<string, unknown>
    const url = typeof raw.url === 'string' ? raw.url.trim() : ''
    if (!DOWNLOAD_URL_RE.test(url)) return err('下载地址无效：需要 http(s):// 或 ftp:// 开头')
    const dest = typeof raw.dest === 'string' ? raw.dest.trim() : ''
    if (dest.length > 4000) return err('保存路径过长')
    // 空串 = 用设置里的默认下载目录（Manager 会补），那本身就是允许的根。
    if (dest && !isDestAllowed(dest, s.loadSettings().download_dir)) {
      return err('保存路径不在允许的目录内：请用「浏览」选目录，或在设置里改默认保存目录')
    }
    const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 500) : ''
    // 校验和要么当场判掉，要么原样落盘。放一串读不懂的字符进去，代价是
    // 十几个 GB 下完之后才报「校验失败」，那时用户已经不知道差异出在哪了。
    const checksum = normalizeChecksum(typeof raw.checksum === 'string' ? raw.checksum : '')
    if (checksum === null) {
      return err('校验和看不懂：需要 32 位（MD5）/ 40 位（SHA-1）/ 64 位（SHA-256）十六进制，或写成 sha256:… 的形式')
    }
    // 分片数按设置页的同一区间夹住（1-32）：引擎会为每一片开一条连接，
    // 传个 10 万进来就是自己给自己造一次对目标站点的拒绝服务。
    const requested = Number.isFinite(raw.threads) ? Math.floor(Number(raw.threads)) : s.loadSettings().threads
    const threads = Math.min(32, Math.max(1, Number.isFinite(requested) ? requested : 8))
    return { ok: true as const, ...m.add({ url, dest, threads, note, checksum }) }
  })

  // 移除任务。deleteFiles 由渲染层的勾选框决定：默认只删记录，磁盘上的东西
  // 一律不动（界面上就是这么承诺的）。用户明确要求连文件一起删时，
  // 只可能删这个任务自己的三个路径（成品 / .part / .part.meta），
  // 而删不掉的（被占用、没权限）必须回报原因，不能假装清理成功了。
  ipcMain.handle(Ipc.TasksRemove, async (_e, id: unknown, deleteFiles: unknown) => {
    if (!isId(id) || !m.has(id)) return err('任务不存在，可能已经被移除')
    const failures = await m.remove(id, deleteFiles === true)
    if (failures.length) return err(`任务已移除，但文件没删掉：${failures.join('；')}`)
    return { ok: true as const }
  })
  ipcMain.handle(Ipc.TasksClearFinished, async () => {
    await m.clearFinished()
    return { ok: true as const }
  })
  ipcMain.handle(Ipc.TaskAction, (_e, id: unknown, action: unknown) => {
    if (!isId(id) || !m.has(id)) return err('任务不存在，可能已经被移除')
    if (typeof action !== 'string' || !TASK_ACTIONS.has(action)) {
      return err(`不支持的操作：${String(action)}`)
    }
    m.action(id, action)
    return { ok: true as const }
  })
  ipcMain.handle(Ipc.TaskSetThreads, (_e, id: unknown, n: unknown) => {
    if (!isId(id) || !m.has(id)) return err('任务不存在，可能已经被移除')
    if (!Number.isFinite(n)) return err('线程数无效')
    m.setThreads(id, Number(n))
    return { ok: true as const }
  })
  // 事后补校验和：站点上的 md5 往往是用户下完才回去看到的。空串 = 取消校验。
  ipcMain.handle(Ipc.TaskSetChecksum, (_e, id: unknown, cs: unknown) => {
    if (!isId(id) || !m.has(id)) return err('任务不存在，可能已经被移除')
    const checksum = normalizeChecksum(typeof cs === 'string' ? cs : '')
    if (checksum === null) {
      return err('校验和看不懂：需要 32 位（MD5）/ 40 位（SHA-1）/ 64 位（SHA-256）十六进制，或写成 sha256:… 的形式')
    }
    m.setChecksum(id, checksum)
    return { ok: true as const }
  })
  ipcMain.handle(Ipc.ActionAll, async (_e, action: unknown) => {
    if (typeof action !== 'string' || !ALL_ACTIONS.has(action)) {
      return err(`不支持的操作：${String(action)}`)
    }
    await m.actionAll(action)
    return { ok: true as const }
  })

  ipcMain.handle(Ipc.SettingsGet, () => s.loadSettings())
  ipcMain.handle(Ipc.SettingsSave, async (_e, next) => {
    // 不直接把渲染层的对象写盘：normalizeSettings 会把非法字段回落到默认值。
    const prev = s.loadSettings()
    const raw = (next && typeof next === 'object' ? next : {}) as Partial<Settings>
    const saved = normalizeSettings(next)
    // 固定模式（非 system）下 dark 与 theme_mode 必须一致，否则窗口跟谁走说不清：
    // - 只改了 theme_mode（老脚本只翻 dark 时 mode 原样回带）→ 以 theme_mode 对齐 dark
    // - 只改了 dark（老调用 {...s, dark:x}，mode 原样回带）→ theme_mode 跟随 dark 意图
    // - 两者都改（新设置面板一次提交）→ 信任调用方已对齐
    if (saved.theme_mode !== 'system') {
      const modeChanged = typeof raw.theme_mode === 'string' && raw.theme_mode !== prev.theme_mode
      const darkChanged = typeof raw.dark === 'boolean' && raw.dark !== prev.dark
      if (modeChanged && !darkChanged) saved.dark = saved.theme_mode === 'dark'
      else if (darkChanged && !modeChanged) saved.theme_mode = saved.dark ? 'dark' : 'light'
      else saved.dark = saved.theme_mode === 'dark'
    }
    // 代理要「先确认能下发，再落盘」。顺序反了的话：盘里是新代理、Chromium 还在用
    // 旧代理，用户看到的就是「设置了代理但没生效」，而这正是最难自己查出来的一种。
    const bad = proxyFormatError(saved.proxy)
    if (bad) return err(bad)
    try {
      await applyChromiumProxy(saved.proxy)
    } catch (e) {
      return err(`代理没能下发到内置浏览器与站点解析：${e instanceof Error ? e.message : String(e)}`)
    }
    s.saveSettings(saved)
    m.applySettings(saved)
    // 深浅主题：主进程窗口底色/标题栏/原生控件跟随模式（system 时按系统当前深浅）。
    const effDark = applyThemeMode(saved.theme_mode)
    applyThemeToWindow(effDark)
    // 落盘值保持「当前生效」语义：system 模式时把 dark 同步成系统实际值，
    // 渲染层与老脚本读到的 dark 始终与屏幕一致。
    if (saved.theme_mode === 'system' && saved.dark !== effDark) {
      s.saveSettings({ ...saved, dark: effDark })
      saved.dark = effDark
    }
    // 防休眠开关改了要立刻生效，不能等下一秒的定时器——用户可能正把最后一个
    // 任务勾上，然后就走开了。
    syncKeepAwake()
    return { ok: true as const, settings: saved }
  })

  // 自动更新：检查与安装都由用户界面发起（“关于”页按钮），不在后台擅自下载。
  // 状态推送经 setUpdatePush 接好，窗口不在时也能收到。
  ipcMain.handle(Ipc.UpdateCheck, async () => {
    const st = updateEnabled()
    if (!st) return { ok: false as const, error: '自动更新仅打包版可用（开发模式无发布源）' }
    void checkUpdate()
    return { ok: true as const }
  })

  ipcMain.handle(Ipc.UpdateInstall, () => {
    const st = updateEnabled()
    if (!st) return { ok: false as const, error: '自动更新仅打包版可用（开发模式无发布源）' }
    if (!installUpdate()) return { ok: false as const, error: '没有已下载的更新可安装' }
    return { ok: true as const }
  })
}

// ---------------------------------------------------------------- 生命周期
function quit(): void {
  if (trayTimer) {
    clearInterval(trayTimer)
    trayTimer = null
  }
  releaseKeepAwake()
  manager?.shutdown()
  tray?.destroy()
  tray = null
  app.quit()
}

if (gotSingleInstanceLock) {
  void app.whenReady().then(() => {
    loadGames()
    ensureCoversDir()
    protocol.handle('hh', handleHhProtocol)
    // 启动后串行回填缺缩略图/主色的条目（逐张生成，不阻塞启动）
    backfillThumbs(getGames())
    store = new Store()
    // 引擎自检：缺失只记日志 + 设置页提示，不拦启动。游戏库、刮削、启动游戏
    // 都不需要引擎，为它挡下整个应用是把小问题变成大问题。
    const engine = engineStatus()
    if (!engine.ok) console.error('[engine] 下载引擎不可用：', engine.hint)
    const initialSettings = store.loadSettings()
    const initialDefs = store.loadTasks()
    // 推送帧合并：同时活动的最多也就并发上限个任务，但每个 100ms 都 send 一条
    // 会把渲染进程 IPC 塞满。50ms 窗口累积 + 按任务覆盖（只发最新快照），
    // 渲染侧看到的还是 20fps 的连续进度，IPC 条数从「任务数 × 10/s」降到 ≤20/s。
    const PUSH_WINDOW_MS = 50
    let pushTimer: ReturnType<typeof setTimeout> | null = null
    let pushQueue = new Map<string, TaskProgressPush>()
    const flushPush = (): void => {
      pushTimer = null
      if (!win || win.isDestroyed()) return
      for (const item of pushQueue.values()) win.webContents.send(Ipc.TaskProgress, item)
      pushQueue = new Map()
    }
    const onPushCoalesced = (p: TaskProgressPush): void => {
      pushQueue.set(p.taskId, { ...p, snapshot: p.snapshot })
      if (!pushTimer) pushTimer = setTimeout(flushPush, PUSH_WINDOW_MS)
    }
    manager = new Manager(
      initialSettings,
      onPushCoalesced,
      (tasks) => store.saveTasks(tasks),
      initialDefs,
    )
    // 游玩会话记录：游戏退出时 store 追加一条（统计报表的数据源）
    setSessionSink((sessions) => {
      if (sessions.length) store.appendPlaySessions(sessions)
    })
    // 异常退出（崩溃/被杀）：弹系统通知，玩家第一时间知道「刚才那游戏不是正常关的」
    setCrashNotifier(({ title }) => {
      notify(false, `${title} 可能异常退出`, '游戏进程非正常结束（崩溃或被杀）。如果频繁发生，试试用 LE 转区或以管理员身份运行。', 'crash')
    })
    // 存档自动备份（G1）：游戏正常退出后台跑快照（仅备份开了开关的游戏）。
    // 快照会读盘+算哈希，几 MB 存档毫秒级，直接 await 不阻塞主循环。
    setAutoBackup((game) => {
      try {
        if (!store.loadSettings().backup_on_exit) return
        const snap = createSnapshot(game)
        if (snap) rotateSnapshots(game.id, store.loadSettings().backup_keep)
      } catch (e) {
        console.error('[saves] 自动备份失败:', game.title, e)
      }
    })
    // 工具路径读取器（G2）：设置里的 LE/Magpie 路径在启动时实时读取（保存后立刻生效）
    setToolPaths(() => {
      const st = store.loadSettings()
      return { le: st.le_path, magpie: st.magpie_path }
    })
    // 代理必须在任何网络动作之前下发到 Chromium 侧（站点抓取层）。
    // 失败退回跟随系统代理：引擎侧会拿着同一份配置去下载，那时它会明确报错，
    // 不该让一个失效的代理地址把整个软件挡在启动门外。
    void applyChromiumProxy(initialSettings.proxy).catch((e: unknown) => {
      console.error('[net] 启动时下发代理失败，退回跟随系统代理：', e)
      void applyChromiumProxy('').catch((e2: unknown) => console.error('[net] 连系统代理也没配上：', e2))
    })
    // 终态 → 系统通知 + 任务栏闪动。挂在主进程而不是渲染层：窗口收进托盘时
    // 渲染层随时可能被丢弃，通知不能依赖它还活着。
    manager.onTerminal = notifyTerminal
    // 游戏站：IPC + 捕获桥。依赖 Manager.add、当前设置（下载目录/线程数）
    wireSites({
      getWindow: () => win,
      addTask: (input) => manager.add(input),
      getDownloadDir: () => store.loadSettings().download_dir,
      getThreads: () => store.loadSettings().threads,
    })
    wireIpc()
    createWindow()
    createTray()
    // 跟随系统：系统深浅切换时实时同步窗口 + 渲染层（theme_mode='system' 才有效，
    // 固定深浅时 themeSource 已锁定，'updated' 不会因设置而触发）。
    nativeTheme.on('updated', () => {
      const st = store.loadSettings()
      if (st.theme_mode !== 'system') return
      const effDark = nativeTheme.shouldUseDarkColors
      applyThemeToWindow(effDark)
      if (st.dark !== effDark) {
        store.saveSettings({ ...st, dark: effDark })
      }
      win?.webContents.send(Ipc.ThemeChanged, { dark: effDark })
    })
    // 自动更新：状态推送进渲染层（“关于”页渲染更新提示）。
    setUpdatePush((s) => win?.webContents.send(Ipc.UpdateStatus, s))
    initAutoUpdater()
    // 按设置决定是否在启动后静默检查。auto_update_check 默认开：
    // 没有这一行，用户永远不知道新版已经发布——发版日志写在 GitHub Release 里，
    // 界面里不主动提就没人看得到。
    if (initialSettings.auto_update_check) {
      setTimeout(() => void checkUpdate(), 4000)
    }
    // 上次崩溃/强杀留下的未完成任务：重启后自动续传，不用用户手动点开始。
    manager.startQueued()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else showWindow()
    })
  })
}

app.on('window-all-closed', () => {
  // 与 FastDrop 一致：托盘常驻，关窗不退出。
})

app.on('before-quit', () => {
  // 退出可能不走托盘菜单（系统关机、app.quit 的其它路径），这里再兜一次：
  // 电源句柄和定时器不释放，进程死后系统仍然处于「不许休眠」状态。
  if (trayTimer) {
    clearInterval(trayTimer)
    trayTimer = null
  }
  releaseKeepAwake()
  manager?.shutdown()
  detachAllRunning()
})
