/**
 * 全局 UI 领域 store。
 *
 * 页面切换与设置弹窗开关。多主题（T7）：theme_mode 三态（system/dark/light）、
 * theme_preset 套件（樱夜/星海/薄荷/影院/极光）、theme_accent 自定义主题色，
 * 三者持久化在 settings.json；渲染层只做同步 + 触发 token 重写，真正的主语是
 * 主进程（窗口/原生控件/落盘）。
 */
import { reactive } from 'vue'
import { setTheme } from '../design/tokens'

export const ui = reactive({
  page: 'library' as 'library' | 'downloads' | 'games' | 'stats',
  settingsOpen: false,
  dark: true,
  /** 主题套件 id（settings.theme_preset）。默认星海：
      樱夜的紫夜底 + 樱花粉是典型"AI 紫"配色，用户明确不接受，故换夜蓝+星青。 */
  preset: 'starnight' as 'sakura' | 'starnight' | 'mint' | 'cinema' | 'aurora',
  /** 自定义主题色（settings.theme_accent）：hex 或空串 = 跟随套件强调色 */
  accent: '',
  /** 右侧详情面板收起（只留竖条，点竖条展开） */
  detailCollapsed: false,
  /** Steam 导入对话框 */
  steamImportOpen: false,
  /** 手动添加游戏对话框（T25：选 exe 直接入库） */
  addGameOpen: false,
  /** 全屏模式（G11）：进入全屏封面墙后为 true（由主进程推送校正） */
  fullscreen: false,
})

/** 把主进程 settings.json 里的深浅/套件/主题色应用到渲染层（启动校正 + 保存后同步） */
export function applyDarkFromSettings(
  dark: boolean,
  preset?: 'sakura' | 'starnight' | 'mint' | 'cinema' | 'aurora',
  accent?: string | null,
): void {
  if (ui.dark !== dark) ui.dark = dark
  if (preset && ui.preset !== preset) ui.preset = preset
  if (accent !== undefined) ui.accent = accent ?? ''
  setTheme(dark, preset ?? ui.preset, ui.accent)
}
