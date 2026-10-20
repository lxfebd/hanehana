/**
 * 元数据刮削 IPC：搜索 + 应用。通道名来自 Ipc，一字不改。
 */
import { ipcMain } from 'electron'
import { Ipc } from '../../shared/ipc'
import { searchScrape, searchSource, applyScrape } from '../scraper'
import { isId, type IpcCtx } from './shared'

/** 源白名单：渲染层只能按这几个源搜，防拼任意字符串当 key 撞进断流器。 */
const SOURCES = ['vndb', 'bangumi', 'ymgal'] as const

export function registerScrapeHandlers(_ctx: IpcCtx): void {
  // title 是渲染层给的搜索词：剥掉控制字符、限长，空串直接返回空结果，
  // 免得一条坏词（空/超长/全是空白）把搜索请求白白打出去。
  ipcMain.handle(Ipc.ScrapeSearch, (_e, title: unknown) => {
    const t = typeof title === 'string' ? title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : ''
    if (!t || t.length > 200) return { results: [], warnings: [] }
    return searchScrape(t)
  })
  // 按源搜索（G20）：单源失败不拖累另一源（流式上屏靠渲染层各自 await）
  ipcMain.handle(Ipc.ScrapeSearchSource, (_e, source: unknown, title: unknown) => {
    const s = SOURCES.find((x) => x === source)
    const t = typeof title === 'string' ? title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : ''
    if (!s || !t || t.length > 200) return { results: [], warnings: [] }
    return searchSource(s, t)
  })
  ipcMain.handle(Ipc.ScrapeApply, (_e, gameId: unknown, result: unknown) => {
    if (!isId(gameId)) return { ok: false as const, error: '游戏不存在' }
    return applyScrape(gameId, result)
  })
}
