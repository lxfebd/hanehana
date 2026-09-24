/**
 * 设计令牌唯一真值（REDESIGN-SPEC §3.3）。
 *
 * 颜色/圆角/阴影/动效/字号/间距只准从这里取；组件里写颜色字面量 = 违规。
 * antd seed 只喂实色 hex（§0-3），半透明只存在于这个 CSS 变量层
 * 与 antd component tokens 的定点覆盖。
 *
 * 主题：樱夜双主题（视觉重设计定稿，对标 VN 启动器 / GalSpace 沉浸式媒体库）。
 * - darkTokens  深色：紫调夜黑 #0E0B16 底 + 樱花粉 #FF7BA9 品牌 accent，
 *               状态用真彩色（绿/琥珀/红），封面取色光晕底做全窗氛围
 * - lightTokens 浅色：薰衣草白 #F8F6FC 底 + 深樱 #E0447E accent，同一粉色系
 * 所有 key 保持一致，组件 CSS 只消费 var(--hh-*)，切主题不触及组件。
 *
 * tokens.color 是 Vue reactive：切主题时 Object.assign 原地换值，
 * 组件里 `computed(() => tokens.color.star)` 这类静态消费也能跟着刷新。
 */
import { reactive } from 'vue'

export type ThemeName = 'dark' | 'light'

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

/**
 * 深色樱夜：紫调夜黑 #0E0B16 + 樱花粉 #FF7BA9 accent。
 * 层级靠「夜黑紫阶 + 粉色 accent」而非纯灰度；状态色回归真彩色，
 * 让下载中/完成/失败在封面墙里一眼可辨。
 */
