import { contextBridge, ipcRenderer } from 'electron'
import { Ipc } from '../shared/ipc'
import type { Game, ScrapeResult } from '../shared/types'
import type {
  ActionResult,
  AddResult,
  SaveSettingsResult,
  Settings,
  TaskProgressPush,
  TaskRow,
} from '../shared/types'

const bridge = {
  hello: (): Promise<{ name: string; version: string }> => ipcRenderer.invoke(Ipc.Hello),

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
}

contextBridge.exposeInMainWorld('hh', bridge)

export type HaneHanaBridge = typeof bridge
