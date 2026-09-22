import type { ThemeConfig } from 'ant-design-vue/es/config-provider/context'
import { theme } from 'ant-design-vue'

/**
 * 主题调色板：整份界面唯一的一份颜色来源。
 *
 * 玻璃风的关键差异 vs FastDrop：
 *   - 深色底不用纯 #141414，而用 #202020 系 —— 与 Mica 暗色 tint 一致，
 *     窗口背景与 Mica 采样融合，避免「玻璃块 + 纯黑底」的割裂。
 *   - colorBgContainer / colorBgElevated 用低透明玻璃色，配合 CSS 层
 *     backdrop-filter 才是真毛玻璃；纯不透明色会让玻璃感归零。
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
  colorPrimary: '#4096ff',
  colorBgBase: '#202020',
  colorBgLayout: '#202020',
  colorBgContainer: 'rgba(255, 255, 255, 0.06)',
  colorBgElevated: 'rgba(255, 255, 255, 0.10)',
  colorPrimaryBg: 'rgba(64, 150, 255, 0.18)',
  colorPrimaryHover: '#69b1ff',
  colorPrimaryText: '#69b1ff',
  colorText: 'rgba(255, 255, 255, 0.88)',
  colorTextSecondary: 'rgba(255, 255, 255, 0.65)',
  colorTextTertiary: 'rgba(255, 255, 255, 0.45)',
  colorBorder: 'rgba(255, 255, 255, 0.14)',
  colorBorderSecondary: 'rgba(255, 255, 255, 0.08)',
  colorFillTertiary: 'rgba(255, 255, 255, 0.08)',
  colorSuccess: '#49aa19',
  colorWarning: '#e8b450',
  colorError: '#e05252',
}

const LIGHT: Palette = {
  colorPrimary: '#1677ff',
  colorBgBase: '#f5f5f5',
  colorBgLayout: '#f5f5f5',
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
    },
    components: {
      Card: { borderRadiusLG: 16 },
      Modal: { borderRadiusLG: 16 },
    },
  }
}
