/**
 * antd 主题（REDESIGN-SPEC §4.1）。
 *
 * 铁律 §0-3：seed token 只喂实色 hex（rgba 会破坏 darkAlgorithm 的派生色链），
 * 半透明只出现在 component tokens 的定点覆盖（Select optionSelectedBg）。
 * 浮层（Modal/Select 下拉/Popconfirm/Message）保持实色高不透明。
 *
 * 双主题（樱夜深色 / 樱夜浅色）：ui.dark 切换 darkAlgorithm/defaultAlgorithm。
 * 暴露 computed：ConfigProvider :theme 传 computed，切主题自动重渲。
 *
 * 类型注：ant-design-vue 的 ComponentToken 声明面很窄（多数为空接口），
 * token 键名是运行时泛型，所以这里整体断言，值仍按规格书逐项落地。
 */
import { computed } from 'vue'
import type { ThemeConfig } from 'ant-design-vue/es/config-provider/context'
import { theme } from 'ant-design-vue'
import { ui } from '../stores/ui'
import { colorState } from './tokens'
import type { TokenColors } from './tokens'

/** 深浅主题的组件级覆盖（Modal/Select/Input/Button/Tabs 等） */
function componentTokens(colors: TokenColors) {
  return {
    Modal: {
      borderRadiusLG: 16,
      headerBg: colors.float,
      contentBg: colors.float,
      titleFontSize: 14,
      titleColor: colors.text,
    },
    Select: {
      selectorBg: colors.input,
      colorBgElevated: colors.float,
      optionSelectedBg: colors.accentBg,
      borderRadius: 10,
    },
    Input: {
      colorBgContainer: colors.input,
      borderRadius: 10,
      activeBorderColor: colors.accent,
      hoverBorderColor: colors.accentFocusBorder,
    },
    InputNumber: {
      colorBgContainer: colors.input,
      borderRadius: 10,
    },
    Button: {
      borderRadius: 10,
      controlHeight: 34,
      primaryShadow: `0 4px 14px ${colors.accentShadow}`,
    },
    Tabs: {
      itemColor: colors.textSecondary,
      itemSelectedColor: colors.accent,
      inkBarColor: colors.accent,
      horizontalItemPadding: '8px 12px',
    },
    Switch: { colorPrimary: colors.accent, handleSize: 18 },
    Checkbox: { colorPrimary: colors.accent, borderRadiusSM: 4 },
    Tag: { borderRadiusSM: 6 },
    Popconfirm: { colorBgElevated: colors.float },
    Message: { colorBgElevated: colors.float, borderRadiusLG: 10 },
  }
}

/** 按 UI 主题生成 antd ThemeConfig（响应式：切换后 ConfigProvider 自动重渲） */
export const antdTheme = computed<ThemeConfig>(() => {
  const dark = ui.dark
  // seed 只喂实色 hex（§0-3）：rgba 会破坏 darkAlgorithm 的派生色链
  const bodyBg = dark ? '#0E0B16' : '#FFFFFF'
  const bodyText = dark ? '#F4F1FF' : '#26183A'
  const border = dark ? '#424048' : '#CCCCCC'
  return {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: colorState.accent,
      colorInfo: colorState.accent,
      colorBgBase: bodyBg,
      colorTextBase: bodyText,
      colorSuccess: colorState.success,
      colorWarning: colorState.warning,
      colorError: colorState.error,
      colorBorder: border,
      colorLink: colorState.accent,
      borderRadius: 8,
      fontSize: 13,
      controlHeight: 32,
    },
    components: componentTokens(colorState),
  } as unknown as ThemeConfig
})