/**
 * HaneHana 主进程入口。
 *
 * 职责：起窗口（Windows 11 Mica 毛玻璃 + 自定义标题栏）、管托盘、
 * 透传 IPC。渲染进程不直接接触 Node 和文件系统——一切经由 preload 的 contextBridge。
 *
 * 窗口材质设计（调研结论落地）：
 *   - Win11 22H2+：backgroundMaterial: 'mica'，窗口底色 #202020 带透明通道，
 *     Mica 透出壁纸采样。这是 Electron 官方 API，不引入第三方原生模块。
 *   - 更低版本：自动降级为纯色底（Mica 不生效时 backgroundColor 兜底）。
 *   - 标题栏：titleBarStyle: 'hidden' + titleBarOverlay 保留系统三个按钮，
 *     渲染层用 app-region: drag 画自定义标题栏，Mica 延伸到顶无接缝。
 */
import { app, BrowserWindow, ipcMain, nativeImage, Tray } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { release as osRelease } from 'node:os'
import { Ipc } from '../shared/ipc'

const here = dirname(fileURLToPath(import.meta.url))
const preloadPath = join(here, '../preload/index.cjs')

app.setAppUserModelId('com.hanehana.app')

// 开发调试：设置 HANEHANA_DEBUG_PORT 时开启 CDP 端口，供 CDP 探针验证 UI。
if (process.env.HANEHANA_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.HANEHANA_DEBUG_PORT)
}

// 单实例锁：避免双开导致数据互踩。
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

/** Windows 11 22H2+ 才支持 Mica。用版本号粗略判断，低版本走纯色兜底。 */
function supportsMica(): boolean {
  const m = /Windows NT (\d+\.\d+)/.exec(osRelease())
  const build = Number(osRelease().split('.')[2] ?? '0')
  return m?.[1] === '10.0' && build >= 22621
}

function createWindow(): void {
  const winOpts: Electron.BrowserWindowConstructorOptions = {
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#202020',
    ...(supportsMica()
      ? {
          backgroundMaterial: 'mica',
          titleBarStyle: 'hidden',
          titleBarOverlay: { color: '#00000000', symbolColor: '#ffffff', height: 40 },
        }
      : {
          titleBarStyle: 'hidden',
          titleBarOverlay: { color: '#00000000', symbolColor: '#ffffff', height: 40 },
        }),
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  }

  win = new BrowserWindow(winOpts)

  win.on('ready-to-show', () => {
    win?.show()
  })

  win.on('closed', () => {
    win = null
  })

  // 开发模式走 electron-vite dev server，生产加载打包产物。
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(here, '../renderer/index.html'))
  }
}

function showWindow(): void {
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// ---------------------------------------------------------------- 托盘
function createTray(): void {
  // 先用空图标占位；正式图标后续补到 build/icon.png 后由 electron-builder 打进。
  const trayIcon = nativeImage.createEmpty()
  tray = new Tray(trayIcon)
  tray.setToolTip('HaneHana · 羽花')
  tray.on('click', showWindow)
}

// ---------------------------------------------------------------- IPC 透传
// 骨架阶段只有一条 hello 通路，验证 preload ↔ 主进程链路通。
ipcMain.handle(Ipc.Hello, () => ({ name: 'hanehana', version: app.getVersion() }))

// ---------------------------------------------------------------- 生命周期
app.whenReady().then(() => {
  createWindow()
  createTray()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // 与 FastDrop 一致：托盘常驻，关窗不退出。
})
