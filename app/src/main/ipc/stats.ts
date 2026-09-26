/**
 * 统计 IPC：统计总览 + 海报导出。通道名来自 Ipc，一字不改。
 */
import { dialog, ipcMain } from 'electron'
import { writeFileSync } from 'node:fs'
import { Ipc } from '../../shared/ipc'
import { getGames } from '../gameStore'
import { computeOverview } from '../stats'
import { err, type IpcCtx } from './shared'

export function registerStatsHandlers(ctx: IpcCtx): void {
  ipcMain.handle(Ipc.StatsOverview, () => computeOverview(getGames(), ctx.store().loadPlaySessions()))

  ipcMain.handle(Ipc.StatsPosterExport, async (_e, dataUrl: unknown) => {
    const src = typeof dataUrl === 'string' ? dataUrl : ''
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(src)
    if (!m) return { ok: false as const, error: '海报数据无效' }
    const opts: Electron.SaveDialogOptions = {
      title: '导出统计海报',
      defaultPath: `hanehana-stats-${new Date().toISOString().slice(0, 10)}.png`,
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    }
    let filePath: string | undefined
    if (process.env['HANEHANA_EXPORT_DEST']) {
      filePath = process.env['HANEHANA_EXPORT_DEST']
    } else {
      const win = ctx.win()
      const r = win && !win.isDestroyed() ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (r.canceled || !r.filePath) return { ok: true as const, canceled: true as const }
      filePath = r.filePath
    }
    try {
      writeFileSync(filePath, Buffer.from(m[1], 'base64'))
      return { ok: true as const, canceled: false as const, path: filePath }
    } catch (e) {
      return err('海报导出失败：' + (e instanceof Error ? e.message : String(e)))
    }
  })
}
