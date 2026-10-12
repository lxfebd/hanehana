/**
 * 封面自愈：启动时把库里的残图/纯色废图清出去，让回填重新选到好图。
 *
 * 为什么需要：coverQuality 是「写入闸」，只管新进来的图；老库里已经落盘的
 * 废图（三份同源的 1024×36 黑条，thumbPath/color 也都生成好了）会被
 * 回填逻辑「已有封面就跳过」一直留着，不扫一遍永远好不了。这里在启动时
 * 校验已有封面，不合格的连封面带缩略图一起删（文件删除、字段置空），
 * 之后 backfillLocalCovers / backfillThumbs 自然补上正确的图。
 *
 * 逐个让出事件循环（setImmediate），千级库也不会卡首帧。
 */
import { existsSync, unlinkSync } from 'node:fs'
import { getGame, updateGame, isImageCachePath } from './gameStore'
import { coverQualityOk } from './coverQuality'
import type { Game } from '../shared/types'

/** 删缓存文件。只认 covers/thumbs 目录内的路径：games.json 是明文，被外部
 *  改过指向别处时宁可留着也不误删。 */
function dropCacheFile(p: string | undefined): void {
  if (!p || !isImageCachePath(p)) return
  try {
    if (existsSync(p)) unlinkSync(p)
  } catch {
    // 被占用/无权限：删不掉就留着，字段照常清，下次启动再试
  }
}

export async function healBadCovers(games: Game[]): Promise<void> {
  let n = 0
  for (const snap of games) {
    // 每张之间让出一轮事件循环：解码校验是同步 CPU 活，大库不能一口气跑完
    await new Promise<void>((r) => setImmediate(r))
    const g = getGame(snap.id)
    if (!g) continue
    if (!g.coverPath) {
      // 历史 bug 会清掉 coverPath 却留下 thumbPath，渲染层走 thumbSrc 兜底
      // 展示孤儿缩略图；没封面的缩略图没有存在意义，一并清。color 是从封面
      // 算出来的，封面都没了它也只剩孤儿值（从黑条算的 #595959），同批清。
      if (g.thumbPath || g.thumbSrc) {
        dropCacheFile(g.thumbPath)
        updateGame(g.id, { thumbPath: undefined, thumbSrc: undefined, color: undefined })
        n++
      }
      continue
    }
    // 封面文件丢失、或质量闸判废（残图/纯色/解码失败）→ 连 thumb 一起清。
    // color 也清：从黑条算出来的 #595959 不该继续当占位色。
    const fileGone = !existsSync(g.coverPath)
    if (!fileGone && coverQualityOk(g.coverPath)) continue
    dropCacheFile(g.coverPath)
    dropCacheFile(g.thumbPath)
    updateGame(g.id, { coverPath: undefined, thumbPath: undefined, thumbSrc: undefined, color: undefined })
    n++
  }
  if (n > 0) console.log(`[hanehana] 清除无效封面 ${n} 张（已触发重新回填）`)
}
