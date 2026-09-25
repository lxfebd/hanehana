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
import type { Game, PlaySession, SteamImportResult } from '../shared/types'

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

export function handleLaunch(id: string): { ok: boolean; error?: string } {
  const g = getGame(id)
  if (!g) return { ok: false, error: '游戏不在库中' }
  if (!existsSync(g.exePath)) return { ok: false, error: '启动文件不存在：' + g.exePath }
  // 重复启动防护（G10）：同一游戏已在运行时明确拒绝，并说明原因
  if (runningProc.has(id)) {
    return { ok: false, error: `${g.title} 已在运行中（想再开一份请先关掉当前窗口，或用「打开目录」手动启动）` }
  }

  // .lnk 不是可执行映像，CreateProcess 会以异步 error 事件炸出来；
  // 快捷方式交给系统壳打开（代价：这条不计游玩时长）
  if (/\.lnk$/i.test(g.exePath)) {
    void shell.openPath(g.exePath)
    updateGame(id, { lastPlayed: Date.now() })
    return { ok: true }
  }

  try {
    // LE 转区：优先用 Locale Emulator 的执行器（可配置，默认不启用）
    let cmd = g.exePath
    let args: string[] = []
    if (g.useLE && process.env.HANEHANA_LE_PATH) {
      cmd = process.env.HANEHANA_LE_PATH
      args = [g.exePath]
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
      console.error('[launch] 启动失败:', id, err.message, 'path=', g.exePath, 'cwd=', g.dir, 'code=', (err as NodeJS.ErrnoException).code)
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