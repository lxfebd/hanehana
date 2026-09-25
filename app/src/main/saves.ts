/**
 * 存档备份/恢复（G1）。
 *
 * 快照模型：每个游戏一个备份目录 <backupRoot>/<gameId>/<ISO时间戳>/，
 * 内含存档文件全集 + meta.json（游戏名/来源路径/文件清单/哈希）。
 * 快照是完整复制而非增量：galgame 存档普遍几 MB，全量拷贝简单可靠，
 * 不需要 diff 的状态机。
 *
 * 云同步：WebDAV（GalgameManager 同款协议），用原生 fetch 实现——
 * PUT 上传 / GET 下载 / MKCOL 建目录 / PROPFIND 列清单，不引第三方依赖。
 * 冲突策略：比较两端 mtime，新者胜；同一时刻的冲突保留 .conflict-<ts> 副本。
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import type { BackupStats, CloudSyncResult, Game, SnapshotInfo } from '../shared/types'
import { dataDir } from './store'

// ---------------------------------------------------------------- 类型

export interface SnapshotMeta {
  gameId: string
  title: string
  dir: string
  createdAt: number
  files: { rel: string; size: number; sha1: string }[]
}

// ---------------------------------------------------------------- 路径

/** 数据目录稳定引用（进程内不变） */
const DATA_DIR = dataDir()

export function backupRoot(): string {
  return DATA_DIR + '\\backups'
}

export function gameBackupDir(gameId: string): string {
  return join(backupRoot(), sanitizeId(gameId))
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}

// ---------------------------------------------------------------- 快照创建

/**
 * 备份一个游戏的全部存档。
 *
 * 存档源目录的确定：exe 旁边的 save/data 等目录不够可靠，最稳的是「整个
 * 游戏目录里除本体外的可写文件」——但那样会把 10GB 游戏本体也拷进去。
 * 折中策略：优先找常见存档子目录（save/savedata/data/profile/sgdata…），
 * 找不到就整目录拷贝但跳过 exe/dll/pak 等体积大的本体文件。
 * 最终以 meta.json 里的 files 清单为准，恢复时按清单回拷。
 */
export function createSnapshot(game: Game, dest?: string): SnapshotInfo | null {
  const srcDir = game.dir
  if (!srcDir || !existsSync(srcDir)) return null
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = dest ?? join(gameBackupDir(game.id), ts)
  mkdirSync(outDir, { recursive: true })

  // 收集要备份的文件（相对 srcDir 的路径）
  const rels = collectSaveFiles(srcDir)

  const files: SnapshotMeta['files'] = []
  let totalBytes = 0
  for (const rel of rels) {
    const abs = join(srcDir, rel)
    try {
      const st = statSync(abs)
      if (!st.isFile()) continue
      const sha1 = hashFile(abs)
      files.push({ rel, size: st.size, sha1 })
      totalBytes += st.size
      // 目标子目录
      const dst = join(outDir, rel)
      mkdirSync(dirname(dst), { recursive: true })
      copyFileSync(abs, dst)
    } catch {
      // 单个文件被占用/删除跳过，不整批失败
      continue
    }
  }

  if (files.length === 0) {
    // 一个文件都没备份到：目录里可能全是本体。还是留个 meta 说明，避免恢复时空目录
    writeFileSync(
      join(outDir, 'meta.json'),
      JSON.stringify({ gameId: game.id, title: game.title, dir: srcDir, createdAt: Date.now(), files: [], note: 'no save files found' }, null, 2),
      'utf8',
    )
    return { gameId: game.id, title: game.title, dir: srcDir, createdAt: Date.now(), files: 0, totalBytes: 0, dirPath: outDir }
  }

  writeFileSync(join(outDir, 'meta.json'), JSON.stringify({ gameId: game.id, title: game.title, dir: srcDir, createdAt: Date.now(), files }, null, 2), 'utf8')
  return { gameId: game.id, title: game.title, dir: srcDir, createdAt: Date.now(), files: files.length, totalBytes, dirPath: outDir }
}

/** 常见 galgame 存档目录名（大小写不敏感）。命中任一就直接收整个目录。 */
const SAVE_DIR_NAMES = [
  'save', 'savedata', 'save data', 'saver', 'saves', 'data', 'profile', 'profiles',
  'sgdata', 'slot', 'slots', 'gamedata', 'system', 'sysdata', 'cfg', 'config',
  'globaldata', 'userdata', 'persistent', 'savedata_win',
]

function collectSaveFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = join(dir, e.name)
      const rel = relative(root, abs)
      if (e.isDirectory()) {
        // 命中文档常见的存档目录：整棵收走
        if (SAVE_DIR_NAMES.includes(e.name.toLowerCase())) {
          collectTree(abs, rel, out)
          continue
        }
        walk(abs, depth + 1)
      } else if (isSaveFile(e.name)) {
        out.push(rel)
      }
    }
  }
  walk(root, 0)
  // 去重（可能被树收集重复收录）
  return [...new Set(out)]
}

