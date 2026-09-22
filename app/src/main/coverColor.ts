/**
 * 封面主色提取。
 *
 * 封面墙的占位背景、详情面板的光晕都用「封面本身的颜色」而不是哈希取色，
 * 视觉上每个游戏都有自己的一抹颜色，比固定调色板真实得多。
 *
 * 做法：nativeImage 缩放成 16x16 再读位图平均色 —— 缩略图把细节抹掉、
 * 留下大色块，平均出来的就是「这张封面给人的主色印象」。位图是 BGRA
 * 字节序（Skia 小端），alpha 过低的像素是透明角落，跳过。
 *
 * 深色封面取出的平均色在深色界面上会看不清，按比例与白色混合提亮一档。
 */
import { nativeImage } from 'electron'

export function coverColorOf(path: string): string | undefined {
  try {
    const img = nativeImage.createFromPath(path)
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
