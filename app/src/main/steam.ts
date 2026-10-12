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
import { existsSync, type Dirent } from 'node:fs'
import { basename, join } from 'node:path'

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

/**
 * 扫描 Steam 全部库目录，返回候选游戏（appmanifest 优先，兜底扫 exe）。
 *
 * 每个库目录的 appmanifest_*.acf 只 readdir+parse 一次，建成
 * Map<installdir, ManifestInfo> 再逐游戏目录查表：此前对每个游戏目录
 * 都重新 readdir(apps) + 全量 readFile 一遍全部 manifest，N 个游戏 = N 次
 * 重复读盘，库大（数百游戏）时一次扫描上千次磁盘读。
 */
export async function scanSteamLibrary(): Promise<SteamCandidate[]> {
  const root = findSteamRoot()
  if (!root) return []
  const libs = await parseLibraryFolders(root)
  // 默认库（steamapps 在 Steam 根下）总是参与
  const roots = [...new Set([join(root, 'steamapps'), ...libs.map((l) => join(l, 'steamapps'))])]

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
    // 本库目录的 manifest 一次读完：installdir → ManifestInfo
    const byInstalldir = new Map<string, ManifestInfo>()
    try {
      const manFiles = (await readdir(apps)).filter((f) => /^appmanifest_\d+\.acf$/.test(f))
      for (const f of manFiles) {
        const info = parseManifest(await readFile(join(apps, f), 'utf8'))
        if (info) byInstalldir.set(info.installdir, info)
      }
    } catch {
      // 读不到 manifest 目录不致命：候选退回文件夹名
    }
    // 找启动 exe（与 scanner 同策略：排除工具类，优先与目录名相似）。
    // 逐目录串行 await 会让数百游戏整趟几十秒（每目录最多 3 层递归 readdir）；
    // 按 16 个一批并发（scanner.ts 同款 BATCH 范式），结果按原目录顺序排。
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => join(common, e.name))
    const exes: (string | null)[] = []
    const BATCH = 16
    for (let i = 0; i < dirs.length; i += BATCH) {
      const batch = dirs.slice(i, i + BATCH)
      const picked = await Promise.all(batch.map((d) => pickSteamExe(d)))
      exes.push(...picked)
    }
    for (let i = 0; i < dirs.length; i++) {
      const dir = dirs[i]
      const exe = exes[i]
      if (!exe) continue
      const manifest = byInstalldir.get(basename(dir))
      out.push({
        dir,
        exePath: exe,
        rawTitle: manifest?.name ?? basename(dir),
        appid: manifest?.appid,
      })
    }
  }
  return out
}

const TOOL_RE = /^(unins\d*|setup|install|installer)\.exe$/i

/**
 * 从游戏目录里挑主启动 exe。
 *
 * 只扫根目录会漏掉一大票 Steam 游戏：很多把主程序放在
 * bin/win64/、bin/x64/、game/ 这类一层子目录里（实测最深的
 * 是两层，比如 <dir>/bin/win64/xxx.exe）。但也不该无限递归：
 * 有些游戏目录里躺着几十 MB 的引擎资源树（Unreal 的
 * Engine/Binaries/…），整树找会把启动器之外的 exe 当主程序。
 * 所以最多往下走两层，并且每一层都按「名字越接近目录名越优先」
 * 的启发式排序——层数越浅的候选取分越高。
 */
const MAX_EXE_DEPTH = 2

async function pickSteamExe(dir: string): Promise<string | null> {
  const candidates: string[] = []
  const dirBase = basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

  async function walk(d: string, depth: number): Promise<void> {
    let entries: Dirent[] = []
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isFile() && /\.exe$/i.test(e.name) && !TOOL_RE.test(e.name)) {
        candidates.push(join(d, e.name))
      } else if (
        e.isDirectory() &&
        depth < MAX_EXE_DEPTH &&
        !/^(unins|redist|_CommonRedist|Engine|Plugins|Content)\b/i.test(e.name)
      ) {
        await walk(join(d, e.name), depth + 1)
      }
    }
  }

  await walk(dir, 0)
  if (candidates.length === 0) return null
  candidates.sort((a, b) => {
    const rank = (p: string): number => {
      const rel = p.slice(dir.length).split(/[\\/]/)
      // 层数越浅越好（根目录 +1000，每深一层 -100）
      const depthScore = 1000 - rel.length * 100
      const name = basename(p)
        .toLowerCase()
        .replace(/\.exe$/i, '')
        .replace(/[^a-z0-9]/g, '')
      // 文件名包含目录名（去符号后）加分——主程序通常和游戏同名
      const nameScore = (dirBase && name.includes(dirBase) ? 100 : 0) + Math.max(0, 20 - name.length)
      return depthScore + nameScore
    }
    return rank(b) - rank(a)
  })
  return candidates[0]
}
