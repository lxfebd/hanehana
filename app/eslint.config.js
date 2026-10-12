/**
 * ESLint 扁平配置（FlatConfig）。
 *
 * 定位：类型安全 + 危险模式的纠错，不追求风格（风格交给 prettier）。
 * 零基线策略：对存量代码只查「明显危险」的规则，不强制全仓立刻整改；
 * 新代码默认满足这些规则，存量问题可渐进修复（见各规则注释）。
 */
import js from '@eslint/js'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import vue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

export default [
  {
    ignores: [
      'out/**',
      'release/**',
      'dist/**',
      '.test-build/**',
      'node_modules/**',
      'scripts/**',
      '*.config.*',
    ],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      // TS 文件里「未定义的标识符」由 tsc 报（更准，带类型信息）；
      // eslint 的 no-undef 在 TS 下是重复且误报（globals 环境差异，如 URL）。
      'no-undef': 'off',
      // TS 惯用（提前声明再分支赋值）会让 no-useless-assignment 大量误报，
      // 数据流是否正确由 tsc 运行时兜底，这里不查。
      'no-useless-assignment': 'off',
      // 控制字符过滤正则（[\x00-\x1f]）是刻意的输入消毒，不是事故
      'no-control-regex': 'off',
      // 同上的误报源：只留「声明了没用」的警告（_ 前缀豁免）
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // ── 危险模式：几乎总是 bug，见到就修 ──
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-unreachable': 'error',
      'no-cond-assign': ['error', 'except-parens'],
      'no-console': ['warn', { allow: ['warn', 'error'] }], // log 应该走 logger 或删掉
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      'no-self-assign': 'error',
      'no-unmodified-loop-condition': 'error',
    },
  },
  {
    files: ['src/renderer/**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tsParser,
        ecmaVersion: 2023,
        sourceType: 'module',
      },
    },
    plugins: { vue },
    rules: {
      ...(vue.configs['flat/recommended'].rules ?? {}),
      // 模板里 HTML 内建元素/全局（title 属性等）不由 eslint 管，交给 tsc + 浏览器
      'no-undef': 'off',
      'no-useless-assignment': 'off',
      // <component :is="x"> 是我们大量使用的动态组件写法（x 为字符串/组件对象）。
      // eslint-plugin-vue 的 flat/recommended 默认 require-component-is 会误报
      // 尖括号内的泛型/字符串——这与 TSX+动态组件是已知冲突，关掉。
      'vue/require-component-is': 'off',
      // 控制字符过滤正则（[\u0000-\u001f]）是刻意的输入消毒，不是事故
      'no-control-regex': 'off',
      // 未用变量：警告 + _ 前缀豁免（类型签名参数、占位回调常用）
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // 模板里也能写 _ 前缀的未用变量
      'vue/no-unused-vars': ['warn', { ignorePattern: '^_' }],
      // 组件名 PascalCase（Vue 官方 SFC 推荐，与本仓现状一致）
      'vue/component-name-in-template-casing': ['error', 'PascalCase'],
    },
  },
  {
    // 声明文件（.d.ts）只有类型签名：参数名/接口成员就是文档，不查未用、不查 console
    files: ['src/**/*.d.ts'],
    rules: {
      'no-unused-vars': 'off',
      'no-console': 'off',
    },
  },
]