/** 递归收集整棵目录树（命中存档目录名后进入） */
function collectTree(dir: string, relStart: string, out: string[]): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const abs = join(dir, e.name)
    const rel = join(relStart, e.name)
    if (e.isDirectory()) collectTree(abs, rel, out)
    else if (e.isFile()) out.push(rel)
  }
}

/** 存档文件扩展名；游戏本体（exe/dll/pak…）绝不进快照 */
const SAVE_EXT_RE = /^.*\.(dat|sav|save|srm|cfg|ini|xml|json|txt|bin|rom|sna|slt|sgo|sfs|qst|mem|rec)$/i
const BIG_BODY_RE = /\.(exe|dll|pak|pck|wad|bin|iso|mp4|avi|webm|png|jpg|jpeg|bmp)$/i

function isSaveFile(name: string): boolean {
  if (BIG_BODY_RE.test(name)) return false
  return SAVE_EXT_RE.test(name) || name.endsWith('.dat')
}

function hashFile(p: string): string {
  const buf = readFileSync(p)
  return createHash('sha1').update(buf).digest('hex')
}

// ---------------------------------------------------------------- 快照列出/恢复/删除

export function listSnapshots(gameId: string): SnapshotInfo[] {
  const dir = gameBackupDir(gameId)
  if (!existsSync(dir)) return []
  const out: SnapshotInfo[] = []
  for (const name of readdirSync(dir)) {
    const dirPath = join(dir, name)
    const metaPath = join(dirPath, 'meta.json')
    if (!existsSync(metaPath)) continue
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as SnapshotMeta
      out.push({
        gameId: meta.gameId,
        title: meta.title,
        dir: meta.dir,
        createdAt: meta.createdAt,
        files: meta.files.length,
        totalBytes: meta.files.reduce((a, f) => a + f.size, 0),
        dirPath,
      })
    } catch {
      continue
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

export function listAllBackups(games: Game[]): BackupStats[] {
  const root = backupRoot()
  if (!existsSync(root)) return []
  const out: BackupStats[] = []
  for (const gameId of readdirSync(root)) {
    const game = games.find((g) => g.id === gameId)
    if (!game) continue
    out.push({
      gameId: game.id,
      title: game.title,
      dir: game.dir,
      enabled: game.backupEnabled === true,
      snapshots: listSnapshots(game.id),
    })
  }
  return out
}

/**
 * 恢复快照：当前存档先挪成 .pre-restore-<ts>（防恢复错找不回），
 * 再把快照文件按清单拷回游戏目录。
 */
export function restoreSnapshot(game: Game, snapshotDir: string): { ok: true; restored: number } | { ok: false; error: string } {
  const metaPath = join(snapshotDir, 'meta.json')
  if (!existsSync(metaPath)) return { ok: false, error: '快照缺少 meta.json' }
  let meta: SnapshotMeta
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8')) as SnapshotMeta
  } catch {
    return { ok: false, error: '快照 meta.json 损坏' }
  }
  if (!existsSync(game.dir)) return { ok: false, error: '游戏目录不存在：' + game.dir }

  const stamp = Date.now()
  let restored = 0
  for (const f of meta.files) {
    const src = join(snapshotDir, f.rel)
    const dst = join(game.dir, f.rel)
    if (!existsSync(src)) continue
    try {
      mkdirSync(dirname(dst), { recursive: true })
      // 当前存档若有，先备份到 .pre-restore 下（只保留最近一份）
      if (existsSync(dst)) {
        const preDir = join(snapshotDir, '..', '.pre-restore-' + stamp)
        // 放到游戏备份目录下的 .pre-restore-<ts>，与快照平行，避免污染游戏目录
        const pre = join(preDir, f.rel)
        mkdirSync(dirname(pre), { recursive: true })
        renameSync(dst, pre)
      }
      copyFileSync(src, dst)
      restored++
    } catch (e) {
      return { ok: false, error: `恢复 ${f.rel} 失败：${e instanceof Error ? e.message : String(e)}` }
    }
  }
  return { ok: true, restored }
}

export function deleteSnapshot(gameId: string, snapshotDir: string): boolean {
  try {
    rmSync(snapshotDir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/** 轮转：每个游戏只保留最近 keep 份快照，删掉更旧的 */
export function rotateSnapshots(gameId: string, keep: number): void {
  const snaps = listSnapshots(gameId)
  if (snaps.length <= keep) return
  for (const s of snaps.slice(keep)) {
    if (s.dirPath) deleteSnapshot(gameId, s.dirPath)
  }
}

// ---------------------------------------------------------------- 云同步（WebDAV）

interface DavEntry {
  href: string
  /** mtime（毫秒） */
  mtime: number
  size: number
}

function davAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
}

/** PROPFIND 列目录。只取文件条目，跳过目录。 */
async function davPropfind(url: string, auth: string, timeoutMs = 10000): Promise<DavEntry[]> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'PROPFIND',
      headers: { Authorization: auth, Depth: '1' },
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`WebDAV 列目录失败 HTTP ${res.status}`)
    const text = await res.text()
    const out: DavEntry[] = []
    const re = /<d:response>([\s\S]*?)<\/d:response>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const body = m[1]
      const hrefM = /<d:href>([^<]+)<\/d:href>/.exec(body)
      const sizeM = /<d:getcontentlength>(\d+)<\/d:getcontentlength>/.exec(body)
      const timeM = /<d:getlastmodified>([^<]+)<\/d:getlastmodified>/.exec(body)
      if (!hrefM) continue
      const href = decodeURIComponent(hrefM[1])
      // 目录条目（href 以 / 结尾）跳过
      if (href.endsWith('/')) continue
      let mtime = 0
      if (timeM) mtime = Date.parse(timeM[1])
      if (!Number.isFinite(mtime) || mtime <= 0) mtime = 0
      out.push({ href, mtime, size: sizeM ? Number(sizeM[1]) : 0 })
    }
    return out
  } finally {
    clearTimeout(t)
  }
}

