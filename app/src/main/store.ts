/**
 * 下载任务与设置的读写。
 *
 * 序列化格式刻意固定（indent=2、不转义中文、原子替换），
 * 数据目录为 ~/.hanehana（HANEHANA_DATA_DIR 可覆盖）。
 */
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { app } from 'electron'
import { createJsonStore } from './jsonStore'
import {
  DEFAULT_SETTINGS,
  THEME_MODES,
  THEME_PRESETS,
  type ErrorParams,
  type PlaySession,
  type Settings,
  type TaskDef,
  type TaskState,
  type ThemeMode,
  type ThemePresetId,
} from '../shared/types'
const TASK_STATES: readonly string[] = [
  'queued',
  'idle',
  'preparing',
  'downloading',
  'paused',
  'done',
  'error',
  'cancelled',
]

/** 只认已知的状态字符串，别的（含人手改出来的值）一律当"从未跑过"。 */
function isTaskState(v: unknown): v is TaskState {
  return typeof v === 'string' && TASK_STATES.includes(v)
}

/**
 * 落盘的错误参数是不可信输入（tasks.json 可能被手改或写坏）：只留原始值的键，
 * 数组和嵌套对象一律丢掉。界面会把这些值拼进给用户看的文案，形状必须先钉死，
 * 否则一个 `[object Object]` 甚至一段脚本就进了通知正文。
 */
function normalizeErrorParams(v: unknown): ErrorParams {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') out[k] = val
  }
  return out
}

/**
 * 便携模式（G15）：数据目录优先落在「可执行文件旁的 data\」。
 *
 * 判定规则：exe 同目录存在便携标记文件（PORTABLE 或 .portable）才算便携——
 * 只有用户/打包脚本显式放了标记才启用，避免把常规安装目录误判成便携根。
 * HANEHANA_DATA_DIR 永远优先（测试隔离通道），之后才是便携目录，最后才是 ~/.hanehana。
 */
function portableDataDir(): string | null {
  try {
    // 测试缝（同 HANEHANA_NO_OS_FULLSCREEN 风格）：验收脚本用它模拟「exe 在便携根」，
    // 而不用真的往 node_modules/electron 里塞标记文件。生产环境从不设置。
    const exeDir = process.env.HANEHANA_PORTABLE_EXEDIR
      ? process.env.HANEHANA_PORTABLE_EXEDIR
      : dirname(app.getPath('exe'))
    if (existsSync(join(exeDir, 'PORTABLE')) || existsSync(join(exeDir, '.portable'))) {
      return join(exeDir, 'data')
    }
  } catch {
    // app.getPath 失败（罕见环境）就退回普通模式
  }
  return null
}

/** 是否处于便携模式：exe 旁存在 PORTABLE/.portable 标记。 */
export function isPortable(): boolean {
  return portableDataDir() !== null
}

/** 设置与任务记录所在目录。界面起不来时，兜底页要能把这个目录交到用户手里。 */
export function dataDir(): string {
  // 测试缝（仅验收脚本设置 HANEHANA_PORTABLE_EXEDIR）：模拟 exe 位于便携根时，
  // 便携分支优先于 HANEHANA_DATA_DIR，否则便携分支永远测不到（真实环境 HANEHANA_DATA_DIR 不存在）。
  if (process.env.HANEHANA_PORTABLE_EXEDIR) {
    const p = portableDataDir()
    if (p) return p
  }
  if (process.env.HANEHANA_DATA_DIR) return process.env.HANEHANA_DATA_DIR
  return portableDataDir() ?? join(homedir(), '.hanehana')
}

function taskFile(): string {
  return join(dataDir(), 'tasks.json')
}

function settingsFile(): string {
  return join(dataDir(), 'settings.json')
}

function playSessionsFile(): string {
  return join(dataDir(), 'play-sessions.json')
}

/**
 * 默认保存目录：优先 ~/Downloads，不存在时退回数据目录。
 * 这个默认值要稳定——改它会让老任务迁移过来后保存路径漂移。
 */
export function defaultDownloadDir(): string {
  const d = join(homedir(), 'Downloads')
  return existsSync(d) ? d : dataDir()
}

/**
 * 逐字段校验设置。渲染层传回来的对象不可信（可能是半截 JSON、被改坏的字段，
 * 或者干脆是别的进程塞进来的东西），非法值一律回落到默认值而不是写进盘里。
 * 读盘和保存走同一个函数，保证「存进去的」和「读出来的」形状一致。
 */
