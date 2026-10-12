/**
 * 封面质量闸：残图/纯色废图不许进库。
 *
 * 为什么需要（实测事故）：本地回填按文件名找「封面」，而游戏目录里
 * 真有一张叫 header_bar.jpg 的 UI 装饰条（1024×36 纯黑横条）——
 * 三个妹相随目录各带一份（字节完全相同），于是三款游戏拿到同一张黑条，
 * 缩略图缩成 320×11 纯黑，封面墙上就是三块黑，用户看到的是「封面不出」。
 *
 * 两道闸：
 * 1) 几何：最短边 <96px、或长宽比 >3.5（横幅条/二维码/图标都不是封面）；
 * 2) 内容：缩到 32 宽读位图，RGB 三通道极差全部 <16 判为纯色/近纯色废图
 *    （纯黑条、纯色占位、解码花屏失败都会被拒）。
 *
 * 下载的封面（VNDB/Bangumi）走同一道闸：源站偶发回 HTML 错误页或占位图，
 * 解码失败 / 几何异常即拒绝并删除，不让它写进库。
 *
 * 判定结果两级缓存：
 * - 进程内 Map（key = 路径|size|mtimeMs）+ 跨启动的磁盘缓存（同样 key）。
 *   启动自愈每次全量解码库里的每张封面是线性 CPU 开销；文件没变
 *   （size+mtime 同）结论不可能变，直接复用。文件被替换/改写后 key 变化
 *   自然失效，不用主动清理。
 */
import { nativeImage } from 'electron'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './store'

/** 最短边下限（px）：低于它的当图标/碎片，不当封面。 */
const MIN_SIDE = 96
/** 长宽比上限：超过它的是横幅条/长截图，缩进 3:2 卡片只会糊成一条。 */
const MAX_ASPECT = 3.5
/** 纯色判定阈值：三通道极差全部低于它 = 没有内容。 */
const FLAT_RANGE = 16

/** 磁盘缓存文件：<dataDir>/cover-verdicts.json，{ key: ok }。 */
function verdictFile(): string {
  return join(dataDir(), 'cover-verdicts.json')
}

/**
 * 进程内缓存：key = 路径|size|mtimeMs。
 * 启动自愈每次全量解码库里的每张封面是线性 CPU 开销；文件没变
 * （size+mtime 同）结论不可能变，直接复用。文件被替换/改写后 key
 * 变化自然失效，不用主动清理。
 */
const verdictCache = new Map<string, boolean>()

let diskLoaded = false
let diskVerdicts: Map<string, boolean> = new Map()

/** 启动时读一次磁盘缓存（失败就当没有）。 */
function loadDiskVerdicts(): void {
  if (diskLoaded) return
  diskLoaded = true
  try {
    const raw = JSON.parse(readFileSync(verdictFile(), 'utf8')) as Record<string, boolean>
    diskVerdicts = new Map(Object.entries(raw))
  } catch {
    diskVerdicts = new Map()
  }
}

/**
 * 磁盘缓存写回：新判定先记进进程内 Map，再用定时器节流落盘，
 * 避免回填一轮触发几十次 JSON 全量写。幂等可重复调用。
 */
let diskSaveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleDiskSave(): void {
  if (diskSaveTimer) return
  diskSaveTimer = setTimeout(() => {
    diskSaveTimer = null
    try {
      writeFileSync(verdictFile(), JSON.stringify(Object.fromEntries(diskVerdicts), null, 2), 'utf8')
    } catch {
      // 写失败（磁盘满/权限）静默：缓存只是加速，不是正确性依赖
    }
  }, 5000)
}

/**
 * 这张图配不配当封面。解码失败、几何异常、近乎纯色一律 false。
 * 调用方负责在 false 时丢弃文件（下载产物要 unlink，本地候选换下一张）。
 */
export function coverQualityOk(path: string): boolean {
  let key: string
  try {
    const st = statSync(path)
    key = `${path}|${st.size}|${st.mtimeMs}`
    const hit = verdictCache.get(key)
    if (hit !== undefined) return hit
    loadDiskVerdicts()
    const diskHit = diskVerdicts.get(key)
    if (diskHit !== undefined) {
      verdictCache.set(key, diskHit)
      return diskHit
    }
  } catch {
    // stat 失败（不存在/无权限）按不合格处理，且不进缓存——下次可能就恢复了
    return false
  }
  const verdict = judgeCover(path)
  verdictCache.set(key, verdict)
  diskVerdicts.set(key, verdict)
  scheduleDiskSave()
  return verdict
}

function judgeCover(path: string): boolean {
  try {
    const img = nativeImage.createFromPath(path)
    if (img.isEmpty()) return false
    const { width: w, height: h } = img.getSize()
    if (w < MIN_SIDE || h < MIN_SIDE) return false
    const ratio = Math.max(w, h) / Math.min(w, h)
    if (ratio > MAX_ASPECT) return false
    // 读小图位图（BGRA，Skia 小端）：全图解码太大，缩样后足以判纯色
    const bmp = img.resize({ width: 32 }).toBitmap()
    let minR = 255
    let maxR = 0
    let minG = 255
    let maxG = 0
    let minB = 255
    let maxB = 0
    let seen = 0
    for (let i = 0; i < bmp.length; i += 4) {
      if (bmp[i + 3] < 32) continue // 透明角不算内容
      const b = bmp[i]
      const g = bmp[i + 1]
      const r = bmp[i + 2]
      if (r < minR) minR = r
      if (r > maxR) maxR = r
      if (g < minG) minG = g
      if (g > maxG) maxG = g
      if (b < minB) minB = b
      if (b > maxB) maxB = b
      seen++
    }
    // 几乎全透明（通道全被跳过）同样没有内容
    if (seen < 64) return false
    // 任一通道有足够的明暗变化 = 有内容；三通道全平 = 纯色废图
    return maxR - minR >= FLAT_RANGE || maxG - minG >= FLAT_RANGE || maxB - minB >= FLAT_RANGE
  } catch {
    return false
  }
}
