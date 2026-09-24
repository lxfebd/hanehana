/**
 * 全局 UI 领域 store（REDESIGN-SPEC §3.2）。
 *
 * 页面切换与设置弹窗开关。多主题（T7）：theme_mode 三态（system/dark/light）
 * 与 theme_preset 套件（樱夜/星海/薄荷）持久化在 settings.json；
 * 渲染层只做同步 + 触发 token 重写，真正的主语是主进程（窗口/原生控件/落盘）。
 */
import { reactive } from 'vue'
import { setTheme } from '../design/tokens'

export const ui = reactive({
  page: 'library' as 'library' | 'downloads' | 'games',
  settingsOpen: false,
  dark: true,
  /** 主题套件 id（settings.theme_preset） */
  preset: 'sakura' as 'sakura' | 'starnight' | 'mint',
  /** 右侧详情面板收起（只留竖条，点竖条展开） */
  detailCollapsed: false,
})

/** 把主进程 settings.json 里的深浅/套件应用到渲染层（启动校正 + 保存后同步） */
export function applyDarkFromSettings(dark: boolean, preset?: 'sakura' | 'starnight' | 'mint'): void {
  if (ui.dark !== dark) ui.dark = dark
  if (preset && ui.preset !== preset) ui.preset = preset
  setTheme(dark, preset ?? ui.preset)
}
