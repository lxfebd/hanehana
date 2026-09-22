/**
 * 缩略图管线（REDESIGN-SPEC §3.4）。
 *
 * 封面全尺寸原图直接进网格会打爆 GPU 内存，这里在封面下载后/启动回填时
 * 生成 320 宽 JPEG 缩略图缓存到 userData/thumbs/{gameId}.jpg，渲染层
 * 通过 hh://thumb/{gameId} 协议加载，不进 file://。
 *
 * 生成失败不致命：thumbPath 留空，UI 走占位色。
 */
import { app, nativeImage, protocol, net } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getGame, updateGame, isImageCachePath, thumbsDir } from './gameStore'
import { coverColorOf } from './coverColor'
import type { Game } from '../shared/types'

/** 必须在 app.whenReady() 之前注册。 */
export function registerThumbProtocol(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'hh', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ])
}

/** protocol.handle 处理器：只认 hh://thumb/{id} / hh://cover/{id}，id 必须命中真实游戏。 */
async function fetchLocal(p: string): Promise<Response> {
  return net.fetch(pathToFileURL(p).toString())
}

export async function handleHhProtocol(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url)
    const host = url.host
    if (host !== 'thumb' && host !== 'cover') {
      return new Response('not found', { status: 404 })
    }
    const id = decodeURIComponent(url.pathname.replace(/^\//, ''))
    const g = getGame(id)
    if (!g) return new Response('not found', { status: 404 })
    const p = host === 'thumb' ? (g.thumbPath ?? g.coverPath) : g.coverPath
    if (!p || !existsSync(p)) return new Response('not found', { status: 404 })
    // 只服务图片缓存目录里的文件。games.json 是磁盘上的明文，改一个 coverPath
    // 就能让这个协议去读任意本地文件（再把内容回给渲染层）——这里堵住这条路。
    if (!isImageCachePath(p)) return new Response('not found', { status: 404 })
    return fetchLocal(p)
  } catch {
    return new Response('bad request', { status: 400 })
  }
}

/**
 * 为游戏生成缩略图 + 主色并写回。
 * 有 coverPath 且（无 thumbPath 或 thumbSrc 不是当前封面）时才重做。
 */
export async function ensureThumb(g: Game): Promise<void> {
  if (!g.coverPath) return
  if (g.thumbPath && g.thumbSrc === g.coverPath) return
  try {
    const thumb = await makeThumb(g.coverPath)
    if (!thumb) return
    mkdirSync(thumbsDir, { recursive: true })
    const dest = join(thumbsDir, `${g.id}.jpg`)
    writeFileSync(dest, thumb.toJPEG(82))
    updateGame(g.id, { thumbPath: dest, thumbSrc: g.coverPath, color: coverColorOf(g.coverPath) ?? g.color })
  } catch (e) {
    console.error('[hanehana] 缩略图生成失败：', g.id, e)
  }
}

async function makeThumb(coverPath: string): Promise<Electron.NativeImage | null> {
  try {
    const img = await nativeImage.createThumbnailFromPath(coverPath, { width: 320, height: 480 })
    if (!img.isEmpty()) return img
  } catch {
    // 个别编码 createThumbnailFromPath 不支持，走全量加载再缩放
  }
  try {
    const img = nativeImage.createFromPath(coverPath).resize({ width: 320 })
    return img.isEmpty() ? null : img
  } catch {
    return null
  }
}

/** 启动后串行回填缺失的缩略图/主色（逐个 await，禁止并行炸磁盘）。 */
export function backfillThumbs(games: Game[]): void {
  const queue = games.filter((g) => g.coverPath && (!g.thumbPath || !g.color))
  if (queue.length === 0) return
  setImmediate(async () => {
    for (const g of queue) {
      await ensureThumb(g)
    }
  })
}
