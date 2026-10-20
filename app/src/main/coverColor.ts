/**
 * 封面主色提取。
 *
 * 封面墙的占位背景、详情面板的光晕都用「封面本身的颜色」而不是哈希取色，
 * 视觉上每个游戏都有自己的一抹颜色，比固定调色板真实得多。
 *
 * 解码路径（实测 2026-10-21）：createFromPath 走系统 WIC，不支持 webp
 * （YMGal 封面是 WebP，createFromPath 返回 isEmpty → 主色提取失败）。
 * createFromBuffer 走 Chromium 解码器（与 createThumbnailFromPath 同管线，
 * 已实测能解 webp），先用它，createFromPath 兜底 jpg/png。
 *
 * 做法：nativeImage 缩放成 16x16 再读位图平均色 —— 缩略图把细节抹掉、
 * 留下大色块，平均出来的就是「这张封面给人的主色印象」。位图是 BGRA
 * 字节序（Skia 小端），alpha 过低的像素是透明角落，跳过。
 *
 * 深色封面取出的平均色在深色界面上会看不清，按比例与白色混合提亮一档。
 */
import { nativeImage } from 'electron'
import { readFileSync } from 'node:fs'

export function coverColorOf(path: string): string | undefined {
  try {
    // 解码路径（实测 2026-10-21）：nativeImage.createFromPath 走系统 WIC 只支持
    // jpg/png，webp（YMGal）返回 isEmpty；createFromBuffer 走 Chromium 解码器，
    // 对 VP8X 扩展 webp 仍可能 isEmpty。调用方约定：webp 封面先由 ensureThumb
    // 转成 JPEG 缩略图，再拿缩略图路径算主色（JPEG 一定可解）。
    let img: Electron.NativeImage
    try {
      img = nativeImage.createFromBuffer(readFileSync(path))
    } catch {
      img = nativeImage.createFromPath(path)
    }
    if (img.isEmpty()) return undefined
    const bmp = img.resize({ width: 16, height: 16 }).toBitmap()
    let r = 0
    let g = 0
    let b = 0
    let count = 0
    for (let i = 0; i < bmp.length; i += 4) {
      const a = bmp[i + 3]
      if (a < 32) continue
      r += bmp[i + 2]
      g += bmp[i + 1]
      b += bmp[i]
      count++
    }
    if (count === 0) return undefined
    const mix = (v: number) => Math.round(v / count + (255 - v / count) * 0.35)
    const hex = (v: number) => v.toString(16).padStart(2, '0')
    return `#${hex(mix(r))}${hex(mix(g))}${hex(mix(b))}`
  } catch (e) {
    console.error('[hanehana] 封面主色提取失败：', e)
    return undefined
  }
}
