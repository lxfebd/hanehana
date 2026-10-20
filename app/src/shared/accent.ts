/**
 * 自定义主题色（accent）模型 —— 与主题套件解耦的第三条轴。
 *
 * 套件（sakura/starnight/...）决定整套氛围；accent 只决定"点缀色"：
 * 导航选中态、链接、按钮、焦点环、进度条。切套件时 accent 保留。
 *
 * 对标 KoiPage 的 accent-model.ts，但落到我们既有的 seed → derive 体系：
 * accent 不是替换整套 palette，而是只覆盖 derive 结果里的 accent* 键，
 * 这样 12 个派生键（accentBg/accentSelectedRing/link/selectText...）保持一致算法。
 *
 * 可读性是硬约束：用户可能选一个与背景对比不足的颜色（比如深色主题下选深蓝）。
 * readableAccent 会用 WCAG 对比度把色阶往白/黑推移到 >= 4.5，保住文字可读。
 */

/** 主题色预设（与套件无关，任何套件都能配）。 */
export interface AccentPreset {
  id: AccentPresetId
  label: string
  labelEn: string
  hex: string
}

export type AccentPresetId = 'preset' | 'rose' | 'amber' | 'emerald' | 'cyan' | 'violet' | 'custom'

export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: 'preset', label: '跟随主题', labelEn: 'From theme', hex: '' },
  { id: 'rose', label: '玫瑰', labelEn: 'Rose', hex: '#F43F5E' },
  { id: 'amber', label: '琥珀', labelEn: 'Amber', hex: '#F59E0B' },
  { id: 'emerald', label: '翠绿', labelEn: 'Emerald', hex: '#10B981' },
  { id: 'cyan', label: '青蓝', labelEn: 'Cyan', hex: '#06B6D4' },
  { id: 'violet', label: '紫罗兰', labelEn: 'Violet', hex: '#8B5CF6' },
  { id: 'custom', label: '自定义', labelEn: 'Custom', hex: '' },
] as const

export const ACCENT_PRESET_IDS = ACCENT_PRESETS.map((p) => p.id)

/** settings.theme_accent 落盘值：hex（#rgb/#rrggbb）或空串（跟随套件）。 */
export type AccentChoice = string

type RGB = readonly [number, number, number]

/** 只接受 3/6 位十六进制；别的（含人手改出来的）一律 null，不进 CSS。 */
export function normalizeAccentHex(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const hex = value.trim().replace(/^#/, '')
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    return `#${hex.split('').map((c) => c + c).join('')}`.toUpperCase()
  }
  if (/^[0-9a-f]{6}$/i.test(hex)) return `#${hex}`.toUpperCase()
  return null
}

function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

function rgbToHex([r, g, b]: RGB): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase()
}

/** 与白/黑混合（t 0..1）。 */
function mixToward(hex: string, dir: 1 | -1, t: number): string {
  const ch = hexToRgb(hex)
  const target = dir === 1 ? 255 : 0
  return rgbToHex(ch.map((v) => Math.round(v + (target - v) * t)) as unknown as RGB)
}

/** WCAG 相对亮度。 */
function luminance(hex: string): number {
  return hexToRgb(hex)
    .map((v) => {
      const c = v / 255
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0)
}

function contrast(first: string, second: string): number {
  const a = luminance(first)
  const b = luminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const CONTRAST_TARGET = 4.5

/**
 * 把 accent 推到与背景对比 >= 4.5 的最近色阶（保持色相）。
 * 找不到就退回纯白/纯黑（深底白字、浅底黑字）。
 *
 * 用二分逼近：混白/混黑比例 t ∈ [0,1]，对比度随 |t| 单调不减，
 * 二分到边界（对比刚好 >= 4.5）即最近色阶。比固定 100 步线性更稳：
 * 线性步进在极端色（纯黑底 + 纯黑 accent）下 1% 步长爬不到足够亮，
 * 会退回中灰；二分任何输入都能收敛到最近的满足点。
 */
export function readableAccent(hex: string, background: string, dark: boolean): string {
  if (contrast(hex, background) >= CONTRAST_TARGET) return hex
  let lo = 0
  let hi = 1
  // 先保证上界满足：t=1 时纯白/纯黑，对比必达（除非背景同色且极端）
  for (let step = 0; step < 200; step++) {
    const mid = (lo + hi) / 2
    const adjusted = mixToward(hex, dark ? 1 : -1, mid)
    if (contrast(adjusted, background) >= CONTRAST_TARGET) hi = mid
    else lo = mid
    if (hi - lo < 0.002) break
  }
  const best = mixToward(hex, dark ? 1 : -1, hi)
  return contrast(best, background) >= CONTRAST_TARGET ? best : dark ? '#FFFFFF' : '#000000'
}
