/**
 * vue-virtual-scroller@2.0.0-beta.8 未附带 TS 类型声明（package.json 无 types 字段），
 * 这里补一个最小声明，只覆盖本应用用到的 RecycleScroller 属性。
 */
declare module 'vue-virtual-scroller' {
  import type { DefineComponent } from 'vue'

  export const RecycleScroller: DefineComponent<{
    items: unknown[]
    keyField?: string
    direction?: 'vertical' | 'horizontal'
    itemSize?: number
    gridItems?: number
    itemSecondarySize?: number
    pageMode?: boolean
    buffer?: number
    listClass?: string
    itemClass?: string
    minItemSize?: number | string
  }>
}
