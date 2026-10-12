/**
 * 游戏库 IPC：列表/删改/启动/手动入库/导出。通道名全部来自 Ipc，一字不改。
 */
import { dialog, ipcMain } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { Ipc } from '../../shared/ipc'
import { getGames, getGame, sanitizeGamePatch } from '../gameStore'
import {
  handleRemove,
  handleUpdate,
  handleBatchUpdate,
  handleBatchRemove,
  handleLaunch,
  handleRunning,
  handleOpenDir,
  handleAddOne,
} from '../games'
import { isId, err, type IpcCtx } from './shared'

/** 路径归一后比较（分隔符/大小写不敏感），避免「同一路径写法不同」误报非法。 */
function samePath(a: string, b: string): boolean {
  try {
    return (
      resolvePath(a.trim()).toLowerCase().replace(/\\/g, '/') ===
      resolvePath(b.trim()).toLowerCase().replace(/\\/g, '/')
    )
  } catch {
    return a.trim().toLowerCase() === b.trim().toLowerCase()
  }
}

/** G14：把导出行数组转成 CSV（值里带逗号/引号/换行时按 RFC4180 引号包裹）。 */
export function gamesToCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return ''
  const keys = Object.keys(rows[0])
  const esc = (v: unknown): string => {
    const s = String(v ?? '')
    return /[",\n\r]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s
  }
  return [keys.join(','), ...rows.map((r) => keys.map((k) => esc(r[k])).join(','))].join('\r\n')
}

export function registerGamesHandlers(ctx: IpcCtx): void {
  ipcMain.handle(Ipc.GameList, () => getGames())

  ipcMain.handle(Ipc.GameRemove, (_e, id: unknown) => {
    if (!isId(id)) return err('游戏不存在')
    handleRemove(id)
    return { ok: true as const }
  })

  ipcMain.handle(Ipc.GameUpdate, (_e, id: unknown, patch: unknown) => {
    if (!isId(id)) return err('游戏不存在')
    const clean = sanitizeGamePatch(patch)
    const raw = patch && typeof patch === 'object' ? (patch as Record<string, unknown>).exePath : undefined
    if (typeof raw === 'string' && raw.trim() && !clean.exePath) {
      const cur = getGame(id)
      if (!cur || !samePath(raw, cur.exePath)) return err('启动路径无效：文件不存在或不是可执行文件')
    }
    return handleUpdate(id, clean)
  })

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

  // 打开目录只接受磁盘上真实存在的路径
  ipcMain.handle(Ipc.OpenDir, (_e, dir: unknown) => {
    if (typeof dir !== 'string' || !dir.trim() || dir.length > 4000) return
    const p = dir.trim()
    if (!existsSync(p)) return
    handleOpenDir(p)
  })

  ipcMain.handle(Ipc.GameAddOne, (_e, exePath: unknown) => {
    if (typeof exePath !== 'string' || !exePath.trim() || exePath.length > 4000 || /[\x00-\x1f]/.test(exePath)) {
      return err('可执行文件路径无效')
    }
    return handleAddOne(exePath.trim())
  })

  ipcMain.handle(Ipc.ExportGames, async (_e, fmt: unknown) => {
    const format = fmt === 'csv' || fmt === 'json' ? fmt : 'json'
    const opts: Electron.SaveDialogOptions = {
      title: '导出游戏库',
      defaultPath: `hanehana-library.${format}`,
      filters:
        format === 'csv' ? [{ name: 'CSV 表格', extensions: ['csv'] }] : [{ name: 'JSON', extensions: ['json'] }],
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
}
