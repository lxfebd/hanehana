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
  },
  glass: { blurPanel: '16px', blurFloat: '24px', saturate: '1.5' },
  radius: { xs: 6, sm: 8, md: 10, lg: 12, panel: 16, modal: 16, pill: 999 },
  space: { x1: 4, x2: 8, x3: 12, x4: 16, x6: 24, x8: 32 },
  shadow: {
    card: '0 2px 8px rgba(0,0,0,0.35)',
    cardHover: '0 8px 24px rgba(0,0,0,0.45)',
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
