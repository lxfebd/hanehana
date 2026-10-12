/**
 * 本地封面探测：游戏目录里常见的 cover/folder/poster 图直接进库，
 * 不联网、不刮削。找到则拷到 userData/covers/ 并生成缩略图。
 */
import { copyFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { ensureCoversDir, getGame, updateGame } from './gameStore'
import { coverColorOf } from './coverColor'
import { coverQualityOk } from './coverQuality'
import { ensureThumb } from './thumbs'
import type { Game } from '../shared/types'

/** 文件名优先级（先命中先用），大小写不敏感、允许无扩展名再扫图片后缀 */
const NAME_PRIORITY = [
  'cover',
  'folder',
  'poster',
  'titlegraphic',
  'title',
  'thumb',
  'header',
  '封面',
  '宣传图',
  'steam_grid',
  'grid',
]

const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp'])

function isImage(p: string): boolean {
  return IMG_EXT.has(extname(p).toLowerCase())
}

function scoreName(base: string): number {
  const n = base
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .trim()
  for (let i = 0; i < NAME_PRIORITY.length; i++) {
    const key = NAME_PRIORITY[i]!.toLowerCase()
    if (n === key) return 100 - i
    if (n.startsWith(key) || n.includes(key)) return 50 - i
  }
  return -1
}

/** 在 dir（及一层子目录）里找一张最像封面的图；找不到返回 null。 */
export function findLocalCover(dir: string): string | null {
  const candidates: { path: string; score: number }[] = []
  // 弱兜底用：仅记录游戏根目录（depth 0）的图片，避免把 CG 目录里的图当封面
  const rootImgs: { path: string; size: number }[] = []
  const scan = (d: string, depth: number): void => {
    if (depth > 2) return
    let entries: string[]
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(d, name)
      try {
        const st = statSync(full)
        if (st.isDirectory()) {
          if (
            /^(node_modules|\.git|backup|saves?|save|log|logs|cache|redist|_commonredist|directx|vcredist)/i.test(name)
          )
            continue
          scan(full, depth + 1)
          continue
        }
        if (!isImage(full)) continue
        const sc = scoreName(name)
        if (sc >= 0) candidates.push({ path: full, score: sc })
        if (depth === 0 && st.size >= 30000) rootImgs.push({ path: full, size: st.size })
      } catch {
        /* 无权限/竞态 */
      }
    }
  }
  scan(dir, 0)
  // 质量闸：文件名再像封面，残图/纯色废图也不收。实测事故——游戏目录里
  // 真有一张叫 header_bar.jpg 的 UI 装饰黑条（1024×36），靠文件名排在
  // TitleGraphic.png 前面被选中，三款游戏同一张黑条 = 封面墙三块黑。
  // 按分数从高到低逐个验，第一张过闸的就是封面。
  const firstOk = (list: { path: string }[]): string | null => {
    for (const c of list) {
      if (coverQualityOk(c.path)) return c.path
    }
    return null
  }
  if (candidates.length === 0) {
    // 弱兜底：没有 cover/folder 这类命名图时，退到游戏根目录里最大的单张图。
    // 只从根目录取，不深入 CG 目录——宁可没有，也不用角色 CG 冒充封面。
    if (rootImgs.length === 0) return null
    rootImgs.sort((a, b) => b.size - a.size)
    return firstOk(rootImgs)
  }
  candidates.sort((a, b) => b.score - a.score)
  return firstOk(candidates)
}

/**
 * 为游戏挂本地封面（已有 coverPath 则跳过）。
 * 返回是否写入了 coverPath。
 */
export function adoptLocalCover(g: Game): boolean {
  if (g.coverPath && existsSync(g.coverPath)) return false
  const src = findLocalCover(g.dir)
  if (!src) return false
  try {
    const covers = ensureCoversDir()
    const dest = join(covers, `${g.id}${extname(src).toLowerCase() || '.jpg'}`)
    copyFileSync(src, dest)
    updateGame(g.id, {
      coverPath: dest,
      color: coverColorOf(dest) ?? g.color,
    })
    const fresh = getGame(g.id)
    if (fresh) void ensureThumb(fresh)
    return true
  } catch (e) {
    console.error('[hanehana] 本地封面拷贝失败：', g.id, e)
    return false
  }
}

/**
 * 启动/扫描后批量补本地封面（已有网络封面的跳过）。
 *
 * 不在启动关键路径上同步跑：readdirSync 是阻塞调用，库里有几百个无封面
 * 游戏时，每个都要扫最多 3 层目录，同步执行会把「窗口可交互」推迟好几秒。
 * 挪到 setImmediate 之后**逐个让出事件循环**串行跑：setImmediate 只推迟起点，
 * 循环本体运行期间事件循环仍是被占的；质量闸（coverQualityOk）还要逐张全量
 * 解码候选图，不逐个 yield 的话千级库会把主线程整段占住几秒，窗口假死。
 */
export function backfillLocalCovers(games: Game[]): void {
  setImmediate(async () => {
    let n = 0
    for (const g of games) {
      await new Promise<void>((r) => setImmediate(r))
      if (g.coverPath && existsSync(g.coverPath)) continue
      if (adoptLocalCover(g)) n++
    }
    if (n > 0) console.log(`[hanehana] 本地封面回填 ${n} 张`)
  })
}
