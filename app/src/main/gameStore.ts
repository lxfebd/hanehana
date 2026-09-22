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
import { join, resolve, sep } from 'node:path'
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
export const thumbsDir = join(dataDir, 'thumbs')
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

// ---------------------------------------------------------------- 入参白名单
//
// 渲染层是不可信输入（它加载的页面/扩展/任何一个 XSS 都能调 window.hh）。
// 这里把「界面能改什么」写成显式白名单，而不是 Object.assign 直通：
// 直通等于把 id、exePath、playMs 全部交出去，改 exePath 就是「点启动即执行任意程序」。

/** 图片路径只准落在 covers/ 与 thumbs/ 内：hh:// 协议照着这两个字段读文件。 */
export function isImageCachePath(p: unknown): p is string {
  if (typeof p !== 'string' || !p) return false
  const norm = resolve(p)
  for (const dir of [coversDir, thumbsDir]) {
    const root = resolve(dir)
    if (norm === root || norm.startsWith(root + sep)) return true
  }
  return false
}

/** 渲染层可改的游戏字段。不在表里的一律丢弃（含 id/dir/exePath/playMs/addedAt）。 */
const PATCHABLE: readonly (keyof Game)[] = [
  'title',
  'titleNative',
  'description',
  'releaseDate',
  'rating',
  'tags',
  'categories',
  'useLE',
  'useMagpie',
  'color',
  'coverPath',
  'thumbPath',
  'thumbSrc',
]

/**
 * 过滤渲染层传来的 patch，只留白名单字段且形状正确的部分。
 *
 * 丢弃而不是报错：界面一次提交里混进一个不该改的字段（老版本缓存的表单、
 * 扩展投递的对象）不应该让整次编辑失败，用户看到「没保存上」却查不出原因更糟。
 * 真正的攻击面已经被挡住了——被丢掉的字段不会落盘。
 */
export function sanitizeGamePatch(raw: unknown): Partial<Game> {
  const out: Partial<Game> = {}
  if (!raw || typeof raw !== 'object') return out
  const d = raw as Record<string, unknown>
  for (const key of PATCHABLE) {
    if (!(key in d)) continue
    const v = d[key]
    switch (key) {
      case 'useLE':
      case 'useMagpie':
        if (typeof v === 'boolean') out[key] = v
        break
      case 'rating':
        if (typeof v === 'number' && Number.isFinite(v)) out.rating = Math.min(10, Math.max(0, v))
        break
      case 'tags':
      case 'categories': {
        if (!Array.isArray(v)) break
        const list = v.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 64))
        out[key] = list.slice(0, 200)
        break
      }
      case 'coverPath':
      case 'thumbPath':
      case 'thumbSrc':
        // 空串 = 清除封面，是合法操作；非空则必须在缓存目录内
        if (v === '') out[key] = ''
        else if (isImageCachePath(v)) out[key] = resolve(v)
        break
      default:
        if (typeof v === 'string') out[key] = v.slice(0, 4000) as never
        break
    }
  }
  return out
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
