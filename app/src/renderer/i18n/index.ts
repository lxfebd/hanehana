/**
 * i18n（G18）：中文/英文双语词典 + t()/tf()。
 *
 * 词典在 zh.ts / en.ts（数据层，约 470 键 × 2 语言）；这里只留逻辑：
 * lang 响应式引用、setLanguage 切语言、t() 取词条（缺键回落 zh 再回落键名）、
 * tf() 插值。I18nKey 类型从 zh.ts 的键集推导，en 在编译期被 Record<I18nKey, string>
 * 强制与 zh 键一一对应。
 *
 * 范围：所有用户可见文案（导航/按钮/对话框/提示/海报）已接入；主进程
 * 日志与注释不在此列。
 */
import { ref, type Ref } from 'vue'
import type { UILanguage } from '../../shared/types'
import { zh, type I18nKey } from './zh'
import { en } from './en'

export type { I18nKey }

const dicts: Record<UILanguage, Record<I18nKey, string>> = { zh, en }

/** 当前语言（响应式：切语言时 UI 自动重渲染）。 */
export const lang: Ref<UILanguage> = ref('zh')

export function setLanguage(l: UILanguage): void {
  lang.value = l
}

/** 取翻译。键不存在时回落 zh，再回落到键名（骨架期允许未翻译词条）。 */
export function t(key: I18nKey): string {
  const d: Record<string, string> = dicts[lang.value]
  if (key in d) return d[key]
  if (key in zh) return zh[key as keyof typeof zh]
  return key
}

/**
 * 取翻译并插值：tf('已导出 {fmt} 到：{path}', { fmt, path })。
 * 只替换词条里出现的 {key} 占位符，没出现的参数忽略；模板不含占位符时
 * 直接返回原文，行为等同 t()。
 */
export function tf(key: I18nKey, params?: Record<string, string | number>): string {
  let s = t(key)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      // split/join 替代 replaceAll（tsconfig lib 未到 es2021）
      s = s.split(`{${k}}`).join(String(v))
    }
  }
  return s
}
