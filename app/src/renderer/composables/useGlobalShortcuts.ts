/**
 * 全局快捷键（composable）。
 *
 * 为什么放 composable 而不是散在各组件：快捷键是「应用级」关注点，
 * 挂在 App.vue onMounted 一次即可；散进组件会出现「同一按键两个处理器」
 * 和「切页后快捷键失灵」两类 bug。
 *
 * 按键表（与 ShortcutHelp.vue 帮助面板一致，改一边必须同步另一边）：
 *   Ctrl+F    聚焦搜索框（库页）
 *   Esc       依次退层：清搜索词 → 关弹层 → 退多选
 *   Ctrl+A    库页全选（进入多选并选中当前筛选结果）
 *   Delete    移除选中的游戏（多选模式）
 *   F5        刷新游戏库
 *   1 / 2 / 3 切页：游戏库 / 下载 / 游戏站
 *   Space     启动当前选中游戏（库页，且焦点不在输入框/按钮上）
 *   ? / F1    快捷键帮助面板
 *
 * 防误触原则（重要）：
 *   1. 焦点在 input/textarea/select/contenteditable 里一律不处理单字符键
 *      （否则打字时按空格会启动游戏、按 1 会切页）——Ctrl 组合键除外。
 *   2. 焦点在 button 上不处理 Space（那是按钮本来的激活键，抢了会「点不动」）。
 *   3. 任何弹层打开时不处理页面级快捷键（Esc 交给弹层自己关）；
 *      帮助面板自身由 ShortcutHelp 的 watch(open) 注册一次并 stopPropagation。
 *   4. 多选模式下 Delete 才生效，避免库页误删单款。
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { batchRemove, enterSelectMode, library, launchGame, refreshGames, selectAll } from '../stores/library'
import { ui } from '../stores/ui'

/** 帮助面板开关（App.vue 绑到 ShortcutHelp；放 composable 里是为了让
 *  本文件的按键处理和面板状态同源，不会出现「按了 ? 但面板打不开」）。 */
export const shortcutHelpOpen = ref(false)

/** 焦点是否在可编辑元素里（单字符快捷键的否决条件）。 */
function inEditable(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return (el as HTMLElement).isContentEditable === true
}

/** 有任意弹层开着吗（Modal/抽屉/自绘对话框统一认 .ant-modal-root 与 data-dialog）。 */
function anyDialogOpen(): boolean {
  return !!document.querySelector('.ant-modal-root, [data-dialog="open"]')
}

/** 库页搜索框聚焦（Ctrl+F）。用 class 选择器而不是 ref：跨组件且 toolbar 常被卸载。 */
function focusSearch(): void {
  const input = document.querySelector<HTMLInputElement>('.search-input')
  if (input) {
    input.focus()
    input.select()
  }
}

export function useGlobalShortcuts(): void {
  function onKey(e: KeyboardEvent): void {
    const editable = inEditable(document.activeElement)
    const onButton = document.activeElement?.tagName === 'BUTTON'

    // ---- Ctrl 组合键：编辑态也放行（Ctrl+F/Ctrl+A 是标准编辑器语义） ----
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      const k = e.key.toLowerCase()
      if (k === 'f') {
        // 库页才聚焦搜索；别的页没有搜索框，别抢浏览器默认（虽然 Electron 里也没菜单）
        if (ui.page === 'library') {
          e.preventDefault()
          focusSearch()
        }
        return
      }
      if (k === 'a') {
        if (ui.page === 'library' && !editable) {
          e.preventDefault()
          if (!library.selectMode) enterSelectMode(true)
          selectAll()
        }
        return
      }
      return
    }

    // ---- 弹层开着：只让 Esc 过关（由弹层自身处理），其余一概不抢 ----
    if (anyDialogOpen()) return

    // ---- Esc：清搜索 → 退多选（两层退栈） ----
    if (e.key === 'Escape') {
      if (editable) return // 输入框里的 Esc 归输入框（比如清空正则切换）
      if (library.keyword) {
        e.preventDefault()
        library.keyword = ''
        return
      }
      if (library.selectMode) {
        e.preventDefault()
        enterSelectMode(false)
      }
      return
    }

    // ---- F1：帮助面板（放在 F5 之前，两个都是功能键但语义不同） ----
    if (e.key === 'F1') {
      e.preventDefault()
      shortcutHelpOpen.value = !shortcutHelpOpen.value
      return
    }

    // ---- F5：刷新（阻止浏览器默认刷新，Electron 里会重载整个应用） ----
    if (e.key === 'F5') {
      e.preventDefault()
      void refreshGames()
      return
    }

    // ---- 以下单字符/功能键：编辑态与按钮态一律不处理 ----
    if (editable) return

    // ---- ?：帮助面板（Shift+/ 才是问号，单按 / 不触发） ----
    if (e.key === '?') {
      e.preventDefault()
      shortcutHelpOpen.value = !shortcutHelpOpen.value
      return
    }

    // ---- Delete：多选模式移除选中 ----
    if (e.key === 'Delete') {
      if (ui.page === 'library' && library.selectMode && library.selection.length) {
        e.preventDefault()
        void batchRemove(library.selection)
      }
      return
    }

    // ---- 1/2/3 切页 ----
    if (e.key === '1' && ui.page !== 'library') {
      e.preventDefault()
      ui.page = 'library'
      return
    }
    if (e.key === '2' && ui.page !== 'downloads') {
      e.preventDefault()
      ui.page = 'downloads'
      return
    }
    if (e.key === '3' && ui.page !== 'games') {
      e.preventDefault()
      ui.page = 'games'
      return
    }

    // ---- Space：启动选中游戏（焦点在按钮上时不抢，那是按钮的激活键） ----
    if (e.key === ' ' && !onButton) {
      if (ui.page === 'library' && library.selectedId) {
        e.preventDefault()
        void launchGame(library.selectedId)
      }
    }
  }

  onMounted(() => {
    // capture: true —— 焦点停在封面卡（div 带 tabindex）上时，单字符键
    // 先经过这里；否则会被卡片自己的 keydown 先消费掉。
    window.addEventListener('keydown', onKey, { capture: true })
  })
  onUnmounted(() => window.removeEventListener('keydown', onKey, { capture: true }))
}
