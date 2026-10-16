/**
 * 自动更新（electron-updater）。
 *
 * 边界与理由：
 * - 只在打包产物里启用（app.isPackaged）：dev 模式没有 latest.yml 的发布源，
 *   electron-updater 会拿当前版本当目标反复报错或误判为已是最新。
 * - 自动下载（autoDownload=true），不打扰用户干预；下载完弹「重启安装」，
 *   静默挨到退出再装会让用户永远不知道更新了什么。
 * - 静默安装：quitAndInstall(true) —— NSIS 安装器无 UI 覆盖，装完自动拉起
 *   新版本（quiet + run after）。
 */
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { IDLE_UPDATE_STATUS, type UpdateStatus } from '../shared/types'

let push: (s: UpdateStatus) => void = () => {}
let checking = false
// 本轮检查是否已推过终态（非 checking）。用于 checkUpdate 兜底：
// electron-updater 会缓存 feedInfo，手动「重新检查」时可能不再发任何事件，
// 渲染层把按钮设成转圈态却永远等不到推送 → 「更新点了没反应」。
let outcomeSent = false

export function setUpdatePush(fn: (s: UpdateStatus) => void): void {
  push = fn
}

export function updateEnabled(): boolean {
  return app.isPackaged
}

function send(s: UpdateStatus): void {
  if (s.phase !== 'checking') outcomeSent = true
  push(s)
}

export function initAutoUpdater(): void {
  if (!updateEnabled()) {
    send({ ...IDLE_UPDATE_STATUS, phase: 'idle' })
    return
  }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => send({ phase: 'checking' }))
  autoUpdater.on('update-available', (info) => {
    // 自动下载已开始；界面用「下载中」接续，不额外闪现「有更新」
    send({ phase: 'available', version: info.version })
  })
  autoUpdater.on('update-not-available', () => send({ phase: 'idle', error: '已是最新版本' }))
  autoUpdater.on('download-progress', (p) => {
    send({
      phase: 'downloading',
      progress: Math.min(1, Math.max(0, (p.percent ?? 0) / 100)),
      transferred: p.transferred ?? 0,
      total: p.total ?? 0,
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    send({ phase: 'downloaded', version: info.version })
  })
  autoUpdater.on('error', (e) => {
    send({ phase: 'idle', error: e?.message || String(e) })
  })
}

export async function checkUpdate(): Promise<void> {
  if (!updateEnabled() || checking) return
  checking = true
  outcomeSent = false
  try {
    await autoUpdater.checkForUpdates()
    // 兜底：electron-updater 缓存了 feedInfo，「重新检查」可能不发任何事件，
    // 或网络半死时只发 checking-for-update 就无声结束。不补终态的话，渲染层
    // 的「检查中」永远收不起来（按钮一直转圈 = 更新点了没反应）。
    // 注意不能用 checkForUpdates 返回值里的 updateInfo.version 判断「有无更新」——
    // 它是 feed 里解析到的版本，「已是最新」时同样非空。真正有新版本时
    // autoDownload 会立刻触发 update-available→downloading 把 outcomeSent 置真，
    // 兜底不会误报。走到这里说明本轮没有可用更新的推送，报「已是最新版本」。
    if (!outcomeSent) send({ phase: 'idle', error: '已是最新版本' })
  } catch (e) {
    if (!outcomeSent) send({ phase: 'idle', error: e instanceof Error ? e.message : String(e) })
  } finally {
    checking = false
  }
}

export function installUpdate(): boolean {
  if (!updateEnabled()) return false
  autoUpdater.quitAndInstall(true, true)
  return true
}
