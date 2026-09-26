/**
 * 窗口/原生对话框 IPC：全屏、选目录/选 exe/选背景图。通道名来自 Ipc，一字不改。
 */
import { dialog, ipcMain } from 'electron'
import { resolve } from 'node:path'
import { Ipc } from '../../shared/ipc'
import { type IpcCtx } from './shared'

export function registerWinHandlers(ctx: IpcCtx): void {
  // 全屏：渲染层只管调，窗口状态以主进程为准。
  // 测试缝 HANEHANA_NO_OS_FULLSCREEN=1 只回传目标态、不动 OS 全屏。
  ipcMain.handle(Ipc.FullscreenSet, (_e, on: unknown) => {
    const win = ctx.win()
    if (!win || typeof on !== 'boolean') return false
    if (process.env['HANEHANA_NO_OS_FULLSCREEN'] === '1') return on
    win.setFullScreen(on)
    return win.isFullScreen()
  })
  ipcMain.handle(Ipc.FullscreenToggle, () => {
    const win = ctx.win()
    if (!win) return false
    if (process.env['HANEHANA_NO_OS_FULLSCREEN'] === '1') return !win.isFullScreen()
    win.setFullScreen(!win.isFullScreen())
    return win.isFullScreen()
  })

  ipcMain.handle(Ipc.PickDir, async () => {
    const opts: Electron.OpenDialogOptions = {
      properties: ['openDirectory'],
      title: '选择游戏目录',
    }
    const win = ctx.win()
    const r = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const picked = r.canceled ? '' : r.filePaths[0] ?? ''
    // 用户手选的目录 = 授权写入点，下载路径沙箱认它
    if (picked) ctx.approvedDirs().add(resolve(picked).toLowerCase())
    return picked
  })

  ipcMain.handle(Ipc.PickExe, async () => {
    const opts: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      title: '选择可执行文件',
      filters: [
        { name: '程序', extensions: ['exe'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    }
    const win = ctx.win()
    const r = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? '' : r.filePaths[0] ?? ''
  })

  ipcMain.handle(Ipc.PickBgImage, async () => {
    const opts: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      title: '选择背景图',
      filters: [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] },
      ],
    }
    const win = ctx.win()
    const r = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? '' : r.filePaths[0] ?? ''
  })
}
