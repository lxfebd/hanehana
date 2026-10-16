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
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerSaveBlocker,
  protocol,
  shell,
  Tray,
} from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Ipc } from '../shared/ipc'
import { explainError } from '../shared/errors'
import { fileName, fmtSize, fmtSpeed } from '../shared/format'
import type { TaskProgressPush, TaskRow, TrackCheckResult } from '../shared/types'
import { loadGames, getGames, ensureCoversDir, flushPersist } from './gameStore'
import { detachAllRunning, setSessionSink, setCrashNotifier, setAutoBackup, setToolPaths } from './games'
import { createSnapshot, rotateSnapshots } from './saves'
import { engineStatus } from './engine'
import { backfillThumbs, handleHhProtocol, registerThumbProtocol } from './thumbs'
import { backfillLocalCovers } from './localCover'
import { healBadCovers } from './coverHeal'
import { Manager } from './manager'
import { Store, dataDir } from './store'
import { applyChromiumProxy } from './netConfig'
import { TRAY_ICON_DATA_URL } from './trayIcon'
import { checkUpdate, initAutoUpdater, setUpdatePush } from './updater'
import { installMainLogger } from './log'
import { wireSites } from './sites/bridge'
import { checkTracks } from './tracking'
import { registerSettingsHandlers } from './ipc/settings'
import { registerWinHandlers } from './ipc/win'
import { registerScanHandlers } from './ipc/scan'
import { registerSteamHandlers } from './ipc/steam'
import { registerBackupHandlers } from './ipc/backup'
import { registerGamesHandlers } from './ipc/games'
import { registerScrapeHandlers } from './ipc/scrape'
import { registerTasksHandlers } from './ipc/tasks'
import { registerStatsHandlers } from './ipc/stats'

const here = dirname(fileURLToPath(import.meta.url))
const preloadPath = join(here, '../preload/index.cjs')

app.setAppUserModelId('com.hanehana.app')

// 自定义 scheme 必须在 whenReady 之前注册
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

// 隔离通道（HANEHANA_DATA_DIR）：Chromium userData 一并挪进隔离目录。
// 只挪数据文件（games.json 等）是不够的——单实例锁按 userData 目录加锁，
// 而打包版/dev 版默认同用 %APPDATA%\hanehana。不隔离时，验收脚本/探针
// 拉起的实例会撞上用户正开着的安装版实例，秒退（症状：CDP 永远连不上）。
// 打包正常运行不设该变量，行为不变。
if (process.env.HANEHANA_DATA_DIR) {
  app.setPath('userData', join(process.env.HANEHANA_DATA_DIR, 'chromium'))
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
let trackTimer: ReturnType<typeof setInterval> | null = null
let store: Store
let manager: Manager

// 全局窗口拦截：主窗口的 setWindowOpenHandler 只覆盖它自己，游戏站页签的
// webview（allowpopups）开的客人窗口是另一组 WebContents——不给它同样约束，
// 被嵌入的站点页面就能 `window.open` 出一个不受控的 Electron 窗口。
// 统一规则：只放 https/http 外链到系统浏览器，其余（javascript:、file:、
// 自定义协议）一律拒绝；跨协议降级（https→http）也在这里拒绝。
// `web-contents-created` 是 app 级事件，对主窗口、webview 客人窗口、DevTools
// 全部生效，一处约束管住所有 WebContents。
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url)
      if (u.protocol === 'https:' || u.protocol === 'http:') {
        void shell.openExternal(url)
      }
      // 其它协议（javascript:/file:/data:/自定义）不开任何东西
    } catch {
      // URL 解析不了同样拒绝
    }
    return { action: 'deny' }
  })
})

