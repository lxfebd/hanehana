/**
 * IPC 通道名唯一真值。
 *
 * 主进程 ipcMain.handle(Ipc.Xxx) 与 preload contextBridge.exposeInMainWorld
 * 都用这里的字符串。两处各写一遍字符串是历史教训：改一边忘另一边，
 * 通道静默失效（handle 挂了而 preload 还在调旧名），界面表现为「点了没反应」。
 */
export const Ipc = {
  Hello: 'hanehana:hello',
  // 游戏库
  GameList: 'hanehana:games:list',
  GameScan: 'hanehana:games:scan',
  GameUpdate: 'hanehana:games:update',
  GameRemove: 'hanehana:games:remove',
  // 元数据刮削
  ScrapeSearch: 'hanehana:scrape:search',
  ScrapeApply: 'hanehana:scrape:apply',
  // 启动
  GameLaunch: 'hanehana:games:launch',
  GameRunning: 'hanehana:games:running',
  // 打开目录
  OpenDir: 'hanehana:games:openDir',
  // 原生目录选择对话框
  PickDir: 'hanehana:pickDir',

  // ---- 下载引擎（Rust fastdrop-engine 迁移）----
  TasksList: 'hanehana:tasks:list',
  TasksAdd: 'hanehana:tasks:add',
  TasksRemove: 'hanehana:tasks:remove',
  TasksClearFinished: 'hanehana:tasks:clear-finished',
  TaskAction: 'hanehana:task:action',
  TaskSetThreads: 'hanehana:task:set-threads',
  TaskSetChecksum: 'hanehana:task:set-checksum',
  ActionAll: 'hanehana:action:all',
  SettingsGet: 'hanehana:settings:get',
  SettingsSave: 'hanehana:settings:save',
  // 主进程 → 渲染进程（推送）
  TaskProgress: 'hanehana:push:task-progress',
  TaskFocus: 'hanehana:push:task-focus',
} as const

export type IpcChannel = (typeof Ipc)[keyof typeof Ipc]