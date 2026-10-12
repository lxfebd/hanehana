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
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  existsSync,
  copyFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { join, resolve, sep, dirname } from 'node:path'
import type { Game, GameVariant } from '../shared/types'
import { dataDir as storeDataDir } from './store'
import { createJsonStore } from './jsonStore'

/**
 * 游戏库数据目录：与任务/设置同一真值源（~/.hanehana），
 * HANEHANA_DATA_DIR 仅测试隔离时覆盖。旧版本放在 %APPDATA%/hanehana，
 * 见 migrateFromLegacyDir()。
 */
export const dataDir = storeDataDir()
export const coversDir = join(dataDir, 'covers')
export const thumbsDir = join(dataDir, 'thumbs')
export const gamesPath = join(dataDir, 'games.json')

/** 旧版游戏库目录：%APPDATA%/hanehana。首次启动时若有数据则整体搬入新目录。 */
function legacyDir(): string {
  return app.getPath('userData')
}

function migrateFromLegacyDir(): void {
  const legacy = legacyDir()
  // 迁移是一次性的「首启搬旧库」，且只在真实用户目录生效：
  // - 目标已有数据（含 HANEHANA_DATA_DIR 隔离的测试 seed）绝不能被 legacy 覆盖；
  // - HANEHANA_DATA_DIR 是测试/隔离通道，任何情况下都不得触发迁移，
  //   否则本机旧库会悄悄渗进隔离目录，测试断言看到的不是 seed 而是旧数据。
  if (
    process.env.HANEHANA_DATA_DIR ||
    legacy === dataDir ||
    !existsSync(join(legacy, 'games.json')) ||
    existsSync(gamesPath)
  ) {
    return
  }
  console.log(`[hanehana] 检测到旧版游戏库目录 ${legacy}，迁移到 ${dataDir}`)
  mkdirSync(dataDir, { recursive: true })
  copyFileSync(join(legacy, 'games.json'), gamesPath)
  for (const [src, dst] of [
    [join(legacy, 'covers'), coversDir],
    [join(legacy, 'thumbs'), thumbsDir],
  ] as const) {
    if (!existsSync(src)) continue
    mkdirSync(dst, { recursive: true })
    for (const f of readdirSync(src)) {
      if (!existsSync(join(dst, f))) copyFileSync(join(src, f), join(dst, f))
    }
  }
  // 迁移完成后旧目录原样保留（只读走，不删），用户可自行清理
}

let games: Game[] = []
// 显式的「已加载」标志：不能用 games.length 判断——空库时 length===0 会让
// 每次 loadGames() 都重新读盘（且 migrate 反复跑）。加载过就是加载过。
let gamesLoaded = false

/** 启动时加载；文件不存在就是全新开始。 */
export function loadGames(): Game[] {
  if (gamesLoaded) return games
  gamesLoaded = true
  migrateFromLegacyDir()
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

export function addGames(
  entries: Omit<Game, 'id' | 'addedAt' | 'playMs' | 'tags' | 'categories' | 'sources' | 'favorite'>[],
): Game[] {
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
      favorite: false,
      addedAt: now,
    }
    games.push(g)
    added.push(g)
  }
  if (added.length > 0) persistCoalesced()
  return added
}

export function updateGame(id: string, patch: Partial<Game>): Game | undefined {
  const g = getGame(id)
  if (!g) return undefined
  Object.assign(g, patch)
  persistCoalesced()
  return g
}

// ---------------------------------------------------------------- 入参白名单
//
// 渲染层是不可信输入（它加载的页面/扩展/任何一个 XSS 都能调 window.hh）。
// 这里把「界面能改什么」写成显式白名单，而不是 Object.assign 直通：
// 直通等于把 id、playMs 等内部字段交出去。exePath 可改，但必须过
// existsSync 存在性校验（见 case 'exePath'，与 variants.exePath 同闸）：
// 渲染层只能指向磁盘上真实存在的 exe，「点启动即执行任意程序」的面不放开。

/** 图片路径只准落在 covers/ 与 thumbs/ 内：hh:// 协议照着这两个字段读文件。
 *  用 realpathSync 解真实路径再校验：resolve 只做字符串归一，symlink 仍可能
 *  指向缓存目录之外（例如把 /etc/passwd 的软链放进 covers 再当 coverPath 传）；
 *  realpath 后链接已被解开，逃不出这两个目录。存在性由调用方保证（保存时
 *  只收真实存在的路径），realpath 抛错（不存在/断链）一律拒绝。 */
export function isImageCachePath(p: unknown): p is string {
  if (typeof p !== 'string' || !p) return false
  let real: string
  try {
    real = realpathSync(p)
  } catch {
    return false
  }
  for (const dir of [coversDir, thumbsDir]) {
    const root = resolve(dir)
    if (real === root || real.startsWith(root + sep)) return true
  }
  return false
}

/** 渲染层可改的游戏字段。不在表里的一律丢弃（含 id/dir/playMs/addedAt）；
 *  exePath 在表里但另过存在性校验（见 sanitizeGamePatch 的 case 'exePath'）。 */