/** 上传一个文件到 WebDAV（ESCAPED 路径逐段编码，防特殊字符） */
async function davPut(url: string, auth: string, localPath: string, timeoutMs = 30000): Promise<void> {
  const buf = readFileSync(localPath)
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: auth, 'Content-Type': 'application/octet-stream' },
      body: buf,
      signal: ctrl.signal,
    })
    if (!res.ok && res.status !== 201 && res.status !== 204) {
      throw new Error(`WebDAV 上传失败 HTTP ${res.status}`)
    }
  } finally {
    clearTimeout(t)
  }
}

/** 从 WebDAV 下载一个文件 */
async function davGet(url: string, auth: string, localPath: string, timeoutMs = 30000): Promise<void> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: { Authorization: auth }, signal: ctrl.signal })
    if (!res.ok) throw new Error(`WebDAV 下载失败 HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    mkdirSync(dirname(localPath), { recursive: true })
    writeFileSync(localPath, buf)
  } finally {
    clearTimeout(t)
  }
}

/** 确保远端目录存在（MKCOL 幂等：已存在返回 405 也当成功） */
async function davMkcol(url: string, auth: string): Promise<void> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 10000)
  try {
    const res = await fetch(url, { method: 'MKCOL', headers: { Authorization: auth }, signal: ctrl.signal })
    if (res.status !== 201 && res.status !== 405 && !res.ok) {
      throw new Error(`WebDAV 建目录失败 HTTP ${res.status}`)
    }
  } finally {
    clearTimeout(t)
  }
}

function davUrl(bucket: string): string {
  // 合并规范化的 bucket；末尾不带 /
  return bucket.replace(/\/+$/, '')
}

/**
 * 把某游戏的本地快照同步到 WebDAV：两两对比 mtime，新者胜；
 * 同一时刻的冲突两侧都留（本地 .conflict、远端同名覆盖各留一份）。
 * 返回操作计数，errors 收集未成功项。
 */
export async function syncToCloud(
  game: Game,
  cfg: { url: string; user: string; pass: string },
  snapshotDir: string,
): Promise<CloudSyncResult> {
  const base = davUrl(cfg.url)
  const auth = davAuth(cfg.user, cfg.pass)
  const gameDir = `${base}/${encodeURIComponent(sanitizeId(game.id))}`
  const snapName = basename(snapshotDir)
  const remoteDir = `${gameDir}/${encodeURIComponent(snapName)}`
  await davMkcol(gameDir, auth)
  await davMkcol(remoteDir, auth)

  const result: CloudSyncResult = { uploaded: 0, downloaded: 0, errors: [] }
  const localFiles = collectLocalSnapshotFiles(snapshotDir)
  const remoteFiles = await davPropfind(remoteDir, auth).catch((e: unknown) => {
    result.errors.push(e instanceof Error ? e.message : String(e))
    return []
  })
  // href 是 URL（/ 分隔），不能用 node:path basename（Windows 下按 \ 切，整条 URL 拿不到文件名）
  const remoteByRel = new Map(remoteFiles.map((r) => [r.href.slice(r.href.lastIndexOf('/') + 1), r]))

  for (const rel of localFiles) {
    const localPath = join(snapshotDir, rel)
    const localMtime = statSync(localPath).mtimeMs
    const remote = remoteByRel.get(rel)
    const remoteUrl = `${remoteDir}/${encodeURIComponent(rel)}`
    try {
      if (!remote) {
        await davPut(remoteUrl, auth, localPath)
        result.uploaded++
        continue
      }
      // 两端都有：mtime 新者胜
      if (localMtime > remote.mtime) {
        await davPut(remoteUrl, auth, localPath)
        result.uploaded++
      } else if (remote.mtime > localMtime) {
        // 远端较新 → 拉下来（冲突：保留本地为 .conflict）
        const conflictPath = join(snapshotDir, rel + '.conflict-' + Date.now())
        await davGet(remoteUrl, auth, conflictPath)
        result.downloaded++
      }
      // 同一时刻且哈希一致：跳过
    } catch (e) {
      result.errors.push(`${rel}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return result
}

/** 列出某快照目录下的相对文件路径（含 meta.json） */
function collectLocalSnapshotFiles(snapshotDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) walk(abs)
      else if (e.isFile()) out.push(relative(snapshotDir, abs))
    }
  }
  walk(snapshotDir)
  return out
}