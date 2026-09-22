import type { ThemeConfig } from 'ant-design-vue/es/config-provider/context'
import { theme } from 'ant-design-vue'

/**
 * 主题调色板：整份界面唯一的一份颜色来源。
 *
 * 玻璃风的关键差异（重构版）：
 *   - 深色底用 #1a1a1f 系 —— 比 #202020 更深一档，与 Mica 暗色 tint 融合更好，
 *     玻璃块与窗口底对比更清楚，封面大图更出彩。
 *   - colorBgContainer / colorBgElevated 用低透明玻璃色，配合 CSS 层
 *     backdrop-filter 才是真毛玻璃；纯不透明色会让玻璃感归零。
 *   - 强调色往青蓝走（#4da3ff），比纯蓝更「羽花」、更轻盈。
 *
 * 只列「语义终态」颜色，不碰派生 token（algorithm 会重新算）。
 */
export interface Palette {
  colorPrimary: string
  colorBgBase: string
  colorBgLayout: string
  colorBgContainer: string
  colorBgElevated: string
  colorPrimaryBg: string
  colorPrimaryHover: string
  colorPrimaryText: string
  colorText: string
  colorTextSecondary: string
  colorTextTertiary: string
  colorBorder: string
  colorBorderSecondary: string
  colorFillTertiary: string
  colorSuccess: string
  colorWarning: string
  colorError: string
}

const DARK: Palette = {
  colorPrimary: '#4da3ff',
  colorBgBase: '#1a1a1f',
  colorBgLayout: '#1a1a1f',
  colorBgContainer: 'rgba(255, 255, 255, 0.06)',
  colorBgElevated: 'rgba(255, 255, 255, 0.10)',
  colorPrimaryBg: 'rgba(77, 163, 255, 0.16)',
  colorPrimaryHover: '#7ec3ff',
  colorPrimaryText: '#7ec3ff',
  colorText: 'rgba(255, 255, 255, 0.92)',
  colorTextSecondary: 'rgba(255, 255, 255, 0.68)',
  colorTextTertiary: 'rgba(255, 255, 255, 0.42)',
  colorBorder: 'rgba(255, 255, 255, 0.14)',
  colorBorderSecondary: 'rgba(255, 255, 255, 0.08)',
  colorFillTertiary: 'rgba(255, 255, 255, 0.08)',
  colorSuccess: '#5ec269',
  colorWarning: '#e8b450',
  colorError: '#e05555',
}

const LIGHT: Palette = {
  colorPrimary: '#1677ff',
  colorBgBase: '#f5f5f7',
  colorBgLayout: '#f5f5f7',
  colorBgContainer: 'rgba(255, 255, 255, 0.55)',
  colorBgElevated: 'rgba(255, 255, 255, 0.75)',
  colorPrimaryBg: 'rgba(22, 119, 255, 0.10)',
  colorPrimaryHover: '#4096ff',
  colorPrimaryText: '#4096ff',
  colorText: 'rgba(0, 0, 0, 0.88)',
  colorTextSecondary: 'rgba(0, 0, 0, 0.65)',
  colorTextTertiary: 'rgba(0, 0, 0, 0.45)',
  colorBorder: 'rgba(0, 0, 0, 0.12)',
  colorBorderSecondary: 'rgba(0, 0, 0, 0.06)',
  colorFillTertiary: 'rgba(0, 0, 0, 0.04)',
  colorSuccess: '#52c41a',
  colorWarning: '#faad14',
  colorError: '#ff4d4f',
}

export function palette(dark: boolean): Palette {
  return dark ? DARK : LIGHT
}

/** 喂给 ConfigProvider。圆角：玻璃窗 16px，组件 8px。 */
export function appTheme(dark: boolean): ThemeConfig {
  const p = palette(dark)
  return {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: p.colorPrimary,
      colorBgBase: p.colorBgBase,
      fontSize: 14,
      borderRadius: 8,
      controlHeight: 32,
      padding: 12,
      paddingSM: 8,
      colorLink: p.colorPrimary,
    },
    components: {
      Card: { borderRadiusLG: 16 },
      Modal: { borderRadiusLG: 18 },
      Button: { borderRadius: 10, controlHeight: 34 },
      Input: { borderRadius: 10 },
      Select: { borderRadius: 10 },
      Tag: { borderRadius: 8 },
    },
  }
}
