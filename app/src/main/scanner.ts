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
import { readdir, stat } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import type { Dirent } from 'node:fs'

export interface ScanHit {
  dir: string
  exePath: string
  rawTitle: string
}

/** 名字像工具/补丁/安装器的可执行文件，不作为游戏启动项 */
const EXE_BLACKLIST = [
  /^unins\d*\.exe$/i,
  /^(setup|install|installer)\.exe$/i,
  /^config\.exe$/i,
  /^(dlss|dlssg).*\.exe$/i,
  /^cheat(engine)?(_?v?\d*)?\.exe$/i,
  /^magpie.*\.exe$/i,
  /^updater\.exe$/i,
  /^touchhelper\.exe$/i,
  /^unitycrashhandler\d*\.exe$/i,
  /^crashpad.*\.exe$/i,
  /^vcredist.*\.exe$/i,
  /^dxsetup\.exe$/i,
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

/** 宽匹配：cheat / dlss / magpie / unitycrash 等带版本尾巴的工具 exe。
 *  模块级常量而不是函数内联：函数在扫描循环里被每个文件调用一次，
 *  每次内联都会重新编译正则（扫描几千文件 × 每次编译 = 白耗 CPU）。 */
const TOOL_WIDE_RE = /cheat|dlss|magpie|unitycrash|crashpad|vcredist|dxwebsetup|^config\.exe$/i

function looksLikeTool(name: string): boolean {
  const base = basename(name)
  if (!/\.(exe|bat|lnk)$/i.test(base)) return true
  if (EXE_BLACKLIST.some((re) => re.test(base))) return true
  return TOOL_WIDE_RE.test(base)
}

/**
 * 递归扫描 dir 下所有含可执行文件的目录。
 * maxDepth 防跑进深嵌套的工具链目录。
 *
 * 异步遍历（一批一批读，每批之间让出事件循环）：同步递归扫一个几千个文件夹的
 * 游戏盘会把主进程钉死几秒到几十秒——那期间下载进度不推、界面不响应、托盘不刷新，
 * 用户看到的是「软件卡死了」。
 */
export async function scanDir(root: string, maxDepth = 6): Promise<ScanHit[]> {
  const hits: ScanHit[] = []
  let level: string[] = [root]

  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    const next: string[] = []
    for (let i = 0; i < level.length; i += BATCH) {
      const batch = level.slice(i, i + BATCH)
      const listed = await Promise.all(batch.map(listDir))
      for (let k = 0; k < batch.length; k++) {
        const dir = batch[k]
        const entries = listed[k]
        const exes: string[] = []
        for (const e of entries) {
          if (e.isDirectory()) next.push(join(dir, e.name))
          else if (e.isFile() && /\.(exe|bat|lnk)$/i.test(e.name)) exes.push(join(dir, e.name))
        }
        // 本目录有 exe 就判定为游戏目录（exe 与目录名相似度优先）
        if (exes.length > 0) {
          const pick = pickLauncher(exes, dir)
          if (pick) {
            hits.push({ dir, exePath: pick, rawTitle: basename(dir) })
            // 已命中就不同时扫子目录里的启动器（避免把汉化补丁目录又收一遍）。
            // 前缀必须带分隔符：否则 `Gold` 会把兄弟目录 `Gold2` 的子树一起剪掉。
            const prefix = dir.toLowerCase() + sep
            for (let j = next.length - 1; j >= 0; j--) {
              if (next[j].toLowerCase().startsWith(prefix)) next.splice(j, 1)
            }
          }
        }
      }
    }
    level = next
  }
  return dedupe(hits)
}

/** 一次并发读多少个目录。太大等于又把事件循环占满，太小则扫得慢。 */
const BATCH = 16

/** 读一个目录；无权限/已删除/路径不是目录都返回空列表，不打断整次扫描。 */
async function listDir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * 从目录的 exe 列表里挑「最像游戏启动器」的那个：
 * 1. 与目录名相同/包含关系优先（gold/ gold.exe 是典型）
 * 2. 否则挑名字最短的主程序
 */
function pickLauncher(exes: string[], dir: string): string | null {
  const valid = exes.filter((p) => !looksLikeTool(p))
  if (valid.length === 0) return null

  const dirBase = basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
  const scored = valid
    .map((p) => {
      const base = basename(p)
        .toLowerCase()
        .replace(/\.(exe|bat|lnk)$/i, '')
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
export async function isValidDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}