const darkColor = {
  windowFallback: '#0E0B16',
  // 动态封面光晕底上的主题遮罩：紫黑夜色，上浅下深——顶部让封面氛围透出来，
  // 底部压住封面墙与任务区，文字立得住
  bgScrim: 'linear-gradient(180deg, rgba(14,11,22,0.52) 0%, rgba(14,11,22,0.74) 100%)',
  panelGlass: 'rgba(26,20,44,0.62)',
  panelGlassBorder: 'rgba(255,255,255,0.08)',
  panelGlassHighlight: 'rgba(255,255,255,0.10)',
  card: 'rgba(255,255,255,0.05)',
  cardBorder: 'rgba(255,255,255,0.09)',
  cardHover: 'rgba(255,255,255,0.08)',
  float: '#1A1430',
  floatBorder: 'rgba(255,255,255,0.12)',
  input: '#140F26',
  text: 'rgba(244,241,255,0.92)',
  textSecondary: 'rgba(244,241,255,0.70)',
  textTertiary: 'rgba(244,241,255,0.50)',
  accent: '#FF7BA9',
  accentHover: '#FF96BC',
  accentBg: 'rgba(255,123,169,0.14)',
  success: '#4ADE80',
  warning: '#FBBF24',
  error: '#F87171',
  scrim: 'linear-gradient(to top, rgba(0,0,0,0.85), rgba(0,0,0,0))',
  scrimSoft: 'linear-gradient(to top, rgba(0,0,0,0.65), rgba(0,0,0,0))',
  // ---- 语义衍生（组件只准消费 var(--hh-color-*)） ----
  onAccent: '#2B0A16',
  accentGrad: 'linear-gradient(135deg, #FF9BC0, #FF6D9E)',
  accentGradStop: '#FF6D9E',
  accentText: '#FF8FB8',
  accentSoft: 'rgba(255,123,169,0.10)',
  accentCardBg: 'rgba(255,123,169,0.10)',
  accentSelectedBg: 'rgba(255,123,169,0.16)',
  accentSelectedRing: 'rgba(255,123,169,0.45)',
  accentChipBg: 'rgba(255,123,169,0.25)',
  accentFocusBorder: 'rgba(255,123,169,0.75)',
  accentFocusRing: 'rgba(255,123,169,0.18)',
  accentBtnShadow: 'rgba(255,123,169,0.35)',
  accentRing: 'rgba(255,123,169,0.45)',
  accentSelectedBorder: 'rgba(255,123,169,0.55)',
  accentShadow: 'rgba(255,123,169,0.35)',
  accentShadowHover: 'rgba(255,123,169,0.50)',
  surfaceHoverSoft: 'rgba(255,255,255,0.10)',
  thumbShadow: 'rgba(0,0,0,0.5)',
  thumbShadowSoft: 'rgba(0,0,0,0.35)',
  shineSweep: 'rgba(255,255,255,0.35)',
  textHot: 'rgba(255,252,255,0.98)',
  textGhost: 'rgba(244,241,255,0.18)',
  star: '#FFC94E',
  coverFallback: '#241B3E',
  bannerBase: '#171029',
  // 文字层级：透明度从弱到强
  textFaint: 'rgba(244,241,255,0.30)',
  textDim: 'rgba(244,241,255,0.40)',
  textMuted: 'rgba(244,241,255,0.45)',
  textSoft: 'rgba(244,241,255,0.50)',
  textMid: 'rgba(244,241,255,0.55)',
  textMidHigh: 'rgba(244,241,255,0.62)',
  textDimStrong: 'rgba(244,241,255,0.42)',
  textSoftDim: 'rgba(244,241,255,0.35)',
  textBright: 'rgba(244,241,255,0.68)',
  textStrong: 'rgba(244,241,255,0.82)',
  textStronger: 'rgba(244,241,255,0.88)',
  textGlow: 'rgba(245,243,255,0.92)',
  textMutedPure: 'rgba(244,241,255,0.75)',
  // 状态衍生：真彩色（下载/完成/失败在封面墙里一眼可辨）
  successText: '#7CE9A2',
  successBg: 'rgba(74,222,128,0.14)',
  successBorder: 'rgba(74,222,128,0.35)',
  successOpaque: 'rgba(74,222,128,0.92)',
  successDeep: '#22C55E',
  errorText: '#FCA5A5',
  errorSoftText: '#FCA5A5',
  errorSoftBg: 'rgba(248,113,113,0.12)',
  errorDanger: '#EF4444',
  errorHoverBg: 'rgba(239,68,68,0.18)',
  warningSoftBg: 'rgba(251,191,36,0.16)',
  link: '#FFA5C5',
  // 选中态（nav / 分类芯片 / 徽标共用）：实心樱花粉胶囊 + 深梅文字，双主题同构
  selectBg: '#FF7BA9',
  selectText: '#2B0A16',
  selectIcon: '#2B0A16',
  // 中性灰（任务点/进度底）：薰衣草灰
  neutral: '#8B84A6',
  neutralDim: '#5F5878',
  // 元素表面
  surfaceSoft: 'rgba(255,255,255,0.05)',
  surfaceMid: 'rgba(255,255,255,0.08)',
  surfaceHover: 'rgba(255,255,255,0.11)',
  surfaceStrong: 'rgba(255,255,255,0.14)',
  surfaceBright: 'rgba(255,255,255,0.04)',
  borderFaint: 'rgba(255,255,255,0.06)',
  borderGhost: 'rgba(255,255,255,0.18)',
  borderGhostSoft: 'rgba(255,255,255,0.15)',
  // 遮罩
  shadeThumb: 'rgba(0,0,0,0.5)',
  shadeThumbSoft: 'rgba(0,0,0,0.38)',
  shadeText: 'rgba(0,0,0,0.5)',
  shadeBanner: 'rgba(0,0,0,0.5)',
  bannerScrim: 'linear-gradient(to top, #171029 0%, rgba(23,16,41,0.55) 55%, rgba(23,16,41,0.2) 100%)',
  // 哈希调色板（无主色封面的占位底色）— 深色下去饱和紫调
  palette: ['#372C55', '#2C3355', '#2F4038', '#3D342E', '#3C2B41', '#2C3547'],
} as const

