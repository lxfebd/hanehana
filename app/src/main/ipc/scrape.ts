/**
 * 元数据刮削 IPC：搜索 + 应用。通道名来自 Ipc，一字不改。
 */
import { ipcMain } from 'electron'
import { Ipc } from '../../shared/ipc'
import { searchScrape, applyScrape } from '../scraper'
import { isId, type IpcCtx } from './shared'

export function registerScrapeHandlers(_ctx: IpcCtx): void {
  ipcMain.handle(Ipc.ScrapeSearch, (_e, title: string) => searchScrape(title))
  ipcMain.handle(Ipc.ScrapeApply, (_e, gameId: unknown, result: unknown) => {
    if (!isId(gameId)) return { ok: false as const, error: '游戏不存在' }
    return applyScrape(gameId, result)
  })
}
