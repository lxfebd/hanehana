/**
 * 游戏模型与持久化。
 *
 * 存储：~/.hanehana/games.json —— 单文件 JSON，对齐业界共识
 * （GalSpace 等个人工具的轻量选择），不上 SQLite：游戏条目规模
 * 是百到千级，JSON 全量读写毫秒级，省掉 schema 迁移成本。
 *
 * 写入纪律：全量原子写（先写临时文件再 rename），避免进程被杀
 * 留下半个文件。单实例锁已保证同一时刻只有一个写入者。
 */
import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Game } from '../shared/types'

/**
 * 游戏库数据目录：默认 userData（%APPDATA%/hanehana），
 * HANEHANA_DATA_DIR 仅测试隔离时覆盖。与任务/设置（~/.hanehana）分开是现状，
 * REDESIGN-SPEC §1 的诊断也以 games.json 在 %APPDATA%/hanehana 为前提。
 */
export function gameDataDir(): string {
  if (process.env.HANEHANA_DATA_DIR) return process.env.HANEHANA_DATA_DIR
  return app.getPath('userData')
}

export const dataDir = gameDataDir()
export const coversDir = join(dataDir, 'covers')
export const gamesPath = join(dataDir, 'games.json')

let games: Game[] = []

/** 启动时加载；文件不存在就是全新开始。 */
export function loadGames(): Game[] {
  if (games.length > 0) return games
  try {
    if (existsSync(gamesPath)) {
      games = JSON.parse(readFileSync(gamesPath, 'utf8')) as Game[]
    }
  } catch (e) {
    console.error('[hanehana] games.json 解析失败，按空库继续：', e)
    games = []
  }
  return games
}

export function getGames(): Game[] {
  return games
}

export function getGame(id: string): Game | undefined {
  return games.find((g) => g.id === id)
}

/** 按 exe 路径去重：同一 exe 只入一次库。 */
export function findGameByExe(exePath: string): Game | undefined {
  const norm = exePath.toLowerCase()
  return games.find((g) => g.exePath.toLowerCase() === norm)
}

export function addGames(entries: Omit<Game, 'id' | 'addedAt' | 'playMs' | 'tags' | 'categories' | 'sources'>[]): Game[] {
  const now = Date.now()
  const added: Game[] = []
  for (const e of entries) {
    if (findGameByExe(e.exePath)) continue
    const g: Game = {
      ...e,
      id: crypto.randomUUID(),
      playMs: 0,
      tags: [],
      categories: [],
      sources: [],
      addedAt: now,
    }
    games.push(g)
    added.push(g)
  }
  if (added.length > 0) persist()
  return added
}

export function updateGame(id: string, patch: Partial<Game>): Game | undefined {
  const g = getGame(id)
  if (!g) return undefined
  Object.assign(g, patch)
  persist()
  return g
}

export function removeGame(id: string): void {
  games = games.filter((g) => g.id !== id)
  persist()
}

/** 全量原子写。 */
function persist(): void {
  mkdirSync(dataDir, { recursive: true })
  const tmp = gamesPath + '.tmp'
  writeFileSync(tmp, JSON.stringify(games, null, 2), 'utf8')
  renameSync(tmp, gamesPath)
}

/** 封面目录确保存在，返回其绝对路径。 */
export function ensureCoversDir(): string {
  mkdirSync(coversDir, { recursive: true })
  return coversDir
}