export function normalizeSettings(raw: unknown): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS }
  if (raw && typeof raw === 'object') {
    const d = raw as Partial<Settings>
    // 分片数上限 32 与设置页 InputNumber、IPC 入参校验同源：每一片是一条连接，
    // 放更大的值只会把目标站点打成拒绝服务，自己也不会更快。
    if (typeof d.threads === 'number') s.threads = clampInt(d.threads, 1, 32)
    // download_dir：只收空串或「存在且是目录」的值。指向一个已存在的**文件**
    // 是手改坏值（所有下载都会落在错误路径上），回落默认目录；
    // 不存在的目录合法（首次下载时 engine/uniquePath 会建），不能像 backup_dir
    // 那样只收存在的——用户可能先填一个还没建的目录。
    if (typeof d.download_dir === 'string' && d.download_dir) {
      if (existsSync(d.download_dir)) {
        if (statSync(d.download_dir).isDirectory()) s.download_dir = d.download_dir
      } else {
        s.download_dir = d.download_dir
      }
    }
    if (typeof d.proxy === 'string') s.proxy = d.proxy
    if (typeof d.user_agent === 'string') s.user_agent = d.user_agent
    if (typeof d.max_concurrent === 'number') s.max_concurrent = clampInt(d.max_concurrent, 1, 16)
    if (typeof d.confirm_delete === 'boolean') s.confirm_delete = d.confirm_delete
    if (typeof d.dark === 'boolean') s.dark = d.dark
    if (typeof d.theme_mode === 'string' && THEME_MODES.includes(d.theme_mode as ThemeMode)) {
      s.theme_mode = d.theme_mode as ThemeMode
    }
    if (typeof d.theme_preset === 'string' && THEME_PRESETS.includes(d.theme_preset as ThemePresetId)) {
      s.theme_preset = d.theme_preset as ThemePresetId
    }
    // 自定义背景图：只收存在的路径，防手改坏值
    if (typeof d.bg_image === 'string' && d.bg_image && existsSync(d.bg_image)) s.bg_image = d.bg_image
    if (typeof d.notify_on_finish === 'boolean') s.notify_on_finish = d.notify_on_finish
    if (typeof d.notify_on_error === 'boolean') s.notify_on_error = d.notify_on_error
    if (typeof d.close_to_tray === 'boolean') s.close_to_tray = d.close_to_tray
    if (typeof d.keep_awake === 'boolean') s.keep_awake = d.keep_awake
    // 限速按 KiB/s 存。上限 100 GiB/s：这个值只会写进引擎的令牌桶，写大了等于
    // 不限速，但把负数/NaN 放过去会让引擎拿到一个说不清的数，所以照样 clamp。
    if (typeof d.rate_limit_kbps === 'number') {
      s.rate_limit_kbps = clampInt(d.rate_limit_kbps, 0, 104_857_600)
    }
    if (typeof d.auto_update_check === 'boolean') s.auto_update_check = d.auto_update_check
    // 存档备份（G1）。backup_dir 只收存在的目录（空 = 数据目录下的 backups/）；
    // webdav 凭据读盘后保留原样，校验只在保存时由主进程做（见 Ipc.SettingsSave）。
    if (typeof d.backup_dir === 'string' && d.backup_dir && existsSync(d.backup_dir)) s.backup_dir = d.backup_dir
    if (typeof d.backup_on_exit === 'boolean') s.backup_on_exit = d.backup_on_exit
    if (typeof d.backup_keep === 'number') s.backup_keep = clampInt(d.backup_keep, 1, 100)
    if (typeof d.webdav_url === 'string') s.webdav_url = d.webdav_url
    if (typeof d.webdav_user === 'string') s.webdav_user = d.webdav_user
    if (typeof d.webdav_pass === 'string') s.webdav_pass = d.webdav_pass
    // 工具路径（G2）：只收存在的文件或空串；不存在则丢弃（用户手改坏值不落盘）
    if (typeof d.le_path === 'string' && d.le_path && existsSync(d.le_path)) s.le_path = d.le_path
    if (typeof d.magpie_path === 'string' && d.magpie_path && existsSync(d.magpie_path)) s.magpie_path = d.magpie_path
    // 界面语言（G18）：只认 zh/en，别的（含手改）回落中文
    if (d.language === 'zh' || d.language === 'en') s.language = d.language
  }
  // 空目录补默认值，避免 dest 落成空串
  if (!s.download_dir) s.download_dir = defaultDownloadDir()
  return s
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, Math.floor(v)))
}

export class Store {
  // 三个持久化域各自一个 jsonStore：原子写 + 400ms 尾触发合并 + flush。
  // 统一实现（jsonStore.ts），这里只声明文件与校验策略。
  private tasksStore = createJsonStore<TaskDef[]>(taskFile())
  private settingsStore = createJsonStore<Settings>(settingsFile())
  private sessionsStore = createJsonStore<PlaySession[]>(playSessionsFile())

  constructor() {
    mkdirSync(dataDir(), { recursive: true })
  }

