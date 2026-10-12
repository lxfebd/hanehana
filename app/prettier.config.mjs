/**
 * Prettier 配置：格式收敛的唯一真值。
 * 与 Vue 官方/electron-vite 默认保持一致（2 空格、单引号、无分号、120 宽）。
 * .prettierignore 排除构建产物与第三方。
 */
export default {
  semi: false,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 120,
  tabWidth: 2,
  endOfLine: 'lf',
  vueIndentScriptAndStyle: false,
}