/**
 * IPC 通道名唯一真值。
 *
 * 主进程 ipcMain.handle(Ipc.Xxx) 与 preload contextBridge.exposeInMainWorld
 * 都用这里的字符串。两处各写一遍字符串是历史教训：改一边忘另一边，
 * 通道静默失效（handle 挂了而 preload 还在调旧名），界面表现为「点了没反应」。
 */
export type { Mirror, ResolveOutcome, SiteInfo, SiteMirrorOutcome, SiteSearchOutcome } from './sites'

export const Ipc = {
  Hello: 'hanehana:hello',
  // 游戏库
  GameList: 'hanehana:games:list',
  GameScan: 'hanehana:games:scan',
  GameUpdate: 'hanehana:games:update',
  GameRemove: 'hanehana:games:remove',
  GameBatchUpdate: 'hanehana:games:batch-update',
  GameBatchRemove: 'hanehana:games:batch-remove',
  SteamScan: 'hanehana:games:steam-scan',
  SteamImport: 'hanehana:games:steam-import',
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
  // 原生 exe 文件选择对话框（G2：LE/Magpie 路径选择）
  PickExe: 'hanehana:pickExe',
  // 游戏库导出（G14）：弹保存对话框写 CSV/JSON
  ExportGames: 'hanehana:games:export',
  // 新作追踪（G16）：订阅 VNDB 关键词，检查新作 + 系统通知
  TrackList: 'hanehana:track:list',
  TrackAdd: 'hanehana:track:add',
  TrackRemove: 'hanehana:track:remove',
  TrackCheck: 'hanehana:track:check',
  // 统计报表
  StatsOverview: 'hanehana:stats:overview',
  /** 统计海报导出（PNG）：渲染层把统计页渲染成图片，主进程弹保存框写盘 */
  StatsPosterExport: 'hanehana:stats:poster-export',
  // 存档备份（G1）
  BackupsList: 'hanehana:backups:list',
  BackupCreate: 'hanehana:backups:create',
  BackupRestore: 'hanehana:backups:restore',
  BackupDelete: 'hanehana:backups:delete',
  BackupSync: 'hanehana:backups:sync',
  // 全屏模式（G11）
  FullscreenSet: 'hanehana:window:fullscreen-set',
  FullscreenToggle: 'hanehana:window:fullscreen-toggle',

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
  /** 自定义背景图选择（原生文件对话框，限图片） */
  PickBgImage: 'hanehana:pick-bg-image',
  // 自动更新
  UpdateCheck: 'hanehana:update:check',
  UpdateInstall: 'hanehana:update:install',
  // 游戏站（内嵌浏览器 + 搜索聚合 + 下载捕获）
  SitesList: 'hanehana:sites:list',
  SitesSearch: 'hanehana:sites:search',
  SitesMirrors: 'hanehana:sites:mirrors',
  SitesResolve: 'hanehana:sites:resolve',
  SitesAddTask: 'hanehana:sites:add-task',
  WebviewOpenExternal: 'hanehana:webview:open-external',
  // 主进程 → 渲染进程（推送）
  FullscreenChanged: 'hanehana:push:fullscreen-changed',
  TaskProgress: 'hanehana:push:task-progress',
  TaskFocus: 'hanehana:push:task-focus',
  UpdateStatus: 'hanehana:push:update-status',
  SiteDownload: 'hanehana:push:site-download',
  /** 系统深浅切换（仅 theme_mode='system' 时推送） */
  ThemeChanged: 'hanehana:push:theme-changed',
} as const

export type IpcChannel = (typeof Ipc)[keyof typeof Ipc]

/**
 * 游戏站下载的统一推送。三种结局要分开播报，因为它们的用户动作完全不同：
 *   captured —— 公开直链，已交给下载引擎（渲染层建任务、列表里能看进度）
 *   browser  —— 需要浏览器会话，Chromium 正在用当前 Cookie 下载（引擎帮不上忙）
 *   done     —— 上面第二条的收尾，告诉用户文件落在哪、成没成
 */
export type SiteDownloadPush =
  | { kind: 'captured'; url: string; filename?: string; siteId?: string }
  | { kind: 'browser'; filename: string; dest: string }
  | { kind: 'done'; filename: string; dest: string; ok: boolean; error?: string }