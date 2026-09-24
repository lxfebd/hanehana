/**
 * Steam 库导入（G4）。
 *
 * 两种来源：
 * 1. libraryfolders.vdf 里声明的库目录（可能多盘）→ 扫 common/ 下的游戏文件夹
 * 2. 每个游戏文件夹里的 appmanifest_*.acf → 读取 appid / 名称 / 安装目录
 *
 * 用 appmanifest 做主数据源：它给的是 Steam 官方名称（比文件夹名干净），
 * 且能覆盖「文件夹名与游戏名不一致」的情况。找不到 manifest 时才退回文件夹名。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Dirent } from 'node:fs'

export interface SteamCandidate {
  dir: string
  exePath: string
  rawTitle: string
  appid?: string
}

/** Steam 安装目录（registry 之外最常见的两个位置）。找不到返回 null。
 *  HANEHANA_STEAM_ROOT 是测试/隔离通道，与 HANEHANA_DATA_DIR 同口径。 */
export function findSteamRoot(): string | null {
  if (process.env.HANEHANA_STEAM_ROOT) {
    return existsSync(join(process.env.HANEHANA_STEAM_ROOT, 'steamapps')) ? process.env.HANEHANA_STEAM_ROOT : null
  }
  const candidates = [
    join(process.env.ProgramFiles ?? 'C:\\Program Files (x86)', 'Steam'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Steam'),
    'D:\\Steam',
    'E:\\Steam',
  ]
  return candidates.find((p) => existsSync(join(p, 'steam.exe'))) ?? null
}

/** 解析 libraryfolders.vdf，返回所有库目录的绝对路径。 */
async function parseLibraryFolders(root: string): Promise<string[]> {
  const vdfPath = join(root, 'steamapps', 'libraryfolders.vdf')
  if (!existsSync(vdfPath)) return []
  try {
    const txt = await readFile(vdfPath, 'utf8')
    const dirs: string[] = []
    // vdf 里形如 "1"  "D:\\SteamLibrary" 的键值对
    const re = /"(\d+)"\s*"([^"]+)"/g
    let m: RegExpExecArray | null
    while ((m = re.exec(txt)) !== null) {
      const p = m[2].replace(/\\\\/g, '\\').replace(/\\\?\\/g, '')
      if (p) dirs.push(p)
    }
    // 兼容新格式（path 键）："path"  "D:\\SteamLibrary"
    const pathRe = /"path"\s*"([^"]+)"/g
    while ((m = pathRe.exec(txt)) !== null) {
      const p = m[1].replace(/\\\\/g, '\\').replace(/\\\?\\/g, '')
      if (p && !dirs.includes(p)) dirs.push(p)
    }
    return dirs
  } catch {
    return []
  }
}

/** 解析 appmanifest_*.acf，拿 appid + 名称 + 安装目录。 */
interface ManifestInfo {
  appid: string
  name: string
  installdir: string
}

function parseManifest(txt: string): ManifestInfo | null {
  const appidM = /"appid"\s*"(\d+)"/.exec(txt)
  const nameM = /"name"\s*"([^"]+)"/.exec(txt)
  const dirM = /"installdir"\s*"([^"]+)"/.exec(txt)
  if (!appidM || !nameM || !dirM) return null
  return { appid: appidM[1], name: nameM[1], installdir: dirM[1] }
}

/** 扫描 Steam 全部库目录，返回候选游戏（appmanifest 优先，兜底扫 exe）。 */
export async function scanSteamLibrary(): Promise<SteamCandidate[]> {
  const root = findSteamRoot()
  if (!root) return []
  const libs = await parseLibraryFolders(root)
  // 默认库（steamapps 在 Steam 根下）总是参与
  const roots = [...new Set([join(root, 'steamapps'), ...libs.map((l) => join(l, 'steamapps'))])]
  console.log('[steam] root=', root, 'libs=', JSON.stringify(libs), 'roots=', JSON.stringify(roots))

  const out: SteamCandidate[] = []
  for (const apps of roots) {
    const common = join(apps, 'common')
    if (!existsSync(common)) continue
    let entries: Dirent[] = []
    try {
      entries = await readdir(common, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const dir = join(common, e.name)
      // 尝试 appmanifest 精确匹配：找本库目录下的 manifest，installdir 与目录名一致
      let manifest: ManifestInfo | null = null
      try {
        const manFiles = (await readdir(apps)).filter((f) => /^appmanifest_\d+\.acf$/.test(f))
        for (const f of manFiles) {
          const txt = await readFile(join(apps, f), 'utf8')
          const info = parseManifest(txt)
          if (info && info.installdir === e.name) {
            manifest = info
            break
          }
        }
      } catch {
        manifest = null
      }
      // 找启动 exe（与 scanner 同策略：排除工具类，优先与目录名相似）
      const exe = await pickSteamExe(dir)
      if (!exe) continue
      out.push({
        dir,
        exePath: exe,
        rawTitle: manifest?.name ?? e.name,
        appid: manifest?.appid,
      })
    }
  }
  return out
}

const TOOL_RE = /^(unins\d*|setup|install|installer)\.exe$/i

async function pickSteamExe(dir: string): Promise<string | null> {
  let entries: Dirent[] = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  const exes = entries
    .filter((e) => e.isFile() && /\.exe$/i.test(e.name) && !TOOL_RE.test(e.name))
    .map((e) => join(dir, e.name))
  if (exes.length === 0) return null
  const dirBase = basename(dir).toLowerCase().replace(/[^a-z0-9]/g, '')
  exes.sort((a, b) => {
    const na = basename(a).toLowerCase().replace(/\.exe$/i, '').replace(/[^a-z0-9]/g, '')
    const nb = basename(b).toLowerCase().replace(/\.exe$/i, '').replace(/[^a-z0-9]/g, '')
    const sa = (dirBase && na.includes(dirBase) ? 100 : 0) + Math.max(0, 20 - na.length)
    const sb = (dirBase && nb.includes(dirBase) ? 100 : 0) + Math.max(0, 20 - nb.length)
    return sb - sa
  })
  return exes[0]
}
