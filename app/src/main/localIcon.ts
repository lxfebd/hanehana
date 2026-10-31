/**
 * 本地图标提取：Windows 下用 Electron app.getFileIcon 读取 exe 内嵌图标，
 * 转 PNG 存到 userData/covers/{id}.png 并写回 Game.iconPath。
 * 渲染层经 hh://icon/{id} 加载（thumbs.handleHhProtocol，isImageCachePath 闸住）。
 * 非 Windows 平台没有 getFileIcon，直接跳过——galgame 库本就是 Windows 生态。
 */
import { app } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureCoversDir, updateGame } from './gameStore'
import type { Game } from '../shared/types'

/** 当前实际启动的 exe：activeVariant n>=1 时用 variants[n-1].exePath，越界回退主 exe。 */
function exeOf(g: Game): string {
  const n = g.activeVariant ?? 0
  const v = n >= 1 ? g.variants?.[n - 1] : undefined
  return v?.exePath ?? g.exePath
}

/**
 * 为游戏提取本地图标（已有 iconPath 且文件在则跳过）。返回是否新写入。
 * 失败不致命：exe 无内嵌图标/平台不支持都静默跳过，UI 走占位字母。
 */
export async function adoptLocalIcon(g: Game): Promise<boolean> {
  if (process.platform !== 'win32') return false
  if (g.iconPath && existsSync(g.iconPath)) return false
  const exe = exeOf(g)
  if (!exe || !existsSync(exe)) return false
  try {
    const icon = await app.getFileIcon(exe, { size: 'large' })
    if (icon.isEmpty()) return false
    const png = icon.toPNG()
    if (!png || png.length < 64) return false
    const covers = ensureCoversDir()
    const dest = join(covers, g.id + '.png')
    writeFileSync(dest, png)
    updateGame(g.id, { iconPath: dest })
    return true
  } catch (e) {
    console.error('[hanehana] 本地图标提取失败：', g.id, e)
    return false
  }
}

/**
 * 启动/扫描后批量补本地图标。同 backfillLocalCovers：setImmediate 起步、
 * 循环内逐个 await setImmediate 让出事件循环，不挡首帧。
 */
export function backfillLocalIcons(games: Game[]): void {
  const queue = games.filter((g) => !g.iconPath || !existsSync(g.iconPath))
  if (queue.length === 0) return
  setImmediate(async () => {
    let n = 0
    for (const g of queue) {
      await new Promise<void>((r) => setImmediate(r))
      if (g.iconPath && existsSync(g.iconPath)) continue
      if (await adoptLocalIcon(g)) n++
    }
    // eslint-disable-next-line no-console -- 启动期图标回填摘要
    if (n > 0) console.log('[hanehana] 本地图标回填 ' + n + ' 个')
  })
}
