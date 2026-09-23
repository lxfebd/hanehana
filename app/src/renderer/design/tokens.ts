/**
 * 设计令牌唯一真值（REDESIGN-SPEC §3.3）。
 *
 * 颜色/圆角/阴影/动效/字号/间距只准从这里取；组件里写颜色字面量 = 违规。
 * antd seed 只喂实色 hex（§0-3），半透明只存在于这个 CSS 变量层
 * 与 antd component tokens 的定点覆盖。
 */
export const tokens = {
  color: {
    // 三层：窗口底(Mica/回退) → 固定面板玻璃 → 卡片 → 浮层(实色高不透明)
    windowFallback: '#202020',
    panelGlass: 'rgba(255,255,255,0.05)',
    panelGlassBorder: 'rgba(255,255,255,0.10)',
    panelGlassHighlight: 'rgba(255,255,255,0.12)',
    card: 'rgba(255,255,255,0.04)',
    cardBorder: 'rgba(255,255,255,0.08)',
    cardHover: 'rgba(255,255,255,0.07)',
    float: '#26262b',
    floatBorder: 'rgba(255,255,255,0.14)',
    input: '#232329',
    text: 'rgba(255,255,255,0.90)',
    textSecondary: 'rgba(255,255,255,0.68)',
    textTertiary: 'rgba(255,255,255,0.48)',
    accent: '#4da3ff',
    accentHover: '#7ec3ff',
    accentBg: 'rgba(77,163,255,0.16)',
    success: '#5ec269',
    warning: '#e8b450',
    error: '#e05555',
    scrim: 'linear-gradient(to top, rgba(12,12,16,0.85), rgba(12,12,16,0))',
    scrimSoft: 'linear-gradient(to top, rgba(12,12,16,0.65), rgba(12,12,16,0))',
    // ---- 语义衍生（D34 补充：组件只准消费 var(--hh-color-*)） ----
    onAccent: '#ffffff', // 主色/实色底上的白字
    accentGrad: 'linear-gradient(135deg, #4da3ff, #2f6fed)', // 主按钮渐变
    accentGradStop: '#2f6fed',
    accentText: '#7ec3ff', // 主色场景下的高亮文字（等同 accentHover）
    accentSoft: 'rgba(77,163,255,0.10)', // 浅 hover 底
    accentCardBg: 'rgba(77,163,255,0.1)', // 选中卡片底（ScrapeDialog）
    accentSelectedBg: 'rgba(77,163,255,0.13)', // 选中行/卡底
    accentSelectedRing: 'rgba(77,163,255,0.25)', // 选中卡外光晕（CoverGrid）
    accentChipBg: 'rgba(77,163,255,0.2)', // segmented/筛选项选中底
    accentFocusBorder: 'rgba(77,163,255,0.6)', // 搜索框聚焦描边
    accentFocusRing: 'rgba(77,163,255,0.15)', // 搜索框聚焦光环
    accentBtnShadow: 'rgba(77,163,255,0.3)', // 小按钮投影
    accentRing: 'rgba(77,163,255,0.35)', // 选中描边/光环
    accentSelectedBorder: 'rgba(77,163,255,0.38)', // 选中描边（TaskRow）
    accentShadow: 'rgba(77,163,255,0.35)', // 主按钮投影
    accentShadowHover: 'rgba(77,163,255,0.5)', // 主按钮 hover 投影
    surfaceHoverSoft: 'rgba(255,255,255,0.13)', // ghost 按钮 hover 底
    thumbShadow: 'rgba(0,0,0,0.38)', // 封面/缩略图投影
    thumbShadowSoft: 'rgba(0,0,0,0.3)', // 列表缩略图投影
    shineSweep: 'rgba(255,255,255,0.4)', // 进度条流光
    textHot: 'rgba(255,255,255,0.95)', // hover 极亮文字
    textGhost: 'rgba(255,255,255,0.18)', // 禁用态文字
    star: '#ffd666', // 评分星
    coverFallback: '#2a3a5f', // 无图封面占位底色
    bannerBase: '#1a1a1f', // 无图横幅收边色（DetailPanel 渐变）
    // 文字层级：透明度从弱到强
    textFaint: 'rgba(255,255,255,0.30)',
    textDim: 'rgba(255,255,255,0.40)',
    textMuted: 'rgba(255,255,255,0.45)',
    textSoft: 'rgba(255,255,255,0.50)',
    textMid: 'rgba(255,255,255,0.55)',
    textMidHigh: 'rgba(255,255,255,0.60)',
    textDimStrong: 'rgba(255,255,255,0.42)', // 元数据键（meta-key）
    textSoftDim: 'rgba(255,255,255,0.35)', // 空态/禁用极弱文字
    textBright: 'rgba(255,255,255,0.65)',
    textStrong: 'rgba(255,255,255,0.80)',
    textStronger: 'rgba(255,255,255,0.85)',
    textGlow: 'rgba(255,255,255,0.88)',
    textMutedPure: 'rgba(255,255,255,0.75)', // ghost 按钮等偏亮文字
    // 状态衍生
    successText: '#8ad17e',
    successBg: 'rgba(94,194,105,0.18)',
    successBorder: 'rgba(94,194,105,0.40)',
    successOpaque: 'rgba(94,194,105,0.9)', // 运行中徽章底
    successDeep: '#3fa04b', // 进度条满色（比 success 深一档）
    errorText: '#ff9a9a', // 错误场景高亮文字
    errorSoftText: '#ff8f8f', // 错误提示文字
    errorSoftBg: 'rgba(255,77,79,0.08)', // 错误块浅底
    errorDanger: '#e05252', // 表单校验/危险文字
    errorHoverBg: 'rgba(224,85,85,0.16)', // 危险按钮 hover 底
    warningSoftBg: 'rgba(233,168,80,0.20)',
    link: '#69b1ff', // 可点击链接文字
    // 中性灰（任务点/进度底）
    neutral: '#8a8f9d',
    neutralDim: '#6a6f7d',
    // 元素表面
    surfaceSoft: 'rgba(255,255,255,0.06)',
    surfaceMid: 'rgba(255,255,255,0.08)',
    surfaceHover: 'rgba(255,255,255,0.12)',
    surfaceStrong: 'rgba(255,255,255,0.14)',
    surfaceBright: 'rgba(255,255,255,0.04)', // 比 card 更浅的底
    borderFaint: 'rgba(255,255,255,0.05)',
    borderGhost: 'rgba(255,255,255,0.18)', // ghost 按钮描边（CoverGrid）
    borderGhostSoft: 'rgba(255,255,255,0.16)', // ghost 按钮描边（DetailPanel）
    // 遮罩
    shadeThumb: 'rgba(0,0,0,0.5)', // 封面底部渐晕
    shadeThumbSoft: 'rgba(0,0,0,0.38)', // 封面阴影
    shadeText: 'rgba(0,0,0,0.5)', // 白字下的投影
    shadeBanner: 'rgba(0,0,0,0.5)', // 封面卡片深阴影
    bannerScrim: 'linear-gradient(to top, #1a1a1f 0%, rgba(26,26,31,0.55) 55%, rgba(26,26,31,0.2) 100%)',
    // 哈希调色板（无主色封面的占位底色）
    palette: ['#3b4a6b', '#4a3b6b', '#3b6b5a', '#6b5a3b', '#6b3b4a', '#3b5a6b'],
  },
  glass: { blurPanel: '16px', blurFloat: '24px', saturate: '1.5' },
  radius: { xs: 6, sm: 8, md: 10, lg: 12, panel: 16, modal: 16, pill: 999 },
  space: { x1: 4, x2: 8, x3: 12, x4: 16, x6: 24, x8: 32 },
  shadow: {
    card: '0 2px 8px rgba(0,0,0,0.35)',
    cardHover: '0 8px 24px rgba(0,0,0,0.45)',
    rowHover: '0 6px 20px rgba(0,0,0,0.25)', // 任务行 hover 浮起
    float: '0 2px 4px rgba(0,0,0,0.4), 0 8px 16px rgba(0,0,0,0.32), 0 32px 64px rgba(0,0,0,0.28)',
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

export type Tokens = typeof tokens

/**
 * 把 tokens 平铺成 `--hh-*` CSS 变量（键名 kebab-case）。
 * 渲染入口挂载前调用一次；组件 CSS 只准消费 var(--hh-*)。
 */
export function applyCssVars(): void {
  const root = document.documentElement
  const set = (k: string, v: string | number): void => root.style.setProperty(k, String(v))

  for (const [group, map] of Object.entries(tokens)) {
    if (group === 'layout' || group === 'glass') {
      for (const [k, v] of Object.entries(map)) {
        set(`--hh-${group}-${kebab(k)}`, typeof v === 'object' ? JSON.stringify(v) : v)
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
}

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}
