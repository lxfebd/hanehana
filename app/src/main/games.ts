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
import type { Game } from '../shared/types'

export interface ScanResult {
  added: Game[]
  hits: { dir: string; exePath: string; rawTitle: string }[]
  skipped: number
}

export function handleScan(root: string): ScanResult {
  if (!isValidDir(root)) {
    throw new Error('目录不存在或不可读：' + root)
  }
  const hits = scanDir(root)
  // 已入库的 exe 自动去重（addGames 内部按 exe 去重），这里统计跳过数
  const existing = new Set(getGames().map((g) => g.exePath.toLowerCase()))
  const fresh = hits.filter((h) => !existing.has(h.exePath.toLowerCase()))
  const added = addGames(fresh.map((h) => ({ dir: h.dir, exePath: h.exePath, rawTitle: h.rawTitle, title: h.rawTitle, useLE: false, useMagpie: false })))
  return { added, hits, skipped: hits.length - fresh.length }
}

export function handleRemove(id: string): void {
  removeGame(id)
}

export function handleUpdate(id: string, patch: Partial<Game>): Game | undefined {
  return updateGame(id, patch)
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

export function handleLaunch(id: string): { ok: boolean; error?: string } {
  const g = getGame(id)
  if (!g) return { ok: false, error: '游戏不在库中' }
  if (!existsSync(g.exePath)) return { ok: false, error: '启动文件不存在：' + g.exePath }
  if (runningProc.has(id)) return { ok: false, error: '游戏已在运行' }

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

    proc.on('exit', () => {
      const since = runningSince.get(id)
      if (since !== undefined) {
        const ms = Date.now() - since
        updateGame(id, { playMs: g.playMs + ms })
      }
      runningProc.delete(id)
      runningSince.delete(id)
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function handleRunning(): string[] {
  // 清理僵尸条目（进程已退但事件没到）
  for (const [id, proc] of runningProc) {
    if (proc.exitCode !== null || proc.killed) runningProc.delete(id)
  }
  return [...runningProc.keys()]
}

/** 关闭所有仍在运行的游戏子进程（退出应用时调用）。 */
export function killAllRunning(): void {
  for (const proc of runningProc.values()) {
    try {
      proc.kill()
    } catch {
      // 进程可能已退出
    }
  }
  runningProc.clear()
}