function showWindow(): void {
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** 新作追踪命中通知（手动检查与定时检查共用）：有新作才弹，点击回到窗口。 */
function notifyTrackFresh(r: TrackCheckResult): void {
  if (!r.ok || !r.fresh.length || !Notification.isSupported()) return
  const names = r.fresh
    .slice(0, 3)
    .map((h) => h.title)
    .join('、')
  const n = new Notification({
    title: 'HaneHana 新作追踪',
    body: `发现 ${r.fresh.length} 部新作：${names}${r.fresh.length > 3 ? '…' : ''}`,
  })
  n.on('click', showWindow)
  n.show()
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

  // 开发模式没有 exe 资源可嵌，不显式设图标的话任务栏/Alt-Tab 显示 Electron
  // 默认蓝原子。指向 build/icon.ico（dev 下源在 out/main，往上两级即 app/）；
  // 打包后图标由 electron-builder 嵌进 exe（electron-builder.yml win.icon），
  // 那时文件不在包内、这里返回空图，就不设，避免把 exe 图标盖成空白。
  if (!app.isPackaged) {
    const devIcon = nativeImage.createFromPath(join(here, '../../build/icon.ico'))
    if (!devIcon.isEmpty()) winOpts.icon = devIcon
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

  // 主窗口整窗导航白名单（纵深防御）：渲染层若有 XSS（当前 CSP 已把攻击面
  // 压得很小），window.location 能把整窗带去钓鱼页/file:// 页面而没有任何
  // 拦截。这里只放打包入口（file:// 的 index.html）与 dev server
  // （localhost/127.0.0.1 的 Vite），其余导航一律阻止。webview 内的站点
  // 页签导航是功能语义，不在这里、由各自 WebContents 自行驱动。
  win.webContents.on('will-navigate', (e, url) => {
    try {
      const u = new URL(url)
      const devHost = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
      const ok = u.protocol === 'file:' || ((u.protocol === 'http:' || u.protocol === 'https:') && devHost)
      if (!ok) e.preventDefault()
    } catch {
      e.preventDefault()
    }
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
    // 完成只是第一跳：exe 提示任务行一键入库，压缩包提示解压后扫描——别让用户自己猜
    const dest = row.def.dest
    const hint = /\.exe$/i.test(dest)
      ? '，任务行可一键导入游戏库'
      : /\.(zip|7z|rar)$/i.test(dest)
        ? '，解压后可用「扫描」导入游戏库'
        : ''
    const where = total ? `已保存到 ${dirname(dest)}（${fmtSize(total)}）` : `已保存到 ${dirname(dest)}`
    notify(frontmost, `${name} 下载完成`, `${where}${hint}`, row.id)
  } else if (st === 'error' && s.notify_on_error) {
    // 原文和码取自同一份记录（理由同 TaskRow 的 err）：混着取会在
    // 「快照已清空、tasks.json 还没落盘」的窗口里把新错误配上旧病因。
    const snap = row.snap
    const src = snap?.error
      ? { raw: snap.error, code: snap.error_code, params: snap.error_params }
      : { raw: row.def.error, code: row.def.error_code ?? '', params: row.def.error_params ?? null }
    const e = explainError(src.raw, src.code, src.params)
    notify(frontmost, `${name} 下载失败`, e ? `${e.title}。${e.advice}` : '点开任务查看原因。', row.id)
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

// ---------------------------------------------------------------- IPC 组装
//
// 各域的 ipcMain.handle 注册在 src/main/ipc/*，这里只注入运行时依赖（窗口、
// 调度器、设置库、主题/防休眠回调）。渲染层输入的校验也随各 handler 就地
// 完成——类型不对就拒掉，而不是让主进程抛未捕获异常。

function wireIpc(): void {
  const approvedDirs = new Set<string>()
  const ctx = {
    win: () => win,
    manager: () => manager,
    store: () => store,
    approvedDirs: () => approvedDirs,
    applyThemeMode,
    applyThemeToWindow,
    syncKeepAwake,
    notifyTrackFresh,
  }
  registerSettingsHandlers(ctx)
  registerWinHandlers(ctx)
  registerScanHandlers(ctx)
  registerSteamHandlers(ctx)
  registerBackupHandlers(ctx)
  registerGamesHandlers(ctx)
  registerScrapeHandlers(ctx)
  registerTasksHandlers(ctx)
  registerStatsHandlers(ctx)
}

// ---------------------------------------------------------------- 生命周期
function quit(): void {
  if (trayTimer) {
    clearInterval(trayTimer)
    trayTimer = null
  }
  // 新作追踪定时器：不随退出清理的话，process 离开后它仍会跑，虽不致命
  // 但会在退出间隙再发起一轮 VNDB 请求（还可能触发通知）。
  if (trackTimer) {
    clearInterval(trackTimer)
    trackTimer = null
  }
  releaseKeepAwake()
  manager?.shutdown()
  tray?.destroy()
  tray = null
  app.quit()
}

if (gotSingleInstanceLock) {
  void app.whenReady().then(() => {
    // 主进程日志落盘（userData/logs/）：放在最早，把启动早期的事件也记上
    installMainLogger()
    loadGames()
    ensureCoversDir()
    protocol.handle('hh', handleHhProtocol)
    // 封面自愈先行：清掉库里已落盘的残图/纯色废图（旧版无质量闸时混进
    // 来的黑条横幅之类），再让回填重新选到好图。逐张校验、每张之间让出
    // 事件循环，不挡首帧；两个 backfill 在自愈完成后才排队，避免拿废图
    // 先生成一轮缩略图再推翻。
    void healBadCovers(getGames()).then(() => {
      // 启动后串行回填缺缩略图/主色的条目（逐张生成，不阻塞启动）。
      // backfillThumbs 按设计串行执行（每张生成是独立排队任务），同一批游戏调用
      // 两次只是把同一份工作排队两遍，没有任何收益，这里只调一次。
      backfillThumbs(getGames())
      // 库里还没有封面的条目：先探测游戏目录本地图，再让 thumb 管线接上
      backfillLocalCovers(getGames())
    })
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
    manager = new Manager(initialSettings, onPushCoalesced, (tasks) => store.saveTasks(tasks), initialDefs)
    // 游玩会话记录：游戏退出时 store 追加一条（统计报表的数据源）
    setSessionSink((sessions) => {
      if (sessions.length) store.appendPlaySessions(sessions)
    })
    // 异常退出（崩溃/被杀）：弹系统通知，玩家第一时间知道「刚才那游戏不是正常关的」
    setCrashNotifier(({ title }) => {
      notify(
        false,
        `${title} 可能异常退出`,
        '游戏进程非正常结束（崩溃或被杀）。如果频繁发生，试试用 LE 转区或以管理员身份运行。',
        'crash',
      )
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
    // 新作追踪定时检查（G16）：每 TRACK_INTERVAL 自动查一次 VNDB，有新作弹通知。
    // 有订阅才真的发起请求；无订阅只是空转，开销可忽略。checkInFlight 在
    // tracking.ts 内部做互斥，手动「立即检查」与定时检查并发时自动合并。
    // 测试缝 HANEHANA_TRACK_INTERVAL_MS：验收脚本设短间隔驱动定时触发（生产不设）。
    const trackIntervalMs = Number(process.env.HANEHANA_TRACK_INTERVAL_MS)
    trackTimer = setInterval(
      () => {
        void (async () => {
          const r = await checkTracks()
          notifyTrackFresh(r)
        })()
      },
      Number.isFinite(trackIntervalMs) && trackIntervalMs > 0 ? trackIntervalMs : 3600000,
    )
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
  if (trackTimer) {
    clearInterval(trackTimer)
    trackTimer = null
  }
  releaseKeepAwake()
  manager?.shutdown()
  detachAllRunning()
  // 合并写入的 400ms 定时器可能还没到期：退出前把待写内容同步落盘，
  // 不丢最后一批更新（回填时长/字段变更/任务状态/游玩会话）。
  flushPersist()
  store?.flush()
})
