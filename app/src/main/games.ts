/**
 * 游戏库主进程逻辑：扫描入库、CRUD、启动与游玩计时。
 *
 * 游玩计时：spawn 启动游戏 exe 后，轮询目标进程是否存活；存活期间累计
 * playMs（每 tick 加一次间隔），退出后写回 store。这是业界（LunaBox/
 * ReinaManager）通用的「进程驻留计时」做法，不依赖游戏自报。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { shell } from 'electron'
import { addGames, getGame, getGames, removeGame, updateGame } from './gameStore'
import { scanDir, isValidDir } from './scanner'
import type { Game, GameVariant, PlaySession, SteamImportResult } from '../shared/types'

export interface ScanResult {
  added: Game[]
  hits: { dir: string; exePath: string; rawTitle: string }[]
  skipped: number
}

export interface BatchResult {
  updated: number
  removed: number
}

export interface BatchPatch {
  id: string
  patch: Partial<Game>
}

export async function handleScan(root: string): Promise<ScanResult> {
  if (!(await isValidDir(root))) {
    throw new Error('目录不存在或不可读：' + root)
  }
  const hits = await scanDir(root)
  // 已入库的 exe 自动去重（addGames 内部按 exe 去重），这里统计跳过数
  const existing = new Set(getGames().map((g) => g.exePath.toLowerCase()))
  const fresh = hits.filter((h) => !existing.has(h.exePath.toLowerCase()))
  const added = addGames(fresh.map((h) => ({ dir: h.dir, exePath: h.exePath, rawTitle: h.rawTitle, title: h.rawTitle, useLE: false, useMagpie: false })))
  return { added, hits, skipped: hits.length - fresh.length }
}

/** Steam 导入（G4）：把选中的 Steam 候选入库。 */
export function handleSteamImport(candidates: { dir: string; exePath: string; rawTitle: string; appid?: string }[]): SteamImportResult {
  const existing = new Set(getGames().map((g) => g.exePath.toLowerCase()))
  const fresh = candidates.filter((c) => !existing.has(c.exePath.toLowerCase()))
  const added = addGames(
    fresh.map((c) => ({
      dir: c.dir,
      exePath: c.exePath,
      rawTitle: c.rawTitle,
      title: c.rawTitle,
      useLE: false,
      useMagpie: false,
    })),
  )
  // appid 记进 tags，方便识别 Steam 来源（不建新字段，只增字段原则）
  for (const g of added) {
    if (g) updateGame(g.id, { tags: [...(g.tags ?? []), `steam:${candidates.find((c) => c.exePath === g.exePath)?.appid ?? ''}`].filter(Boolean) })
  }
  return { added: added.length, skipped: candidates.length - fresh.length }
}

export function handleRemove(id: string): void {
  removeGame(id)
}

export function handleUpdate(id: string, patch: Partial<Game>): Game | undefined {
  return updateGame(id, patch)
}

/** 批量更新：每个条目携带自己的 patch（白名单在 index.ts 的 sanitizeGamePatch 里逐个滤）。 */
export function handleBatchUpdate(patches: BatchPatch[]): BatchResult {
  let updated = 0
  for (const { id, patch } of patches) {
    if (updateGame(id, patch)) updated++
  }
  return { updated, removed: 0 }
}

export function handleBatchRemove(ids: string[]): BatchResult {
  let removed = 0
  for (const id of ids) {
    if (getGame(id)) {
      removeGame(id)
      removed++
    }
  }
  return { updated: 0, removed }
}

export function handleOpenDir(dir: string): void {
  shell.openPath(dir)
}

export function handleOpenExeDir(exePath: string): void {
  shell.showItemInFolder(exePath)
}

// ---------------------------------------------------------------- 启动与计时

/** 正在运行的进程：gameId -> child */
const runningProc = new Map<string, ReturnType<typeof spawn>>()
/** 每次全库查询时把运行中的 id 并进去（真实来源是 runningProc） */
const runningSince = new Map<string, number>()

/** 游玩会话记录器（由 index.ts 注入，避免 games.ts 直接依赖 Store） */
let sessionSink: ((sessions: PlaySession[]) => void) | null = null
export function setSessionSink(sink: (sessions: PlaySession[]) => void): void {
  sessionSink = sink
}

/** 异常退出通知器（由 index.ts 注入）：崩溃/被杀时弹系统通知 */
let crashNotifier: ((payload: { title: string; dir: string }) => void) | null = null
export function setCrashNotifier(fn: (payload: { title: string; dir: string }) => void): void {
  crashNotifier = fn
}

/** 自动备份钩子（G1，由 index.ts 注入）：游戏正常退出且该游戏开了备份时后台跑快照 */
let autoBackupFn: ((game: Game) => void) | null = null
export function setAutoBackup(fn: (game: Game) => void): void {
  autoBackupFn = fn
}

/** 工具路径读取器（G2，由 index.ts 注入）：返回设置里的 LE/Magpie 路径，空串 = 未配置 */
let toolPathsFn: (() => { le: string; magpie: string }) | null = null
export function setToolPaths(fn: () => { le: string; magpie: string }): void {
  toolPathsFn = fn
}

