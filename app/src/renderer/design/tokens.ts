/**
 * 设计令牌唯一真值（REDESIGN-SPEC §3.3）。
 *
 * 颜色/圆角/阴影/动效/字号/间距只准从这里取；组件里写颜色字面量 = 违规。
 * antd seed 只喂实色 hex（§0-3），半透明只存在于这个 CSS 变量层
 * 与 antd component tokens 的定点覆盖。
 *
 * 多主题架构（T7）：
 * - 每套主题 = 一组「种子色」（dark/light 各一份）+ 布局/圆角覆盖。
 * - deriveDark/deriveLight 把种子色派生为完整调色板，key 集合恒定，
 *   组件 CSS 只消费 var(--hh-*)，换主题/换套件不触及组件。
 * - setTheme(darkMode, presetId) 重刷 CSS 变量与响应式 colorState。
 *
 * 套件：
 * - sakura  樱夜：紫调夜黑 + 樱花粉（视觉重设计定稿基准）
 * - starnight 星海：夜蓝 + 星青，侧栏加宽、圆角收紧
 * - mint    薄荷：墨绿 + 薄荷绿，侧栏收窄、圆角拉满
 */
import { reactive } from 'vue'

export type ThemeName = 'dark' | 'light'
export type ThemeMode = 'system' | 'dark' | 'light'
export type ThemePresetId = 'sakura' | 'starnight' | 'mint'

const base = {
  glass: { blurPanel: '28px', blurFloat: '24px', saturate: '1.6' },
  radius: { xs: 6, sm: 8, md: 10, lg: 12, panel: 16, modal: 16, pill: 999 },
  space: { x1: 4, x2: 8, x3: 12, x4: 16, x6: 24, x8: 32 },
  shadow: {
    card: '0 1px 2px rgba(0,0,0,0.06), 0 1px 1px rgba(0,0,0,0.04)',
    cardHover: '0 4px 12px rgba(0,0,0,0.10)',
    rowHover: '0 2px 8px rgba(0,0,0,0.07)',
    float: '0 2px 4px rgba(0,0,0,0.08), 0 8px 16px rgba(0,0,0,0.08), 0 24px 48px rgba(0,0,0,0.10)',
  },
  motion: {
    fast: '83ms',
    med: '167ms',
    slow: '250ms',
    page: '333ms',
    easeEnter: 'cubic-bezier(0,0,0,1)',
    easeMove: 'cubic-bezier(0.55,0.55,0,1)',
    easeFade: 'linear',
  },
  type: {
    caption: '12px/16px',
    body: '13px/18px',
    bodyLg: '14px/20px',
    subtitle: '16px/22px',
    title: '20px/28px',
    display: '28px/36px',
    family:
      "'Segoe UI Variable','Segoe UI','PingFang SC','Microsoft YaHei UI','Microsoft YaHei','Noto Sans SC',system-ui,sans-serif",
    mono: `ui-monospace,'Cascadia Code',Consolas,monospace`,
  },
  layout: {
    titlebarH: 40,
    sidebarW: 208,
    detailW: 360,
    cardW: 184,
    cardGap: 16,
    coverRatio: 3 / 2,
    titleZone: 32,
    rowH: 72,
    taskRowH: 64,
    overlayRight: 138,
  },
} as const

type BaseLayout = {
  titlebarH: number
  sidebarW: number
  detailW: number
  cardW: number
  cardGap: number
  coverRatio: number
  titleZone: number
  rowH: number
  taskRowH: number
  overlayRight: number
}
type BaseRadius = {
  xs: number
  sm: number
  md: number
  lg: number
  panel: number
  modal: number
  pill: number
}

// ---------------------------------------------------------------- 种子色与派生

type RGB = readonly [number, number, number]
type Hex = string

