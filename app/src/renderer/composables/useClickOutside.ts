/**
 * 「点浮层外面收起」（composable）。
 *
 * 为什么不再用 document.querySelector('.xxx-wrap')：类名一旦成了隐式全局 API，
 * 改名 / 加 Teleport / 结构重排都会让 querySelector 返回 null，而失败是静默的
 * ——「点外面不收」不报错、不抛异常，只是从此再也不回来。这里改成由**持有
 * DOM 的组件**把元素 ref 传进来：选择器只负责样式，不再承担组件间通信。
 *
 * 用法（模板里 <div ref="wrapRef">）：
 *   const wrapRef = ref<HTMLElement | null>(null)
 *   useClickOutside(wrapRef, () => (open.value = false))
 *
 * 已有用例：导出菜单（LibraryToolbar）、侧栏「更多」菜单（NavSidebar）、
 * 封面右键菜单（GameContextMenu）。
 */
import { onBeforeUnmount, onMounted, type Ref } from 'vue'

export interface ClickOutsideOptions {
  /**
   * 捕获阶段监听。默认 false（冒泡）——与导出菜单/「更多」菜单原来的时序一致。
   * 右键菜单传 true：点菜单项时先由本监听判断「在菜单内」，再让菜单项自己的
   * 关闭逻辑跑（原来就是 capture，保持原时序，不引入新的先后关系）。
   */
  capture?: boolean
}

export function useClickOutside(
  el: Ref<HTMLElement | null | undefined>,
  onOutside: (e: MouseEvent) => void,
  options: ClickOutsideOptions = {},
): void {
  const capture = options.capture ?? false

  function onDocClick(e: MouseEvent): void {
    const root = el.value
    // 元素还没挂载或已卸载（v-if 关着）：没有可判断的容器，不等于「点了外面」。
    // 不能在这里触发收起，否则浮层会被打开它的那次点击顺手关掉。
    if (!root) return
    if (root.contains(e.target as Node)) return
    onOutside(e)
  }

  onMounted(() => document.addEventListener('click', onDocClick, capture))
  onBeforeUnmount(() => document.removeEventListener('click', onDocClick, capture))
}