/**
 * 浅色樱夜：薰衣草白 #F8F6FC + 深樱 #E0447E accent。
 * 与深色同一粉色系；文字用梅色墨 #26183A 系而非纯黑，弱化系统工具的冷硬感。
 */
const lightColor = {
  windowFallback: '#F8F6FC',
  // 动态封面光晕底上的主题遮罩：上浅下深，底部压住封面墙
  bgScrim: 'linear-gradient(180deg, rgba(248,246,252,0.55) 0%, rgba(248,246,252,0.80) 100%)',
  panelGlass: 'rgba(255,255,255,0.66)',
  panelGlassBorder: 'rgba(46,26,74,0.10)',
  panelGlassHighlight: 'rgba(255,255,255,0.75)',
  card: 'rgba(46,26,74,0.035)',
  cardBorder: 'rgba(46,26,74,0.10)',
  cardHover: 'rgba(46,26,74,0.06)',
  float: '#FFFFFF',
  floatBorder: 'rgba(46,26,74,0.14)',
  input: '#FFFFFF',
  text: 'rgba(38,24,58,0.92)',
  textSecondary: 'rgba(38,24,58,0.68)',
  textTertiary: 'rgba(38,24,58,0.48)',
  accent: '#E0447E',
  accentHover: '#E85C92',
  accentBg: 'rgba(224,68,126,0.10)',
  success: '#16A34A',
  warning: '#D97706',
  error: '#DC2626',
  scrim: 'linear-gradient(to top, rgba(38,24,58,0.85), rgba(38,24,58,0))',
  scrimSoft: 'linear-gradient(to top, rgba(38,24,58,0.65), rgba(38,24,58,0))',
  // ---- 语义衍生（组件只准消费 var(--hh-color-*)） ----
  onAccent: '#FFFFFF',
  accentGrad: 'linear-gradient(135deg, #F0629B, #E0447E)',
  accentGradStop: '#E0447E',
  accentText: '#C2185B',
  accentSoft: 'rgba(224,68,126,0.08)',
  accentCardBg: 'rgba(224,68,126,0.07)',
  accentSelectedBg: 'rgba(224,68,126,0.10)',
  accentSelectedRing: 'rgba(224,68,126,0.25)',
  accentChipBg: 'rgba(224,68,126,0.16)',
  accentFocusBorder: 'rgba(224,68,126,0.65)',
  accentFocusRing: 'rgba(224,68,126,0.12)',
  accentBtnShadow: 'rgba(224,68,126,0.30)',
  accentRing: 'rgba(224,68,126,0.35)',
  accentSelectedBorder: 'rgba(224,68,126,0.45)',
  accentShadow: 'rgba(224,68,126,0.28)',
  accentShadowHover: 'rgba(224,68,126,0.40)',
  surfaceHoverSoft: 'rgba(46,26,74,0.06)',
  thumbShadow: 'rgba(46,26,74,0.22)',
  thumbShadowSoft: 'rgba(46,26,74,0.14)',
  shineSweep: 'rgba(255,255,255,0.55)',
  textHot: 'rgba(38,24,58,0.96)',
  textGhost: 'rgba(38,24,58,0.16)',
  star: '#D97706',
  coverFallback: '#EDE8F4',
  bannerBase: '#F3EFF9',
  // 文字层级：透明度从弱到强
  textFaint: 'rgba(38,24,58,0.28)',
  textDim: 'rgba(38,24,58,0.38)',
  textMuted: 'rgba(38,24,58,0.45)',
  textSoft: 'rgba(38,24,58,0.50)',
  textMid: 'rgba(38,24,58,0.55)',
  textMidHigh: 'rgba(38,24,58,0.62)',
  textDimStrong: 'rgba(38,24,58,0.42)',
  textSoftDim: 'rgba(38,24,58,0.32)',
  textBright: 'rgba(38,24,58,0.68)',
  textStrong: 'rgba(38,24,58,0.82)',
  textStronger: 'rgba(38,24,58,0.88)',
  textGlow: 'rgba(38,24,58,0.90)',
  textMutedPure: 'rgba(38,24,58,0.75)',
  // 状态衍生：真彩色
  successText: '#15803D',
  successBg: 'rgba(22,163,74,0.10)',
  successBorder: 'rgba(22,163,74,0.32)',
  successOpaque: 'rgba(22,163,74,0.92)',
  successDeep: '#15803D',
  errorText: '#DC2626',
  errorSoftText: '#DC2626',
  errorSoftBg: 'rgba(220,38,38,0.08)',
  errorDanger: '#DC2626',
  errorHoverBg: 'rgba(220,38,38,0.12)',
  warningSoftBg: 'rgba(217,119,6,0.12)',
  link: '#C2185B',
  // 选中态：实心深樱胶囊 + 白字
  selectBg: '#E0447E',
  selectText: '#FFFFFF',
  selectIcon: '#FFFFFF',
  // 中性灰（任务点/进度底）
  neutral: '#B9B0CC',
  neutralDim: '#8F85A8',
  // 元素表面
  surfaceSoft: 'rgba(46,26,74,0.04)',
  surfaceMid: 'rgba(46,26,74,0.07)',
  surfaceHover: 'rgba(46,26,74,0.09)',
  surfaceStrong: 'rgba(46,26,74,0.12)',
  surfaceBright: 'rgba(46,26,74,0.02)',
  borderFaint: 'rgba(46,26,74,0.06)',
  borderGhost: 'rgba(46,26,74,0.16)',
  borderGhostSoft: 'rgba(46,26,74,0.13)',
  // 遮罩
  shadeThumb: 'rgba(38,24,58,0.35)',
  shadeThumbSoft: 'rgba(38,24,58,0.25)',
  shadeText: 'rgba(38,24,58,0.5)',
  shadeBanner: 'rgba(38,24,58,0.28)',
  bannerScrim: 'linear-gradient(to top, #F3EFF9 0%, rgba(243,239,249,0.55) 55%, rgba(243,239,249,0.2) 100%)',
  // 哈希调色板（浅色下去饱和薰衣草调）
  palette: ['#D8CFE6', '#CBD2E4', '#CFDAD1', '#DED6CB', '#DFCDD6', '#CFD8E4'],
} as const