const PATCHABLE: readonly (keyof Game)[] = [
  'exePath',
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
  'favorite',
  'manualEdit',
  'backupEnabled',
  'preLaunchCmd',
  'postLaunchCmd',
  'developer',
  'series',
  'aliases',
  'lengthMinutes',
  'variants',
  'activeVariant',
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
      case 'exePath': {
        // 主启动路径（路径失效自救）：必须是已存在的**文件**（目录 existsSync 也过，statSync 挡掉）。
        // dir 跟着 exe 重推导，维持「dir = dirname(exePath)」不变量。
        if (typeof v !== 'string') break
        const p = v.trim()
        if (!p || p.length > 4000 || /[\x00-\x1f]/.test(p)) break
        try {
          if (!existsSync(p) || !statSync(p).isFile()) break
        } catch {
          break
        }
        const abs = resolve(p)
        out.exePath = abs
        out.dir = dirname(abs)
        break
      }
      case 'useLE':
      case 'useMagpie':
      case 'favorite':
      case 'manualEdit':
      case 'backupEnabled':
        if (typeof v === 'boolean') out[key] = v
        break
      case 'rating':
        if (typeof v === 'number' && Number.isFinite(v)) out.rating = Math.min(10, Math.max(0, v))
        break
      case 'tags':
      case 'categories':
      case 'series':
      case 'aliases': {
        if (!Array.isArray(v)) break
        const list = v.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 64))
        out[key] = list.slice(0, 200)
        break
      }
      case 'lengthMinutes':
        if (typeof v === 'number' && Number.isFinite(v))
          out.lengthMinutes = Math.min(100000, Math.max(0, Math.floor(v)))
        break
      case 'variants': {
        // G13+G17 多版本/语言包：数组，每项 {label, exePath, preLaunchCmd?}，exePath 必须存在
        if (!Array.isArray(v)) break
        const list: GameVariant[] = []
        for (const item of v) {
          if (!item || typeof item !== 'object') continue
          const it = item as Record<string, unknown>
          if (typeof it.label !== 'string' || !it.label.trim()) continue
          // 与主 exePath 同闸：必须是已存在的**文件**，目录/空串/带控制符一律不收。
          // 老写法只 existsSync，目录也能过——变体 exePath 指向目录时，启动侧
          // spawn 会在 error 事件里才炸，用户看到的是「点了没反应」。
          if (typeof it.exePath !== 'string' || !it.exePath.trim()) continue
          const vp = it.exePath.trim()
          if (vp.length > 4000 || /[\x00-\x1f]/.test(vp)) continue
          try {
            if (!existsSync(vp) || !statSync(vp).isFile()) continue
          } catch {
            continue
          }
          list.push({
            label: it.label.trim().slice(0, 64),
            exePath: resolve(vp),
            preLaunchCmd: typeof it.preLaunchCmd === 'string' ? it.preLaunchCmd.slice(0, 4000) : undefined,
          })
        }
        out.variants = list.slice(0, 20)
        break
      }
      case 'activeVariant':
        // G13+G17：0/缺省 = 默认 exePath，n≥1 = variants[n-1]；越界由启动侧兜底
        if (typeof v === 'number' && Number.isFinite(v)) out.activeVariant = Math.max(0, Math.floor(v))
        break
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
  const gone = games.find((g) => g.id === id)
  games = games.filter((g) => g.id !== id)
  if (gone) dropGameCache(gone)
  persistCoalesced()
}

/** 删游戏时把它的封面/缩略图缓存文件一并清掉，不留孤儿（与 heal 同口径）。 */
function dropGameCache(g: Game): void {
  for (const p of [g.coverPath, g.thumbPath]) {
    if (!p || !isImageCachePath(p)) continue
    try {
      if (existsSync(p)) unlinkSync(p)
    } catch {
      // 被占用/无权限：删不掉就留着，字段已从库移除，文件等下次手动清
    }
  }
}

// ---------------------------------------------------------------- 持久化
// 统一走 jsonStore（原子写 + 400ms 尾触发合并 + flush），不再各写一套。
// 为什么用宏任务定时器而不是 queueMicrotask：微任务队列在每个 await 边界
// 都会被排空，回填/自愈是「逐个 await」的循环——每次 await 都会把微任务
// 跑掉，于是每张图仍然各写一次全量 games.json（千级库首轮回填 = 上千次
// pretty 序列化 + 上千次 rename）。宏任务窗口拉到真正的一批。
// save 收到的是 `games` 数组引用，定时器到期序列化时读的是当时的最新内容
// ——这正是尾触发合并的语义：连续更新只落盘一次、落的是最新快照。
const gamesStore = createJsonStore<Game[]>(gamesPath)

/** 合并写入（尾触发 debounce）：连续多次 updateGame 只落盘一次。 */
function persistCoalesced(): void {
  gamesStore.save(games)
}

/**
 * 立即把待写内容落盘（进程退出前调用）。返回是否真的写了。
 * 没有它，退出时可能正好卡在合并窗口里，丢掉最后一批更新。
 */
export function flushPersist(): boolean {
  return gamesStore.flush()
}

/** 封面目录确保存在，返回其绝对路径。 */
export function ensureCoversDir(): string {
  mkdirSync(coversDir, { recursive: true })
  return coversDir
}
