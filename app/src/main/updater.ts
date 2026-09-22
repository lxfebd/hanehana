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
import type { UpdateStatus } from '../shared/types'
import { IDLE_UPDATE_STATUS } from '../shared/types'

let push: (s: UpdateStatus) => void = () => {}
let checking = false

export function setUpdatePush(fn: (s: UpdateStatus) => void): void {
  push = fn
}

export function updateEnabled(): boolean {
  return app.isPackaged
}

function send(s: UpdateStatus): void {
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
  try {
    await autoUpdater.checkForUpdates()
    // electron-updater 内部已发 update-not-available / update-available /
    // download-progress / update-downloaded，无需在此重复构造状态。
  } catch (e) {
    send({ phase: 'idle', error: e instanceof Error ? e.message : String(e) })
  } finally {
    checking = false
  }
}

export function installUpdate(): boolean {
  if (!updateEnabled()) return false
  autoUpdater.quitAndInstall(true, true)
  return true
}