/** 深色主题种子（deriveDark 用）。nightPanel 只服务深色玻璃底，浅色用白玻璃。 */
interface DarkSeeds {
  night: RGB
  nightPanel: RGB
  float: RGB
  input: RGB
  textBase: RGB
  textHot: RGB
  accent: Hex
  accentHover: Hex
  onAccent: Hex
  star: Hex
  coverFallback: Hex
  bannerBase: Hex
  palette: Hex[]
  success: Hex
  successText: Hex
  successDeep: Hex
  warning: Hex
  error: Hex
  errorText: Hex
  errorDanger: Hex
}

/** 浅色主题种子（deriveLight 用）。 */
interface LightSeeds {
  night: RGB
  float: RGB
  input: RGB
  textBase: RGB
  textHot: RGB
  accent: Hex
  accentHover: Hex
  onAccent: Hex
  star: Hex
  coverFallback: Hex
  bannerBase: Hex
  palette: Hex[]
  success: Hex
  successText: Hex
  successDeep: Hex
  warning: Hex
  error: Hex
  errorText: Hex
  errorDanger: Hex
}

function rgbCss(c: RGB): string {
  return `${c[0]},${c[1]},${c[2]}`
}
function rgba(c: RGB, a: number): string {
  return `rgba(${rgbCss(c)},${a})`
}
function hexToRgb(h: Hex): RGB {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}
function rgbToHex(c: RGB): Hex {
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}
/** 与白/黑混合（t 为混合比例，0..1；dir=1 混白，-1 混黑） */
function mix(h: Hex, dir: 1 | -1, t: number): Hex {
  const [r, g, b] = hexToRgb(h)
  const tgt = dir === 1 ? 255 : 0
  const f = (v: number): number => Math.round(v + (tgt - v) * t)
  return `#${[f(r), f(g), f(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}
function gradToTop(baseHex: Hex, a1: number, a2: number): string {
  const [r, g, b] = hexToRgb(baseHex)
  return `linear-gradient(to top, ${baseHex} 0%, rgba(${r},${g},${b},${a1}) 55%, rgba(${r},${g},${b},${a2}) 100%)`
}
/** 实色成功底上的前景字：亮绿配深字、深绿配白字（运行徽章等，六套 preset 通用）。 */
function onColor(hex: Hex): Hex {
  const [r, g, b] = hexToRgb(hex)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55 ? '#0A1A10' : '#FFFFFF'
}

function deriveDark(s: DarkSeeds) {
  const tb = s.textBase
  return {
    windowFallback: rgbToHex(s.night),
    bgScrim: `linear-gradient(180deg, rgba(${rgbCss(s.night)},0.52) 0%, rgba(${rgbCss(s.night)},0.74) 100%)`,
    panelGlass: rgba(s.nightPanel, 0.62),
    panelGlassBorder: 'rgba(255,255,255,0.08)',
    panelGlassHighlight: 'rgba(255,255,255,0.10)',
    card: 'rgba(255,255,255,0.05)',
    cardBorder: 'rgba(255,255,255,0.09)',
    cardHover: 'rgba(255,255,255,0.08)',
    float: rgbToHex(s.float),
    floatBorder: 'rgba(255,255,255,0.12)',
    input: rgbToHex(s.input),
    text: rgba(tb, 0.92),
    textSecondary: rgba(tb, 0.7),
    textTertiary: rgba(tb, 0.5),
    accent: s.accent,
    accentHover: s.accentHover,
    accentBg: rgba(hexToRgb(s.accent), 0.14),
    success: s.success,
    onSuccess: onColor(s.success),
    warning: s.warning,
    error: s.error,
    scrim: 'linear-gradient(to top, rgba(0,0,0,0.85), rgba(0,0,0,0))',
    scrimSoft: 'linear-gradient(to top, rgba(0,0,0,0.65), rgba(0,0,0,0))',
    onAccent: s.onAccent,
    accentGrad: `linear-gradient(135deg, ${mix(s.accent, 1, 0.28)}, ${mix(s.accent, -1, 0.12)})`,
    accentGradStop: mix(s.accent, -1, 0.12),
    accentText: mix(s.accent, 1, 0.35),
    accentSoft: rgba(hexToRgb(s.accent), 0.1),
    accentCardBg: rgba(hexToRgb(s.accent), 0.1),
    accentSelectedBg: rgba(hexToRgb(s.accent), 0.16),
    accentSelectedRing: rgba(hexToRgb(s.accent), 0.45),
    accentChipBg: rgba(hexToRgb(s.accent), 0.25),
    accentFocusBorder: rgba(hexToRgb(s.accent), 0.75),
    accentFocusRing: rgba(hexToRgb(s.accent), 0.18),
    accentBtnShadow: rgba(hexToRgb(s.accent), 0.35),
    accentRing: rgba(hexToRgb(s.accent), 0.45),
    accentSelectedBorder: rgba(hexToRgb(s.accent), 0.55),
    accentShadow: rgba(hexToRgb(s.accent), 0.35),
    accentShadowHover: rgba(hexToRgb(s.accent), 0.5),
    surfaceHoverSoft: 'rgba(255,255,255,0.10)',
    thumbShadow: 'rgba(0,0,0,0.5)',
    thumbShadowSoft: 'rgba(0,0,0,0.35)',
    shineSweep: 'rgba(255,255,255,0.35)',
    textHot: rgba(s.textHot, 0.98),
    textGhost: rgba(tb, 0.18),
    star: s.star,
    coverFallback: s.coverFallback,
    bannerBase: s.bannerBase,
    textFaint: rgba(tb, 0.3),
    textDim: rgba(tb, 0.4),
    textMuted: rgba(tb, 0.45),
    textSoft: rgba(tb, 0.5),
    textMid: rgba(tb, 0.55),
    textMidHigh: rgba(tb, 0.62),
    textDimStrong: rgba(tb, 0.42),
    textSoftDim: rgba(tb, 0.35),
    textBright: rgba(tb, 0.68),
    textStrong: rgba(tb, 0.82),
    textStronger: rgba(tb, 0.88),
    textGlow: rgba(tb, 0.92),
    textMutedPure: rgba(tb, 0.75),
    successText: s.successText,
    successBg: rgba(hexToRgb(s.success), 0.14),
    successBorder: rgba(hexToRgb(s.success), 0.35),
    successOpaque: rgba(hexToRgb(s.success), 0.92),
    successDeep: s.successDeep,
    errorText: s.errorText,
    errorSoftText: s.errorText,
    errorSoftBg: rgba(hexToRgb(s.error), 0.12),
    errorDanger: s.errorDanger,
    errorHoverBg: rgba(hexToRgb(s.error), 0.18),
    warningSoftBg: rgba(hexToRgb(s.warning), 0.16),
    link: mix(s.accent, 1, 0.3),
    selectBg: s.accent,
    selectText: s.onAccent,
    selectIcon: s.onAccent,
    neutral: mix(s.accent, 1, 0.45),
    neutralDim: mix(s.accent, 1, 0.3),
    surfaceSoft: 'rgba(255,255,255,0.05)',
    surfaceMid: 'rgba(255,255,255,0.08)',
    surfaceHover: 'rgba(255,255,255,0.11)',
    surfaceStrong: 'rgba(255,255,255,0.14)',
    surfaceBright: 'rgba(255,255,255,0.04)',
    borderFaint: 'rgba(255,255,255,0.06)',
    borderGhost: 'rgba(255,255,255,0.18)',
    borderGhostSoft: 'rgba(255,255,255,0.15)',
    shadeThumb: 'rgba(0,0,0,0.5)',
    shadeThumbSoft: 'rgba(0,0,0,0.38)',
    shadeText: 'rgba(0,0,0,0.5)',
    shadeBanner: 'rgba(0,0,0,0.5)',
    bannerScrim: gradToTop(s.bannerBase, 0.55, 0.2),
    palette: s.palette,
  }
}

function deriveLight(s: LightSeeds) {
  const tb = s.textBase
  return {
    windowFallback: rgbToHex(s.night),
    bgScrim: `linear-gradient(180deg, rgba(${rgbCss(s.night)},0.55) 0%, rgba(${rgbCss(s.night)},0.80) 100%)`,
    panelGlass: 'rgba(255,255,255,0.66)',
    panelGlassBorder: rgba(tb, 0.1),
    panelGlassHighlight: 'rgba(255,255,255,0.75)',
    card: rgba(tb, 0.035),
    cardBorder: rgba(tb, 0.1),
    cardHover: rgba(tb, 0.06),
    float: rgbToHex(s.float),
    floatBorder: rgba(tb, 0.14),
    input: rgbToHex(s.input),
    text: rgba(tb, 0.92),
    textSecondary: rgba(tb, 0.68),
    textTertiary: rgba(tb, 0.48),
    accent: s.accent,
    accentHover: s.accentHover,
    accentBg: rgba(hexToRgb(s.accent), 0.1),
    success: s.success,
    onSuccess: onColor(s.success),
    warning: s.warning,
    error: s.error,
    scrim: `linear-gradient(to top, rgba(${rgbCss(tb)},0.85), rgba(${rgbCss(tb)},0))`,
    scrimSoft: `linear-gradient(to top, rgba(${rgbCss(tb)},0.65), rgba(${rgbCss(tb)},0))`,
    onAccent: s.onAccent,
    accentGrad: `linear-gradient(135deg, ${mix(s.accent, 1, 0.18)}, ${s.accent})`,
    accentGradStop: s.accent,
    accentText: mix(s.accent, -1, 0.25),
    accentSoft: rgba(hexToRgb(s.accent), 0.08),
    accentCardBg: rgba(hexToRgb(s.accent), 0.07),
    accentSelectedBg: rgba(hexToRgb(s.accent), 0.1),
    accentSelectedRing: rgba(hexToRgb(s.accent), 0.25),
    accentChipBg: rgba(hexToRgb(s.accent), 0.16),
    accentFocusBorder: rgba(hexToRgb(s.accent), 0.65),
    accentFocusRing: rgba(hexToRgb(s.accent), 0.12),
    accentBtnShadow: rgba(hexToRgb(s.accent), 0.3),
    accentRing: rgba(hexToRgb(s.accent), 0.35),
    accentSelectedBorder: rgba(hexToRgb(s.accent), 0.45),
    accentShadow: rgba(hexToRgb(s.accent), 0.28),
    accentShadowHover: rgba(hexToRgb(s.accent), 0.4),
    surfaceHoverSoft: rgba(tb, 0.06),
    thumbShadow: rgba(tb, 0.22),
    thumbShadowSoft: rgba(tb, 0.14),
    shineSweep: 'rgba(255,255,255,0.55)',
    textHot: rgba(s.textHot, 0.96),
    textGhost: rgba(tb, 0.16),
    star: s.star,
    coverFallback: s.coverFallback,
    bannerBase: s.bannerBase,
    textFaint: rgba(tb, 0.28),
    textDim: rgba(tb, 0.38),
    textMuted: rgba(tb, 0.45),
    textSoft: rgba(tb, 0.5),
    textMid: rgba(tb, 0.55),
    textMidHigh: rgba(tb, 0.62),
    textDimStrong: rgba(tb, 0.42),
    textSoftDim: rgba(tb, 0.32),
    textBright: rgba(tb, 0.68),
    textStrong: rgba(tb, 0.82),
    textStronger: rgba(tb, 0.88),
    textGlow: rgba(tb, 0.9),
    textMutedPure: rgba(tb, 0.75),
    successText: s.successText,
    successBg: rgba(hexToRgb(s.success), 0.1),
    successBorder: rgba(hexToRgb(s.success), 0.32),
    successOpaque: rgba(hexToRgb(s.success), 0.92),
    successDeep: s.successDeep,
    errorText: s.errorText,
    errorSoftText: s.errorText,
    errorSoftBg: rgba(hexToRgb(s.error), 0.08),
    errorDanger: s.errorDanger,
    errorHoverBg: rgba(hexToRgb(s.error), 0.12),
    warningSoftBg: rgba(hexToRgb(s.warning), 0.12),
    link: mix(s.accent, -1, 0.18),
    selectBg: s.accent,
    selectText: s.onAccent,
    selectIcon: s.onAccent,
    neutral: mix(s.accent, 1, 0.55),
    neutralDim: mix(s.accent, 1, 0.35),
    surfaceSoft: rgba(tb, 0.04),
    surfaceMid: rgba(tb, 0.07),
    surfaceHover: rgba(tb, 0.09),
    surfaceStrong: rgba(tb, 0.12),
    surfaceBright: rgba(tb, 0.02),
    borderFaint: rgba(tb, 0.06),
    borderGhost: rgba(tb, 0.16),
    borderGhostSoft: rgba(tb, 0.13),
    shadeThumb: rgba(tb, 0.35),
    shadeThumbSoft: rgba(tb, 0.25),
    shadeText: rgba(tb, 0.5),
    shadeBanner: rgba(tb, 0.28),
    bannerScrim: gradToTop(s.bannerBase, 0.55, 0.2),
    palette: s.palette,
  }
}

// ---------------------------------------------------------------- 主题套件

const SAKURA_DARK: DarkSeeds = {
  night: [14, 11, 22],
  nightPanel: [26, 20, 44],
  float: [26, 20, 48],
  input: [20, 15, 38],
  textBase: [244, 241, 255],
  textHot: [255, 252, 255],
  accent: '#FF7BA9',
  accentHover: '#FF96BC',
  onAccent: '#2B0A16',
  star: '#FFC94E',
  coverFallback: '#241B3E',
  bannerBase: '#171029',
  palette: ['#372C55', '#2C3355', '#2F4038', '#3D342E', '#3C2B41', '#2C3547'],
  success: '#4ADE80',
  successText: '#7CE9A2',
  successDeep: '#22C55E',
  warning: '#FBBF24',
  error: '#F87171',
  errorText: '#FCA5A5',
  errorDanger: '#EF4444',
}
const SAKURA_LIGHT: LightSeeds = {
  night: [248, 246, 252],
  float: [255, 255, 255],
  input: [255, 255, 255],
  textBase: [38, 24, 58],
  textHot: [38, 24, 58],
  accent: '#E0447E',
  accentHover: '#E85C92',
  onAccent: '#FFFFFF',
  star: '#D97706',
  coverFallback: '#EDE8F4',
  bannerBase: '#F3EFF9',
  palette: ['#D8CFE6', '#CBD2E4', '#CFDAD1', '#DED6CB', '#DFCDD6', '#CFD8E4'],
  success: '#16A34A',
  successText: '#15803D',
  successDeep: '#15803D',
  warning: '#D97706',
  error: '#DC2626',
  errorText: '#DC2626',
  errorDanger: '#DC2626',
}

const STARNIGHT_DARK: DarkSeeds = {
  night: [9, 14, 28],
  nightPanel: [18, 26, 46],
  float: [16, 23, 42],
  input: [12, 19, 36],
  textBase: [232, 242, 255],
  textHot: [250, 253, 255],
  accent: '#63D3FF',
  accentHover: '#8BE1FF',
  onAccent: '#04212F',
  star: '#FFD94E',
  coverFallback: '#10233F',
  bannerBase: '#0B1626',
  palette: ['#16283F', '#1A2E4A', '#16303F', '#1F2B3C', '#1C2A3E', '#1B2F4A'],
  success: '#34D399',
  successText: '#6EE7B7',
  successDeep: '#10B981',
  warning: '#FBBF24',
  error: '#F87171',
  errorText: '#FCA5A5',
  errorDanger: '#EF4444',
}
const STARNIGHT_LIGHT: LightSeeds = {
  night: [243, 247, 252],
  float: [255, 255, 255],
  input: [255, 255, 255],
  textBase: [23, 37, 58],
  textHot: [23, 37, 58],
  accent: '#0E7FB8',
  accentHover: '#1292D2',
  onAccent: '#FFFFFF',
  star: '#B45309',
  coverFallback: '#E3EDF7',
  bannerBase: '#EAF1F9',
  palette: ['#D3DDE8', '#CBD8E6', '#CFD9E2', '#D9DDE2', '#D8D9E2', '#CBD9E4'],
  success: '#0F9D58',
  successText: '#0B7A44',
  successDeep: '#0B7A44',
  warning: '#B45309',
  error: '#C62828',
  errorText: '#C62828',
  errorDanger: '#C62828',
}

const MINT_DARK: DarkSeeds = {
  night: [10, 17, 14],
  nightPanel: [18, 30, 24],
  float: [15, 26, 21],
  input: [11, 21, 17],
  textBase: [232, 250, 240],
  textHot: [250, 255, 251],
  accent: '#5EE6A8',
  accentHover: '#7CF0BB',
  onAccent: '#03231A',
  star: '#FFD94E',
  coverFallback: '#0F241C',
  bannerBase: '#0B1B14',
  palette: ['#153026', '#16302A', '#122B22', '#232E27', '#1E2D28', '#143028'],
  success: '#34D399',
  successText: '#6EE7B7',
  successDeep: '#10B981',
  warning: '#FBBF24',
  error: '#F87171',
  errorText: '#FCA5A5',
  errorDanger: '#EF4444',
}
const MINT_LIGHT: LightSeeds = {
  night: [244, 250, 247],
  float: [255, 255, 255],
  input: [255, 255, 255],
  textBase: [23, 52, 40],
  textHot: [23, 52, 40],
  accent: '#0E8F5E',
  accentHover: '#12A56F',
  onAccent: '#FFFFFF',
  star: '#B45309',
  coverFallback: '#E2F0E9',
  bannerBase: '#E9F3EE',
  palette: ['#D3E5DC', '#D2E4DC', '#CFE2D6', '#DEE5D8', '#DDE4D9', '#D0E4DA'],
  success: '#0F9D58',
  successText: '#0B7A44',
  successDeep: '#0B7A44',
  warning: '#B45309',
  error: '#C62828',
  errorText: '#C62828',
  errorDanger: '#C62828',
}

export interface ThemePresetMeta {
  name: string
  desc: string
  /** 预览色样（accent） */
  swatch: Hex
  dark: DarkSeeds
  light: LightSeeds
  layout?: Partial<BaseLayout>
  radius?: Partial<BaseRadius>
}

export const themePresets: Record<ThemePresetId, ThemePresetMeta> = {
  sakura: {
    name: '樱夜',
    desc: '紫夜星空 + 樱花粉',
    swatch: '#FF7BA9',
    dark: SAKURA_DARK,
    light: SAKURA_LIGHT,
  },
  starnight: {
    name: '星海',
    desc: '夜蓝深海 + 星青辉光',
    swatch: '#63D3FF',
    dark: STARNIGHT_DARK,
    light: STARNIGHT_LIGHT,
    layout: { sidebarW: 232 },
    radius: { panel: 12, modal: 16 },
  },
  mint: {
    name: '薄荷',
    desc: '墨绿森林 + 薄荷清露',
    swatch: '#5EE6A8',
    dark: MINT_DARK,
    light: MINT_LIGHT,
    layout: { sidebarW: 192 },
    radius: { panel: 20, modal: 20 },
  },
}

export const THEME_PRESET_IDS = Object.keys(themePresets) as ThemePresetId[]

// 默认套件（樱夜，向后兼容组件 import { tokens }）
const DEFAULT_PRESET: ThemePresetId = 'sakura'
const defaultColorsDark = deriveDark(themePresets[DEFAULT_PRESET].dark)
const defaultColorsLight = deriveLight(themePresets[DEFAULT_PRESET].light)

export const themeColors = { dark: defaultColorsDark, light: defaultColorsLight } as const

/** tokens.color 响应式真值：切主题时原地替换，组件 computed 自动重算 */
export const colorState = reactive({ ...defaultColorsDark })

/** 深色主题（默认，向后兼容组件 import { tokens }）；
 *  color 是 reactive，切主题由 setTheme 原地更新 */
export const tokens = {
  color: colorState,
  glass: base.glass,
  radius: base.radius,
  space: base.space,
  shadow: base.shadow,
  motion: base.motion,
  type: base.type,
  layout: base.layout,
}

export type Tokens = typeof tokens

export type TokenColors = ReturnType<typeof deriveDark>

const DEFAULT_DARK = true

/** 运行时当前主题（applyCssVars/setTheme 前由 main.ts 设置） */
export let currentDarkMode = DEFAULT_DARK
export let currentPresetId: ThemePresetId = DEFAULT_PRESET

/** 组装一套完整主题：base 常量 + 套件布局/圆角覆盖 + 对应调色板 */
export function makeTheme(darkMode: boolean, presetId: ThemePresetId = currentPresetId) {
  const preset = themePresets[presetId]
  const palette = darkMode ? deriveDark(preset.dark) : deriveLight(preset.light)
  return {
    ...base,
    layout: { ...base.layout, ...(preset.layout ?? {}) },
    radius: { ...base.radius, ...(preset.radius ?? {}) },
    color: palette,
  }
}

/**
 * 切换主题并重刷 CSS 变量与响应式 colorState。
 * - 全局 CSS var(--hh-*) 整体替换（组件 CSS 零改动）
 * - colorState 原地 Object.assign，Vue 组件里 computed(() => tokens.color.x) 自动刷新
 * - 同步 html[data-theme] 与 color-scheme
 */
export function setTheme(darkMode: boolean, presetId: ThemePresetId = currentPresetId): void {
  currentDarkMode = darkMode
  currentPresetId = presetId
  const theme = makeTheme(darkMode, presetId)
  Object.assign(colorState, theme.color)
  applyCssVars(darkMode, theme)
  const root = document.documentElement
  root.dataset.theme = darkMode ? 'dark' : 'light'
  root.style.colorScheme = darkMode ? 'dark' : 'light'
}

/**
 * 把指定主题平铺成 `--hh-*` CSS 变量（键名 kebab-case）。
 * 渲染入口挂载前调用一次（可传主题名）；运行中切主题用 setTheme（它会顺带更新 CSS 变量）。
 */
export function applyCssVars(
  darkMode: boolean = currentDarkMode,
  theme: ReturnType<typeof makeTheme> = makeTheme(darkMode),
): void {
  const root = document.documentElement
  const set = (k: string, v: string | number): void => root.style.setProperty(k, String(v))

  for (const [group, map] of Object.entries(theme)) {
    if (group === 'layout' || group === 'space' || group === 'glass' || group === 'radius') {
      for (const [k, v] of Object.entries(map)) {
        // layout/space/glass/radius 数字都是 px 尺寸（titlebarH/sidebarW/x4/blurPanel/radiusPanel…），
        // 不加单位会让 `border-radius: var(--hh-radius-panel)` 变成非法的 `16` 被丢弃——圆角/模糊全失效。
        // coverRatio 是比率。
        let out = String(v)
        if ((group === 'layout' || group === 'space' || group === 'glass' || group === 'radius') && typeof v === 'number' && k !== 'coverRatio') out = `${v}px`
        set(`--hh-${group}-${kebab(k)}`, out)
      }
      continue
    }
    if (group === 'type') {
      for (const [k, v] of Object.entries(map)) {
        if (k === 'family' || k === 'mono') {
          set(`--hh-font-${kebab(k)}`, v)
        } else {
          const [size, lh] = String(v).split('/')
          set(`--hh-font-${kebab(k)}-size`, size)
          set(`--hh-font-${kebab(k)}-lh`, lh)
        }
      }
      continue
    }
    for (const [k, v] of Object.entries(map)) {
      set(`--hh-${group}-${kebab(k)}`, v)
    }
  }
  root.dataset.theme = darkMode ? 'dark' : 'light'
  root.style.colorScheme = darkMode ? 'dark' : 'light'
}

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}
