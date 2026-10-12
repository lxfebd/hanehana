/**
 * Steam 导入 IPC：扫库目录 + 导入候选。通道名来自 Ipc，一字不改。
 */
import { ipcMain } from 'electron'
import { Ipc } from '../../shared/ipc'
import { getGames } from '../gameStore'
import { handleSteamImport } from '../games'
import { scanSteamLibrary } from '../steam'
import { err, type IpcCtx } from './shared'

export function registerSteamHandlers(_ctx: IpcCtx): void {
  ipcMain.handle(Ipc.SteamScan, async () => {
    const candidates = await scanSteamLibrary()
    const existing = new Set(getGames().map((g) => g.exePath.toLowerCase()))
    return candidates.filter((c) => !existing.has(c.exePath.toLowerCase()))
  })

  ipcMain.handle(Ipc.SteamImport, (_e, entries: unknown) => {
    if (!Array.isArray(entries) || entries.length > 500) return err('选择无效')
    const list = entries
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .filter(
        (x) =>
          typeof x.dir === 'string' &&
          x.dir &&
          typeof x.exePath === 'string' &&
          x.exePath &&
          typeof x.rawTitle === 'string' &&
          x.rawTitle,
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
}
