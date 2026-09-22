/**
 * antd 主题（REDESIGN-SPEC §4.1）。
 *
 * 铁律 §0-3：seed token 只喂实色 hex（rgba 会破坏 darkAlgorithm 的派生色链），
 * 半透明只出现在 component tokens 的定点覆盖（Select optionSelectedBg）。
 * 浮层（Modal/Select 下拉/Popconfirm/Message）保持实色高不透明。
 *
 * 类型注：ant-design-vue 的 ComponentToken 声明面很窄（多数为空接口），
 * token 键名是运行时泛型，所以这里整体断言，值仍按规格书逐项落地。
 */
import type { ThemeConfig } from 'ant-design-vue/es/config-provider/context'
import { theme } from 'ant-design-vue'
import { tokens } from './tokens'

export const antdTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: tokens.color.accent,
    colorBgBase: tokens.color.windowFallback,
    colorSuccess: tokens.color.success,
    colorWarning: tokens.color.warning,
    colorError: tokens.color.error,
    colorText: tokens.color.text,
    colorLink: tokens.color.accent,
    borderRadius: 8,
    fontSize: 13,
    controlHeight: 32,
  },
  components: {
    Modal: {
      borderRadiusLG: 16,
      headerBg: tokens.color.float,
      contentBg: tokens.color.float,
      titleFontSize: 14,
      titleColor: 'rgba(255,255,255,0.9)',
    },
    Select: {
      selectorBg: tokens.color.input,
      colorBgElevated: tokens.color.float,
      optionSelectedBg: 'rgba(77,163,255,0.16)',
      borderRadius: 10,
    },
    Input: {
      colorBgContainer: tokens.color.input,
      borderRadius: 10,
      activeBorderColor: tokens.color.accent,
      hoverBorderColor: 'rgba(77,163,255,0.6)',
    },
    InputNumber: {
      colorBgContainer: tokens.color.input,
      borderRadius: 10,
    },
    Button: {
      borderRadius: 10,
      controlHeight: 34,
      primaryShadow: '0 4px 14px rgba(77,163,255,0.3)',
    },
    Tabs: {
      itemColor: 'rgba(255,255,255,0.68)',
      itemSelectedColor: tokens.color.accentHover,
      inkBarColor: tokens.color.accent,
      horizontalItemPadding: '8px 12px',
    },
    Switch: { colorPrimary: tokens.color.accent, handleSize: 18 },
    Checkbox: { colorPrimary: tokens.color.accent, borderRadiusSM: 4 },
    Tag: { borderRadiusSM: 6 },
    Popconfirm: { colorBgElevated: tokens.color.float },
    Message: { colorBgElevated: tokens.color.float, borderRadiusLG: 10 },
  },
} as unknown as ThemeConfig
