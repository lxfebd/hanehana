import { contextBridge, ipcRenderer } from 'electron'
import { Ipc } from '../shared/ipc'
import type { Game, ScrapeResult } from '../shared/types'
import type {
  ActionResult,
  AddResult,
  HelloInfo,
  SaveSettingsResult,
  Settings,
  TaskProgressPush,
  TaskRow,
  UpdateStatus,
} from '../shared/types'
import type { Mirror, ResolveOutcome, SiteDownloadPush, SiteInfo, SiteMirrorOutcome, SiteSearchOutcome } from '../shared/ipc'

const bridge = {
  /** 应用信息 + 引擎自检结论（设置页据此说明下载为什么不可用）。 */
  hello: (): Promise<HelloInfo> => ipcRenderer.invoke(Ipc.Hello),

  // 游戏库
  listGames: (): Promise<Game[]> => ipcRenderer.invoke(Ipc.GameList),
  scanDir: (root: string) => ipcRenderer.invoke(Ipc.GameScan, root),
  updateGame: (id: string, patch: Partial<Game>) => ipcRenderer.invoke(Ipc.GameUpdate, id, patch),
  removeGame: (id: string) => ipcRenderer.invoke(Ipc.GameRemove, id),

  // 元数据刮削
  scrapeSearch: (title: string) => ipcRenderer.invoke(Ipc.ScrapeSearch, title),
  scrapeApply: (gameId: string, result: ScrapeResult) => ipcRenderer.invoke(Ipc.ScrapeApply, gameId, result),

  // 启动与目录
  launchGame: (id: string) => ipcRenderer.invoke(Ipc.GameLaunch, id),
  runningGames: (): Promise<string[]> => ipcRenderer.invoke(Ipc.GameRunning),
  openDir: (dir: string) => ipcRenderer.invoke(Ipc.OpenDir, dir),
  pickDir: (): Promise<string> => ipcRenderer.invoke(Ipc.PickDir),

  // ---- 下载引擎 ----
  listTasks: (): Promise<TaskRow[]> => ipcRenderer.invoke(Ipc.TasksList),
  addTask: (input: { url: string; dest: string; threads: number; note?: string; checksum?: string }): Promise<AddResult> =>
    ipcRenderer.invoke(Ipc.TasksAdd, input),
  removeTask: (id: string, deleteFiles?: boolean): Promise<ActionResult> =>
    ipcRenderer.invoke(Ipc.TasksRemove, id, deleteFiles),
  clearFinished: (): Promise<ActionResult> => ipcRenderer.invoke(Ipc.TasksClearFinished),
  action: (id: string, action: 'start' | 'pause' | 'resume' | 'retry'): Promise<ActionResult> =>
    ipcRenderer.invoke(Ipc.TaskAction, id, action),
  setThreads: (id: string, n: number): Promise<ActionResult> => ipcRenderer.invoke(Ipc.TaskSetThreads, id, n),
  setChecksum: (id: string, checksum: string): Promise<ActionResult> =>
    ipcRenderer.invoke(Ipc.TaskSetChecksum, id, checksum),
  actionAll: (action: 'start' | 'pause' | 'clear-finished' | 'retry-failed'): Promise<ActionResult> =>
    ipcRenderer.invoke(Ipc.ActionAll, action),
  getSettings: (): Promise<Settings> => ipcRenderer.invoke(Ipc.SettingsGet),
  saveSettings: (s: Settings): Promise<SaveSettingsResult> => ipcRenderer.invoke(Ipc.SettingsSave, s),
  pickBgImage: (): Promise<string> => ipcRenderer.invoke(Ipc.PickBgImage),
  onThemeChanged: (cb: (e: { dark: boolean }) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, p: { dark: boolean }): void => cb(p)
    ipcRenderer.on(Ipc.ThemeChanged, listener)
    return () => ipcRenderer.removeListener(Ipc.ThemeChanged, listener)
  },
  // 自动更新
  checkUpdate: (): Promise<ActionResult> => ipcRenderer.invoke(Ipc.UpdateCheck),
  installUpdate: (): Promise<ActionResult> => ipcRenderer.invoke(Ipc.UpdateInstall),
  onUpdateStatus: (cb: (s: UpdateStatus) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, s: UpdateStatus): void => cb(s)
    ipcRenderer.on(Ipc.UpdateStatus, listener)
    return () => ipcRenderer.removeListener(Ipc.UpdateStatus, listener)
  },
  onTaskProgress: (cb: (p: TaskProgressPush) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, p: TaskProgressPush): void => cb(p)
    ipcRenderer.on(Ipc.TaskProgress, listener)
    return () => ipcRenderer.removeListener(Ipc.TaskProgress, listener)
  },
  onTaskFocus: (cb: (id: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, id: string): void => cb(id)
    ipcRenderer.on(Ipc.TaskFocus, listener)
    return () => ipcRenderer.removeListener(Ipc.TaskFocus, listener)
  },

  // ---- 游戏站 ----
  sitesList: (): Promise<SiteInfo[]> => ipcRenderer.invoke(Ipc.SitesList),
  sitesSearch: (siteId: string, keyword: string): Promise<SiteSearchOutcome> =>
    ipcRenderer.invoke(Ipc.SitesSearch, siteId, keyword),
  sitesMirrors: (siteId: string, detailUrl: string): Promise<SiteMirrorOutcome> =>
    ipcRenderer.invoke(Ipc.SitesMirrors, siteId, detailUrl),
  sitesResolve: (mirror: Mirror): Promise<ResolveOutcome> => ipcRenderer.invoke(Ipc.SitesResolve, mirror),
  sitesAddTask: (input: { url: string; filename?: string }): Promise<AddResult> =>
    ipcRenderer.invoke(Ipc.SitesAddTask, input),
  webviewOpenExternal: (url: string): Promise<void> => ipcRenderer.invoke(Ipc.WebviewOpenExternal, url),
  onSiteDownload: (cb: (p: SiteDownloadPush) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, p: SiteDownloadPush): void => cb(p)
    ipcRenderer.on(Ipc.SiteDownload, listener)
    return () => ipcRenderer.removeListener(Ipc.SiteDownload, listener)
  },
}

contextBridge.exposeInMainWorld('hh', bridge)

export type HaneHanaBridge = typeof bridge
