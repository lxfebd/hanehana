/**
 * 全局 UI 领域 store（REDESIGN-SPEC §3.2）。
 *
 * 页面切换与设置弹窗开关。深浅双主题（Minimalist G 深 / H 浅），
 * dark 字段持久化在 settings.json，渲染层只做同步 + 触发 token 重写。
 */
import { reactive } from 'vue'
import { setTheme } from '../design/tokens'

export const ui = reactive({
  page: 'library' as 'library' | 'downloads' | 'games',
  settingsOpen: false,
  dark: true,
  /** 右侧详情面板收起（只留竖条，点竖条展开） */
  detailCollapsed: false,
})

/** 把主进程 settings.json 里的 dark 应用到渲染层（启动校正 + 保存后同步） */
export function applyDarkFromSettings(dark: boolean): void {
  if (ui.dark !== dark) ui.dark = dark
  setTheme(dark)
}