export const themeColors = { dark: darkColor, light: lightColor } as const

/** tokens.color 响应式真值：切主题时原地替换，组件 computed 自动重算 */
export const colorState = reactive({ ...darkColor })

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

export type TokenColors = typeof darkColor

const DEFAULT_DARK = true

/** 运行时当前主题（applyCssVars/setTheme 前由 main.ts 设置） */
export let currentDarkMode = DEFAULT_DARK

/** 组装一套完整主题：base 常量 + 对应调色板 */
export function makeTheme(darkMode: boolean) {
  return {
    ...base,
    color: darkMode ? darkColor : lightColor,
  }
}

/**
 * 切换主题并重刷 CSS 变量与响应式 colorState。
 * - 全局 CSS var(--hh-*) 整体替换（组件 CSS 零改动）
 * - colorState 原地 Object.assign，Vue 组件里 computed(() => tokens.color.x) 自动刷新
 * - 同步 html[data-theme] 与 color-scheme
 */
export function setTheme(darkMode: boolean): void {
  currentDarkMode = darkMode
  const theme = makeTheme(darkMode)
  Object.assign(colorState, theme.color)
  applyCssVars(darkMode, theme)
  const root = document.documentElement
  root.dataset.theme = darkMode ? 'dark' : 'light'
  root.style.colorScheme = darkMode ? 'dark' : 'light'
}

/**
 * 把指定主题平铺成 `--hh-*` CSS 变量（键名 kebab-case）。
 * 渲染入口挂载前调用一次（可传主题名）；组件 CSS 只准消费 var(--hh-*)。
 * 运行中切主题用 setTheme（它会顺带更新 CSS 变量）。
 */
export function applyCssVars(darkMode: boolean = currentDarkMode, theme: ReturnType<typeof makeTheme> = makeTheme(darkMode)): void {
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