/** 游戏退出时落一条会话记录（供统计报表聚合）。 */
function recordSession(id: string, title: string, start: number, end: number): void {
  const ms = end - start
  if (ms < 1000) return
  sessionSink?.([{ gameId: id, title, start, end, ms }])
}

/** 最近一次退出是否是异常（非 0 退出码 = 崩溃/被杀被工具强杀）。 */
export interface CrashRecord {
  title: string
  dir: string
}
const recentCrashes = new Map<string, CrashRecord>()

function recordExit(id: string, title: string, dir: string, code: number | null, signal: string | null): void {
  // 正常退出：code 0 或 null（用户自己关窗口）；异常：非 0 退出码 / 信号终止
  const abnormal = code !== 0 && code !== null
  if (abnormal) {
    recentCrashes.set(id, { title, dir })
    crashNotifier?.({ title, dir })
  }
}

/** 查询最近崩溃记录；消费后清除，避免重复通知。 */
export function consumeRecentCrash(): CrashRecord | null {
  const it = recentCrashes.entries().next()
  if (it.done) return null
  const [id, rec] = it.value
  recentCrashes.delete(id)
  return rec
}

/**
 * 把挂接命令拆成 argv：用户填「exe 路径 + 参数」，支持双引号包裹含空格的路径。
 * 不做 shell 语义（不经过 cmd），避免衍生进程把 exit 事件绑错。
 */
