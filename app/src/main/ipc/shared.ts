/**
 * IPC 域注册共享：校验助手 + 各 register* 的上下文类型。
 * 渲染层输入一律当不可信；通道名在 shared/ipc 的 Ipc 枚举里，本目录一字不改。
 */
import type { BrowserWindow, dialog, SaveDialogOptions, OpenDialogOptions } from 'electron'
import type { TrackCheckResult } from '../../shared/types'
import type { Manager } from '../manager'
import type { Store } from '../store'

export type { OpenDialogOptions, SaveDialogOptions }

/** 下载地址形状：http(s) / ftp。 */
export const DOWNLOAD_URL_RE = /^(https?|ftp):\/\//i
/** 任务动作白名单：与 preload action() 及 Manager.action 分支一致。 */
export const TASK_ACTIONS = new Set(['start', 'pause', 'resume', 'retry'])
export const ALL_ACTIONS = new Set(['start', 'pause', 'clear-finished', 'retry-failed'])

export function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 64
}

export function err(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

/** wireIpc 注入的运行时依赖（纯函数域无状态时不读）。 */
export interface IpcCtx {
  win: () => BrowserWindow | null
  manager: () => Manager
  store: () => Store
  /** 本会话用户在原生对话框里手选过的授权目录（小写绝对路径） */
  approvedDirs: () => Set<string>
  /** SettingsSave 成功后同步窗口主题 */
  applyThemeMode: (mode: 'system' | 'dark' | 'light') => boolean
  applyThemeToWindow: (dark: boolean) => void
  syncKeepAwake: () => void
  notifyTrackFresh: (r: TrackCheckResult) => void
}
