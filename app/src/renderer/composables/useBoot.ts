/**
 * 应用启动编排（useBoot composable）。
 *
 * App.vue 的 onMounted 曾经塞着五件事：hello 握手、刷新游戏库、订阅下载推送、
 * 订阅主题/全屏推送、窄窗口折叠监听——全部挤在组件生命周期里，既没法单测，
 * 也让根组件 script 越来越长。这里收成唯一入口：App.vue 只调用一次 useBoot()，
 * 拿到 bootInfo（标题栏版本号/失败原因）与全屏控制函数，剩下的生命周期
 * （订阅退订、窄窗口清理）都在 composable 内部自管理。
 *
 * 为什么放 composable 而不是 store：这是「启动那一刻做什么」的编排逻辑，
 * 不是可复用的响应式状态——store 不该背着一次性的启动流程。
 */
import { onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import { message } from 'ant-design-vue'
import { library, refreshGames, startRunningSync, stopRunningSync } from '../stores/library'
import { downloads, initTasks, report, reportRejection } from '../stores/downloads'
import { ui, applyDarkFromSettings } from '../stores/ui'
import { setLanguage, t, tf } from '../i18n'

/** 全屏模式（G11）：进入用主进程切真全屏，Esc/系统手势退出同步回渲染层 */
async function enterFullscreen(): Promise<void> {
  ui.page = 'library'
  ui.detailCollapsed = true
  const on = await window.hh.fullscreenSet(true).catch(() => false)
  // 主进程 win.isFullScreen() 立即生效；推送兜底（某些平台 enter 延迟）
  ui.fullscreen = on || true
}

async function exitFullscreen(): Promise<void> {
  await window.hh.fullscreenSet(false).catch(() => {})
  ui.fullscreen = false
}

/**
 * 启动编排。返回：
 *  - bootInfo：标题栏的版本号；失败时是「启动失败」原因
 *  - enterFullscreen / exitFullscreen：全屏切换（NavSidebar 的 @enter-fullscreen 用）
 *  - saveSettings：设置保存（SettingsDialog 的 @save 用）——它依赖 message/i18n，
 *    与组件模板解耦后这里持有，组件不再背这份逻辑
 */
export function useBoot(): {
  bootInfo: Ref<string>
  enterFullscreen: () => Promise<void>
  exitFullscreen: () => Promise<void>
  saveSettings: (_s: unknown) => Promise<void>
  /** 游戏站视图是否已挂载过一次（保活开关，见下方 watch 注释） */
  gamesMounted: Ref<boolean>
} {
  const bootInfo = ref('')
  /** 推送订阅句柄：onUnmounted 统一退订（页面销毁不泄漏 listener） */
  let unsubPushes: Array<() => void> = []

  // 窄窗口（<1100px）时详情面板宽度会把内容区挤没，自动收起
  let narrowMq: MediaQueryList | null = null
  let narrowMqFn: ((_e: MediaQueryListEvent) => void) | null = null

  async function saveSettings(s: unknown): Promise<void> {
    try {
      const r = await window.hh.saveSettings(s as never)
      if (!r.ok) {
        report(r as never)
        return
      }
      downloads.settings = r.settings
      // 填了但没生效的路径：主进程按「不存在」丢弃回落到旧值，这里点名让用户知道
      if (r.discarded?.length) {
        const names: Record<string, string> = {
          backup_dir: t('app_path_backup_dir'),
          le_path: t('app_path_le'),
          magpie_path: t('app_path_magpie'),
        }
        message.warning(
          tf('app_path_discarded', { names: r.discarded.map((k) => names[k] ?? k).join(t('common_join_sep')) }),
        )
      }
      // 深浅/套件主题设置落盘后的渲染层同步（system 模式主进程已按系统校正 dark）
      applyDarkFromSettings(r.settings.dark, r.settings.theme_preset)
      // 界面语言保存后立即生效，不用重启（词典是响应式 ref，setLanguage 即触发重渲染）
      setLanguage(r.settings.language)
      ui.settingsOpen = false
    } catch (e) {
      reportRejection(e)
    }
  }

  onMounted(async () => {
    // 运行中状态轮询：游戏退出后 runningIds 收敛（主进程 handleRunning 清僵尸）
    startRunningSync()
    try {
      if (!window.hh?.hello) {
        bootInfo.value = t('app_boot_preview')
        return
      }
      const info = await window.hh.hello()
      bootInfo.value = `v${info.version}`
      await refreshGames()
      unsubPushes = await initTasks()
      library.error = ''
      // G18 i18n：从设置应用界面语言（骨架：zh/en）
      const s = await window.hh.getSettings()
      if (s?.language === 'en' || s?.language === 'zh') setLanguage(s.language)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e ?? '')
      bootInfo.value = tf('app_boot_fail', { msg: msg.trim() || t('app_boot_noresp') })
    }

    // 跟随系统：主进程在系统深浅切换时推送，渲染层实时换肤
    if (window.hh?.onThemeChanged) {
      unsubPushes.push(
        window.hh.onThemeChanged(({ dark }) => {
          applyDarkFromSettings(dark, ui.preset)
        }),
      )
    }

    // 全屏状态同步：主进程 enter/leave 时校正渲染层状态
    if (window.hh?.onFullscreenChanged) {
      unsubPushes.push(
        window.hh.onFullscreenChanged((on) => {
          ui.fullscreen = on
          if (on) ui.detailCollapsed = true
        }),
      )
    }

    // 窄窗口自动收起详情面板：360px 详情 + 208px 侧栏会把内容区挤没
    if ('matchMedia' in window) {
      narrowMq = window.matchMedia('(max-width: 1100px)')
      narrowMqFn = (e: MediaQueryListEvent) => {
        if (e.matches) ui.detailCollapsed = true
      }
      if (narrowMq.matches) ui.detailCollapsed = true
      narrowMq.addEventListener('change', narrowMqFn)
    }
  })

  onUnmounted(() => {
    stopRunningSync()
    narrowMq?.removeEventListener('change', narrowMqFn as EventListener)
    narrowMq = null
    narrowMqFn = null
    for (const unsub of unsubPushes) unsub()
  })

  // 游戏站视图挂载过一次就留着（webview 的 src 一挂载就去加载站点首页，
  // v-show 只藏不销毁：切走再切回来，搜索结果、已打开的页面和登录会话都得在）。
  // 模板里 v-if 首次进入才挂载，之后 v-show 保活。
  // watch immediate 是不把正确性押在「切到 games 一定发生在 App 挂载之后」这条时序上。
  const gamesMounted = ref(false)
  watch(
    () => ui.page,
    (p) => {
      if (p === 'games') gamesMounted.value = true
    },
    { immediate: true },
  )

  return { bootInfo, enterFullscreen, exitFullscreen, saveSettings, gamesMounted }
}