  loadTasks(): TaskDef[] {
    const data = this.tasksStore.load()
    if (!Array.isArray(data)) return []
    const out: TaskDef[] = []
    for (const item of data) {
      const d = item as Partial<TaskDef>
      // 只收结构完整的任务定义，跳过坏条目而不是让整个列表加载失败
      if (d && typeof d.url === 'string' && d.url) {
        out.push({
          id: typeof d.id === 'string' && d.id ? d.id : newId(),
          url: d.url,
          dest: typeof d.dest === 'string' ? d.dest : '',
          threads: typeof d.threads === 'number' ? d.threads : 8,
          proxy: typeof d.proxy === 'string' ? d.proxy : '',
          added_at: typeof d.added_at === 'number' ? d.added_at : Date.now() / 1000,
          note: typeof d.note === 'string' ? d.note : '',
          // 老版本 tasks.json 没有状态字段：按"从未跑过"处理，让调度器像以前
          // 一样首次拉起它，而不是凭空认为它已经完成。
          state: isTaskState(d.state) ? d.state : '',
          total: typeof d.total === 'number' ? d.total : 0,
          downloaded: typeof d.downloaded === 'number' ? d.downloaded : 0,
          error: typeof d.error === 'string' ? d.error : '',
          // 老记录没有码：留空串，界面退回原文匹配。有原文没码是合法状态，
          // 反过来（有码没原文）不合法——那条原文才是排查凭据。
          error_code: typeof d.error_code === 'string' ? d.error_code : '',
          error_params: normalizeErrorParams(d.error_params),
          finished_at: typeof d.finished_at === 'number' ? d.finished_at : 0,
          // 老 tasks.json 没这个字段：空串 = 不校验。不能拿 undefined 去喂引擎，
          // 也不能顺手填个别的任务的哈希值——那会把一次正常下载判成校验失败。
          checksum: typeof d.checksum === 'string' ? d.checksum : '',
        })
      }
    }
    return out
  }

  /** 合并写：进度回调 100ms 一次也不落盘风暴；退出前 flush() 兜底。 */
  saveTasks(tasks: TaskDef[]): void {
    this.tasksStore.save(tasks)
  }

  loadSettings(): Settings {
    return normalizeSettings(this.settingsStore.load())
  }

  saveSettings(s: Settings): void {
    this.settingsStore.save(normalizeSettings(s))
  }

  // ---------------------------------------------------------------- 游玩会话
  // 统计报表的数据源。只追加不删改：每场会话一条，重放即可聚合。
  loadPlaySessions(): PlaySession[] {
    const data = this.sessionsStore.load()
    if (!Array.isArray(data)) return []
    const out: PlaySession[] = []
    for (const item of data) {
      const d = item as Partial<PlaySession>
      if (
        d &&
        typeof d.gameId === 'string' &&
        d.gameId &&
        typeof d.start === 'number' &&
        Number.isFinite(d.start) &&
        typeof d.end === 'number' &&
        Number.isFinite(d.end) &&
        typeof d.ms === 'number' &&
        Number.isFinite(d.ms)
      ) {
        out.push({
          gameId: d.gameId,
          title: typeof d.title === 'string' ? d.title : '',
          start: d.start,
          end: d.end,
          ms: d.ms,
        })
      }
    }
    return out
  }

  appendPlaySessions(sessions: PlaySession[]): void {
    if (!sessions.length) return
    const all = [...this.loadPlaySessions(), ...sessions]
    // 只保留最近 2 年：统计页只需日/周/月粒度，无上限增长没有意义
    const cutoff = Date.now() - 730 * 86400000
    this.sessionsStore.save(all.filter((s) => s.end >= cutoff))
  }

  /** 把三个域待写的内容立即落盘（进程退出前调用），不丢合并窗口里的最后一批。 */
  flush(): void {
    this.tasksStore.flush()
    this.settingsStore.flush()
    this.sessionsStore.flush()
  }
}

/**
 * 目标路径上已经有文件时改名，绝不覆盖。
 * 下载目录里躺着的可能是用户自己的文件，和这次要下的东西毫无关系——
 * 实测过：路径撞车时旧文件会被新下载整份替换掉。
 */
export function uniquePath(p: string): string {
  if (!p || !existsSync(p)) return p
  const dir = dirname(p)
  const ext = extname(p)
  const stem = basename(p, ext)
  for (let i = 1; i < 1000; i++) {
    const cand = join(dir, `${stem} (${i})${ext}`)
    if (!existsSync(cand)) return cand
  }
  return p
}

/** 12 位十六进制随机 ID。 */
function newId(): string {
  return randomBytes(6).toString('hex')
}

/**
 * 从 URL/服务端给的名字里取出可以安全落盘的文件名。
 *
 * 顺序很关键：必须先解码再取 basename。反过来的话 `%2e%2e%2f` 这种编码过的
 * `../` 会在解码后变成真正的路径分隔符，把保存路径从下载目录里逃出去。
 * 兜底再把任何分隔符与 Windows 保留字符替换掉。
 */
export function safeFileName(name: string): string {
  let s = name
  try {
    s = decodeURIComponent(name)
  } catch {
    // 非法百分号编码（`%zz`）就用原串
  }
  s = basename(s)
    .replace(/[\\/]/g, '_')
    .replace(/[<>:"|?*\x00-\x1f]/g, '_')
    .trim()
  while (s.startsWith('.')) s = `_${s.slice(1)}`
  return s || 'download'
}
