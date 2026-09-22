/**
 * 游戏目录扫描器。
 *
 * 业界共识流程：扫描文件夹 → 找启动 exe（优先排除汉化补丁/工具类可执行文件）→
 * 用文件夹名做临时标题 → 入库待刮削。
 *
 * 扫描策略（避免把工具 exe 当游戏）：
 *   - 递归收集所有 .exe / .bat / .lnk
 *   - 排除名字明显不是游戏的（unins000、汉化补丁、字体安装、读我文件等）
 *   - 每目录取「最像启动器的那个」：名字与文件夹名相似的 exe 优先
 */
import { readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

export interface ScanHit {
  dir: string
  exePath: string
  rawTitle: string
}

/** 名字像工具/补丁/安装器的可执行文件，不作为游戏启动项 */
const EXE_BLACKLIST = [
  /^unins\d*\.exe$/i,
  /^(setup|install|installer)\.exe$/i,
  /汉化/i,
  /补丁/i,
  /patch/i,
  /crack/i,
  /字体/i,
  /font/i,
  /readme/i,
  /说明/i,
  /更新/i,
  /update/i,
  /desktop\.ini/i,
]

function looksLikeTool(name: string): boolean {
  const base = basename(name)
  if (!/\.(exe|bat|lnk)$/i.test(base)) return true
  return EXE_BLACKLIST.some((re) => re.test(base))
}

/**
 * 递归扫描 dir 下所有含可执行文件的目录。
 * maxDepth 防跑进深嵌套的工具链目录。
 */
export function scanDir(root: string, maxDepth = 6): ScanHit[] {
  const hits: ScanHit[] = []

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // 无权限/已删除的目录直接跳过
    }

    const exes: string[] = []
    const subdirs: string[] = []
    for (const e of entries) {
      if (e.isDirectory()) subdirs.push(join(dir, e.name))
      else if (e.isFile() && /\.(exe|bat|lnk)$/i.test(e.name)) exes.push(join(dir, e.name))
    }

    // 本目录有 exe 就判定为游戏目录（exe 与目录名相似度优先）
    if (exes.length > 0) {
      const pick = pickLauncher(exes, dir)
      if (pick) {
        hits.push({ dir, exePath: pick, rawTitle: basename(dir) })
        // 已命中就不同时扫子目录里的启动器（避免把汉化补丁目录又收一遍）
        return
      }
    }

    for (const s of subdirs) walk(s, depth + 1)
  }

  walk(root, 0)
  return dedupe(hits)
}

/**
 * 从目录的 exe 列表里挑「最像游戏启动器」的那个：
 * 1. 与目录名相同/包含关系优先（gold/ gold.exe 是典型）
 * 2. 否则挑名字最短的主程序
 */
function pickLauncher(exes: string[], dir: string): string | null {
  const valid = exes.filter((p) => !looksLikeTool(p))
  if (valid.length === 0) return null

  const dirBase = basename(dir).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
  const scored = valid
    .map((p) => {
      const base = basename(p).toLowerCase().replace(/\.(exe|bat|lnk)$/i, '')
      const norm = base.replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
      let score = 0
      if (dirBase && norm === dirBase) score = 100
      else if (dirBase && norm.includes(dirBase)) score = 80
      else if (dirBase && dirBase.includes(norm) && norm.length >= 3) score = 60
      // 与目录名无关：主程序通常名字短、无版本号尾巴
      else if (base === 'game' || base === 'start' || base === 'galgame') score = 50
      else score = 20
      // 越短越像主程序
      score += Math.max(0, 20 - base.length)
      return { p, score }
    })
    .sort((a, b) => b.score - a.score)

  return scored[0].score >= 20 ? scored[0].p : null
}

function dedupe(hits: ScanHit[]): ScanHit[] {
  const seen = new Set<string>()
  return hits.filter((h) => {
    const key = h.exePath.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 校验一个目录确实存在且是目录。 */
export function isValidDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