function splitCommand(cmd: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (ch === '"') {
      inQ = !inQ
      continue
    }
    if (ch === ' ' && !inQ) {
      if (cur) {
        out.push(cur)
        cur = ''
      }
      continue
    }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

/** 占位符替换：{exe} = 实际启动目标 exe（含变体），{dir} = 游戏目录 */
function applyPlaceholders(cmd: string, game: Game, exe: string): string {
  return cmd.replaceAll('{exe}', exe).replaceAll('{dir}', game.dir)
}

/** G13+G17：解析当前启动目标。activeVariant=0/缺省 → 默认 exePath；n≥1 → variants[n-1]。越界回退默认。 */
function activeExe(g: Game): { exe: string; variant: GameVariant | undefined } {
  const n = g.activeVariant ?? 0
  if (n >= 1 && Array.isArray(g.variants) && n <= g.variants.length) {
    const v = g.variants[n - 1]
    if (v && v.exePath) return { exe: v.exePath, variant: v }
  }
  return { exe: g.exePath, variant: undefined }
}

/** 启动挂接命令。wait=true 时等它退出（超时 30s 继续，不阻塞启动太久）；返回是否 spawn 成功。 */
function runHook(argv: string[], cwd: string, wait: boolean): boolean {
  if (!argv.length) return true
  try {
    const p = spawn(argv[0], argv.slice(1), { cwd, detached: true, stdio: 'ignore', windowsHide: false })
    if (wait) {
      const t = setTimeout(() => p.kill(), 30000)
      p.on('exit', () => clearTimeout(t))
      // 前置命令最多等 30s：galgame 汉化补丁/环境准备通常秒级完成，等太久用户以为卡死
    }
    // 命令不存在/无权限走异步 error 事件：没有监听器就是 uncaughtException 直接带走主进程。
    // 返回值保持 true（同步 spawn 已成功）；hook 失败不该让游戏本体启动链断开。
    p.on('error', () => {})
    return true
  } catch {
    return false
  }
}

/** 探测常见安装路径（设置未填时兜底）。 */
function detectToolPath(candidates: string[]): string {
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return ''
}

export function handleLaunch(id: string): { ok: boolean; error?: string } {
  const g = getGame(id)
  if (!g) return { ok: false, error: '游戏不在库中' }
  // G13+G17 变体解析：启动目标可能是 variants 里的另一个 exe
  const { exe, variant } = activeExe(g)
  if (!existsSync(exe)) return { ok: false, error: '启动文件不存在：' + exe }
  // 重复启动防护（G10）：同一游戏已在运行时明确拒绝，并说明原因
  if (runningProc.has(id)) {
    return { ok: false, error: `${g.title} 已在运行中（想再开一份请先关掉当前窗口，或用「打开目录」手动启动）` }
  }

  // .lnk 不是可执行映像，CreateProcess 会以异步 error 事件炸出来；
  // 快捷方式交给系统壳打开（代价：这条不计游玩时长）
  if (/\.lnk$/i.test(exe)) {
    void shell.openPath(exe)
    updateGame(id, { lastPlayed: Date.now() })
    return { ok: true }
  }

  // 启动前挂接命令（G2）：占位符替换后先跑，等待完成再启动游戏本体。
  // 变体有专属命令时接在游戏级命令之后（同等待语义）。
  if (g.preLaunchCmd?.trim()) {
    const argv = splitCommand(applyPlaceholders(g.preLaunchCmd.trim(), g, exe))
    if (!runHook(argv, g.dir, true)) {
      return { ok: false, error: '启动前命令执行失败：' + g.preLaunchCmd }
    }
  }
  if (variant?.preLaunchCmd?.trim()) {
    const argv = splitCommand(applyPlaceholders(variant.preLaunchCmd.trim(), g, exe))
    if (!runHook(argv, g.dir, true)) {
      return { ok: false, error: '变体启动前命令执行失败：' + variant.preLaunchCmd }
    }
  }

  try {
    // LE 转区：优先用设置里的执行器路径，回退环境变量（G2 从「开关」到「实际集成」）
    let cmd = exe
    let args: string[] = []
    if (g.useLE) {
      // 设置里显式配置的路径优先；没配才回退环境变量与常见安装位置
      const cfgLe = toolPathsFn?.().le.trim() ?? ''
      const le = cfgLe && existsSync(cfgLe)
        ? cfgLe
        : process.env.HANEHANA_LE_PATH && existsSync(process.env.HANEHANA_LE_PATH)
          ? process.env.HANEHANA_LE_PATH
          : detectToolPath([
            // 常见安装位置：安装版默认目录 + 绿色版常见根
            'C:\\Program Files\\Locale Emulator\\LEProc.exe',
            'C:\\Program Files (x86)\\Locale Emulator\\LEProc.exe',
            'D:\\Tools\\LocaleEmulator\\LEProc.exe',
            'D:\\Tools\\Locale Emulator\\LEProc.exe',
            'C:\\LocaleEmulator\\LEProc.exe',
          ])
      if (le) {
        cmd = le
        args = [exe]
      } else {
        return { ok: false, error: '游戏启用了 LE 转区，但找不到 Locale Emulator（请到设置→工具里指定 LEProc.exe 路径）' }
      }
    }
    const proc = spawn(cmd, args, {
      cwd: g.dir,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    runningProc.set(id, proc)
    runningSince.set(id, Date.now())
    updateGame(id, { lastPlayed: Date.now() })

    // spawn 的失败（ENOENT/EACCES/cwd 无效）走异步 error 事件；
    // 没有监听器就是 uncaughtException 直接带走主进程
    proc.on('error', (err) => {
      console.error('[launch] 启动失败:', id, err.message, 'path=', cmd, 'cwd=', g.dir, 'code=', (err as NodeJS.ErrnoException).code)
      runningProc.delete(id)
      runningSince.delete(id)
    })
    proc.on('exit', (code, signal) => {
      const since = runningSince.get(id)
      if (since !== undefined) {
        const now = Date.now()
        const ms = now - since
        updateGame(id, { playMs: g.playMs + ms, lastPlayed: now })
        recordSession(id, g.title, since, now)
        // 正常退出（非 0 不算崩）：自动备份已开启 → 后台快照
        if (autoBackupFn && (code === 0 || code === null)) {
          const fresh = getGame(id)
          if (fresh?.backupEnabled) autoBackupFn({ ...fresh, playMs: fresh.playMs })
        }
      }
      recordExit(id, g.title, g.dir, code, signal)
      runningProc.delete(id)
      runningSince.delete(id)
    })

    // Magpie 缩放（G2）：游戏起来后拉起 Magpie，置前台接管渲染缩放。
    // Magpie 用命令行动态缩放模式：Magpie.exe --launch <exePath>（<1.0 同义）。
    if (g.useMagpie) {
      const cfgMg = toolPathsFn?.().magpie.trim() ?? ''
      const magpie = cfgMg && existsSync(cfgMg)
        ? cfgMg
        : process.env.HANEHANA_MAGPIE_PATH && existsSync(process.env.HANEHANA_MAGPIE_PATH)
          ? process.env.HANEHANA_MAGPIE_PATH
          : detectToolPath([
            'C:\\Program Files\\Magpie\\Magpie.exe',
            'C:\\Program Files (x86)\\Magpie\\Magpie.exe',
            'D:\\Tools\\Magpie\\Magpie.exe',
            'C:\\Magpie\\Magpie.exe',
          ])
      if (magpie) {
        // 等 1s 让游戏窗口出现，再让 Magpie 接管（太早会抓不到目标窗口）
        setTimeout(() => {
          try {
            spawn(magpie, ['--launch', exe], { detached: true, stdio: 'ignore', windowsHide: false })
          } catch {
            // Magpie 拉起失败不阻塞游戏本体；用户仍可手动开
          }
        }, 1000)
      }
    }

    // 启动后挂接命令（G2）：不等待，并行拉起辅助工具（OCR/翻译/进度条）
    if (g.postLaunchCmd?.trim()) {
      const argv = splitCommand(applyPlaceholders(g.postLaunchCmd.trim(), g, exe))
      runHook(argv, g.dir, false)
    }

    return { ok: true }
  } catch (e) {
    runningProc.delete(id)
    runningSince.delete(id)
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function handleRunning(): string[] {
  // 清理僵尸条目（进程已退但事件没到），两张表一起清，避免 runningSince 永久残留
  for (const [id, proc] of runningProc) {
    if (proc.exitCode !== null || proc.killed) {
      runningProc.delete(id)
      runningSince.delete(id)
    }
  }
  return [...runningProc.keys()]
}

/** 应用退出时解除对游戏进程的跟踪。不 kill——用户正在玩的游戏不该被管理器带走。 */
export function detachAllRunning(): void {
  runningProc.clear()
  runningSince.clear()
}