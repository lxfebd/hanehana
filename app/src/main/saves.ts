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
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { BackupStats, CloudSyncResult, Game, SnapshotInfo, SnapshotMeta, SnapshotSkipEntry } from '../shared/types'
import { isSaveFile, webdavUrlError, relToRemote, bigBodyRe } from './saveRules'
import { dataDir } from './store'
import { sha1File } from '../shared/sha1File'
import { SNAPSHOT_MAX_FILE_BYTES, SNAPSHOT_MAX_TOTAL_BYTES } from '../shared/snapshotLimits'
import { orderForBudget } from '../shared/snapshotBudget'

// ---------------------------------------------------------------- 类型

// meta.json 的落盘形状收在 shared/types（渲染层/主进程共用一份真值）。
// 原先这里自带一份重复的 SnapshotMeta：两处定义迟早改一处忘一处，落盘与
// 读取各信一种形状，所以只留 shared 那份，在本模块 re-export 维持旧导出面。
export type { SnapshotMeta, SnapshotSkipEntry }

// ---------------------------------------------------------------- 快照闸门

// 闸门真值在 shared/snapshotLimits.ts（为什么搬出去见那里的注释：渲染层的
// 提示文案要插同一组数字）。这里 re-export 保持既有导入面——saves.ts 一直
// 是这两个常量的对外出口，别处 import 不用跟着动。
export { SNAPSHOT_MAX_FILE_BYTES, SNAPSHOT_MAX_TOTAL_BYTES }

// ---------------------------------------------------------------- 路径

/** 数据目录稳定引用（进程内不变） */
const DATA_DIR = dataDir()

export function backupRoot(): string {
  // join 而不是手拼 '\\'：dataDir() 在 HANEHANA_DATA_DIR 覆盖下可能是 POSIX 路径
  // （测试缝/便携模式），硬编码反斜杠会拼出混分隔符的路径。
  return join(DATA_DIR, 'backups')
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
 * 最终以 meta.json 里的 files 清单为准，恢复时按清单回拷；没进 files 的
 * 文件一律在 skipped[] 里留痕（超大/超预算/不可读），不允许静默消失。
 */
export function createSnapshot(game: Game, dest?: string): SnapshotInfo | null {
  const srcDir = game.dir
  if (!srcDir || !existsSync(srcDir)) return null
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = dest ?? join(gameBackupDir(game.id), ts)
  mkdirSync(outDir, { recursive: true })

  // 收集要备份的文件（相对 srcDir 的路径）。
  // 先按 rel 字典序排一遍：收集顺序来自 readdir，NTFS 上恰好近字典序但没有
  // 契约；stat 失败的文件也要按确定性顺序进 skipped，否则同一份目录两次快照
  // 的 skipped 清单顺序都可能变（预算顺序另由 orderForBudget 决定，见下）。
  const rels = collectSaveFiles(srcDir).sort()

  const files: SnapshotMeta['files'] = []
  const skipped: SnapshotSkipEntry[] = []
  let totalBytes = 0

  // 第一遍只量体积：预算分配要按体积排序（小文件优先），排序前必须知道每个
  // 文件多大。stat 失败的文件在量体积时就留痕，不参与排序。
  const sized: { rel: string; size: number }[] = []
  for (const rel of rels) {
    let st: Stats
    try {
      st = statSync(join(srcDir, rel))
      if (!st.isFile()) continue
    } catch {
      // 连 stat 都失败（刚被删/无权限）：也要留痕，不能静默消失
      skipped.push({ rel, size: 0, reason: 'unreadable' })
      continue
    }
    sized.push({ rel, size: st.size })
  }

  // 预算分配顺序：小文件优先，同尺寸按 rel（规则与理由见 shared/snapshotBudget.ts）。
  // 为什么不沿用「按 rel 字典序先到先得」：data\*.dat 排在 save\*.sav 前面时，
  // 资源包会把 2GiB 预算吃满、真存档全部 reason:'budget'，界面却显示备份成功。
  // 也不能按用途黑名单（.dat 既是存档扩展名又常被资源包占用），体积是唯一
  // 不需要新名单的判据。
  for (const { rel, size } of orderForBudget(sized)) {
    // 闸门一（单文件 200MB）：超限的不进快照本体，进 skipped[] 留痕。
    // 这不是「丢件」——文件仍被显式记录、UI 会提示缺了哪些；把它整份拷进
    // 每个快照才是真正的涨盘（全量拷贝 × 保留份数）。
    if (size > SNAPSHOT_MAX_FILE_BYTES) {
      skipped.push({ rel, size, reason: 'oversize' })
      continue
    }
    // 闸门二（单次快照总量 2GiB）：已拷字节 + 本文件超预算就留痕跳过。
    // 被闸门一拦下的不占预算（它们本来就不会拷入本体）。
    if (totalBytes + size > SNAPSHOT_MAX_TOTAL_BYTES) {
      skipped.push({ rel, size, reason: 'budget' })
      continue
    }
    const abs = join(srcDir, rel)
    const dst = join(outDir, rel)
    try {
      mkdirSync(dirname(dst), { recursive: true })
      copyFileSync(abs, dst)
      // 拷贝成功才进 files 清单：旧实现先 push 清单再拷贝，拷贝失败时清单
      // 里有它、快照里没有——恢复按清单回拷不存在的文件，又是一次「报告
      // 成功、实际少文件」。摘要（sha1）只供人工核对，算不出来不阻止备份。
      let sha1 = ''
      try {
        sha1 = sha1File(abs)
      } catch {
        /* 摘要失败不阻止备份（文件本体已拷入） */
      }
      files.push({ rel, size, sha1 })
      totalBytes += size
    } catch {
      // 单文件被占用/磁盘满/权限：先清掉可能写了一半的目标文件再留痕。
      // 半截残件比没有更糟——恢复和云同步都会把它当完整文件。
      try {
        rmSync(dst, { force: true })
      } catch {
        /* 清不掉就留着；skipped 清单仍是事实来源 */
      }
      skipped.push({ rel, size, reason: 'unreadable' })
      continue
    }
  }
  if (skipped.length > 0) {
    console.warn(`[hanehana] 存档快照跳过 ${skipped.length} 个文件（超大/超预算/不可读），明细见 meta.json 的 skipped`)
  }

  const createdAt = Date.now()
  const meta: SnapshotMeta = {
    gameId: game.id,
    title: game.title,
    dir: srcDir,
    createdAt,
    files,
    // 空清单也固定写 skipped: []：落盘形状稳定。旧版 meta 没有该字段，
    // 读取侧一律 Array.isArray 兜底（见 listSnapshots/restoreSnapshot），不能崩。
    skipped,
  }
  if (files.length === 0) {
    // 一个文件都没备份到：目录里可能全是本体。还是留个 meta 说明，避免恢复时空目录
    meta.note = 'no save files found'
  }
  writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')
  return {
    gameId: game.id,
    title: game.title,
    dir: srcDir,
    createdAt,
    files: files.length,
    totalBytes,
    dirPath: outDir,
    // 跳过摘要（数量/字节）：上层据此提示「N 个文件未纳入快照（共 X）」。
    // 0 也要给出来，调用方只需判断 > 0。
    skippedCount: skipped.length,
    skippedBytes: skipped.reduce((a, s) => a + s.size, 0),
  }
}

/** 常见 galgame 存档目录名（大小写不敏感）。命中任一就直接收整个目录。 */
const SAVE_DIR_NAMES = [
  'save',
  'savedata',
  'save data',
  'saver',
  'saves',
  'data',
  'profile',
  'profiles',
  'sgdata',
  'slot',
  'slots',
  'gamedata',
  'system',
  'sysdata',
  'cfg',
  'config',
  'globaldata',
  'userdata',
  'persistent',
  'savedata_win',
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

/** 递归收集整棵目录树（命中存档目录名后进入）。仍要按扩展名过滤：
 *  存档目录可能就建在游戏本体旁（save\ 隔壁就是 .exe），整棵收走会把
 *  几百 MB 的本体文件塞进快照，备份目录瞬间爆炸。 */
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
    else if (e.isFile() && !bigBodyRe.test(e.name)) out.push(rel)
  }
}

// 哈希实现见 shared/sha1File.ts：1 MiB 分块，内存与文件大小无关，
// 因此这里不再有「超过多少 MB 就不备份」的分支。

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
      // 旧版 meta 没有 skipped 字段（也可能被手改/导入坏）：缺了就是「没有跳过」，
      // 读旧快照绝不能崩；files 同理做类型兜底。
      const files = Array.isArray(meta.files) ? meta.files : []
      const skipped = Array.isArray(meta.skipped) ? meta.skipped : []
      out.push({
        gameId: meta.gameId,
        title: meta.title,
        dir: meta.dir,
        createdAt: meta.createdAt,
        files: files.length,
        totalBytes: files.reduce((a, f) => a + (f?.size ?? 0), 0),
        dirPath,
        // 列表页也能看见「这份快照不是全集」，而不只是创建那一刻的返回值和提示
        skippedCount: skipped.length,
        skippedBytes: skipped.reduce((a, s) => a + (s?.size ?? 0), 0),
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
 * rel 是否落在 root 子树内。
 *
 * f.rel 来自快照目录里的 meta.json（可能被篡改/损坏/从不可信来源导入）：
 * 每个 rel 必须 resolve 后仍落在快照目录与游戏目录内才放行，`../`/绝对路径/
 * 空串一律拒绝——否则一次恢复就能把任意文件写到游戏目录之外（路径穿越写）。
 */
function isRelInside(root: string, rel: string): boolean {
  if (!rel || typeof rel !== 'string') return false
  const full = resolve(join(root, rel))
  const base = resolve(root)
  // startsWith(base + sep) 已保证 full 落在 root 子树内；`full !== base` 是
  // 显式的「不能等于根目录本身」（防 rel 为 '' 时空转）。原来的
  // `full.length > base.length + sep.length - 1` 是恒真死条件（startsWith
  // 更长的前缀必然更长），删掉避免误导。
  return full.startsWith(base + sep) && full !== base
}

/**
 * 恢复快照：当前存档先挪成 .pre-restore-<ts>（防恢复错找不回），
 * 再把快照文件按清单拷回游戏目录。
 *
 * 返回值带 skippedCount/skippedBytes：恢复只回拷 files 清单里的文件，
 * 快照创建时被闸门拦下的那些不会凭空出现——渲染层据此在成功提示里补一句，
 * 免得用户以为「恢复完 = 全部拿回来了」。
 *
 * 清单校验是**全量前置**的：files 非数组、或任一条 rel 类型/限域不合法都
 * 立刻返回错误且不动盘。恢复写的是用户存档目录，校验必须发生在第一个字节
 * 写下之前（边校验边写会把游戏目录留在半恢复状态，还绕过回滚台账）。
 */
export function restoreSnapshot(
  game: Game,
  snapshotDir: string,
): { ok: true; restored: number; skippedCount: number; skippedBytes: number } | { ok: false; error: string } {
  const metaPath = join(snapshotDir, 'meta.json')
  if (!existsSync(metaPath)) return { ok: false, error: '快照缺少 meta.json' }
  let meta: SnapshotMeta
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8')) as SnapshotMeta
  } catch {
    return { ok: false, error: '快照 meta.json 损坏' }
  }
  if (!existsSync(game.dir)) return { ok: false, error: '游戏目录不存在：' + game.dir }

  // 先全量校验清单，再动盘。
  // 旧实现是「边校验边写」：循环里遇到非法 rel 才 return {ok:false}，可前面几条
  // 已经 rename/覆盖过了，而且这条失败路径**绕过了回滚台账**（rolled 只在
  // copyFileSync 的 catch 里用）——游戏目录停在半恢复状态，用户还被告知失败。
  // 现在把「类型 + 双重限域」全部前置：任何一条不合法就立刻返回，一个字节都不写。
  if (!Array.isArray(meta.files)) {
    // files 不是数组 = meta.json 被改坏/导入不完整。旧实现当空清单处理，
    // 返回 ok:true, restored:0 —— 用户看到「恢复成功」，实际什么都没恢复。
    return { ok: false, error: '快照清单损坏' }
  }
  const files = meta.files
  for (const f of files) {
    // 条目结构不对（null / rel 不是字符串）：清单损坏，宁可整批拒绝也不猜。
    if (!f || typeof f.rel !== 'string') return { ok: false, error: '快照清单损坏' }
    // 双重限域：src 必须真的在快照目录里、dst 必须真的在游戏目录里
    if (!isRelInside(snapshotDir, f.rel) || !isRelInside(game.dir, f.rel)) {
      return { ok: false, error: `快照清单含非法路径：${f.rel}` }
    }
  }

  const stamp = Date.now()
  const preDir = join(snapshotDir, '..', '.pre-restore-' + stamp)
  let restored = 0
  // 回滚台账：已处理的文件按顺序记录（先 rename 原档走、再拷入新档）。
  // 中途失败（磁盘满/权限）时逆序回滚：删掉已拷入的新档、把原档 rename 回来，
  // 让游戏目录回到恢复前的状态——不做的话快照会停在「半恢复」的坏状态。
  const rolled: { dst: string; pre: string | null }[] = []
  // 快照本来就少了文件（meta.skipped）：恢复只按 files 清单回拷，用户最需要
  // 知道的是「没全拿回来」。摘要随返回值带出去，渲染层在成功提示里补一句——
  // 只读 meta.json 既有字段，不改落盘 schema（旧快照没有 skipped 就是 0）。
  const skipped = Array.isArray(meta.skipped) ? meta.skipped : []
  const skippedBytes = skipped.reduce((a, s) => a + (s?.size ?? 0), 0)
  for (const f of files) {
    const src = join(snapshotDir, f.rel)
    const dst = join(game.dir, f.rel)
    if (!existsSync(src)) continue
    try {
      mkdirSync(dirname(dst), { recursive: true })
      // 当前存档若有，先备份到 .pre-restore 下（与快照平行，避免污染游戏目录）
      let pre: string | null = null
      if (existsSync(dst)) {
        pre = join(preDir, f.rel)
        mkdirSync(dirname(pre), { recursive: true })
        renameSync(dst, pre)
      }
      copyFileSync(src, dst)
      restored++
      rolled.push({ dst, pre })
    } catch (e) {
      // 回滚已处理项（逆序）：删新档、还原原档。任何一步再失败也不致命——
      // .pre-restore 里的原档副本还在，用户仍能手动找回，比无视回滚强。
      const mainErr = `恢复 ${f.rel} 失败：${e instanceof Error ? e.message : String(e)}`
      const rollbackErrs: string[] = []
      for (const r of rolled.reverse()) {
        try {
          if (existsSync(r.dst)) rmSync(r.dst, { force: true })
          if (r.pre && existsSync(r.pre)) {
            mkdirSync(dirname(r.dst), { recursive: true })
            renameSync(r.pre, r.dst)
          }
        } catch (re) {
          rollbackErrs.push(`${r.dst}: ${re instanceof Error ? re.message : String(re)}`)
        }
      }
      return rollbackErrs.length
        ? { ok: false, error: `${mainErr}（回滚也不完全：${rollbackErrs.join('；')}，原档在 ${preDir}）` }
        : { ok: false, error: mainErr }
    }
  }
  return { ok: true, restored, skippedCount: skipped.length, skippedBytes }
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
  /** WebDAV getetag（内容指纹）。多数服务端返回带引号的 etag，取不到为 undefined。 */
  etag?: string
}

function davAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
}

/** PROPFIND 列目录：递归收集所有文件条目（子目录逐层下钻）。
 *  Depth:1 + 按 <d:href> 后缀识别目录再下钻：Depth:infinity 各服务端支持不一，
 *  逐层是兼容性最稳的写法。href 是 URL 编码的，解码后按「/」切末段取文件名。 */
async function davPropfind(url: string, auth: string, timeoutMs = 10000): Promise<DavEntry[]> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const parse = (text: string): { files: DavEntry[]; dirs: string[] } => {
      const files: DavEntry[] = []
      const dirs: string[] = []
      const re = /<d:response>([\s\S]*?)<\/d:response>/g
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        const body = m[1]
        const hrefM = /<d:href>([^<]+)<\/d:href>/.exec(body)
        const sizeM = /<d:getcontentlength>(\d+)<\/d:getcontentlength>/.exec(body)
        const timeM = /<d:getlastmodified>([^<]+)<\/d:getlastmodified>/.exec(body)
        if (!hrefM) continue
        const href = decodeURIComponent(hrefM[1])
        if (href.endsWith('/')) {
          dirs.push(href)
          continue
        }
        let mtime = 0
        if (timeM) mtime = Date.parse(timeM[1])
        if (!Number.isFinite(mtime) || mtime <= 0) mtime = 0
        const etagM = /<d:getetag>([^<]+)<\/d:getetag>/.exec(body)
        files.push({ href, mtime, size: sizeM ? Number(sizeM[1]) : 0, etag: etagM?.[1] ?? undefined })
      }
      return { files, dirs }
    }
    const res = await fetch(url, {
      method: 'PROPFIND',
      headers: { Authorization: auth, Depth: '1' },
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`WebDAV 列目录失败 HTTP ${res.status}`)
    // PROPFIND 响应（XML 目录清单）同样加大小上限：不可信/误配置的服务端
    // 可能返回超大 body，一次 text() 全量进内存是内存炸弹。
    const contentLength = Number(res.headers.get('content-length') ?? 0)
    if (contentLength > MAX_DAV_BYTES) throw new Error('WebDAV 列目录响应超过大小上限')
    const text = await res.text()
    if (text.length > MAX_DAV_BYTES) throw new Error('WebDAV 列目录响应超过大小上限')
    const first = parse(text)
    const out = [...first.files]
    // 逐层下钻目录：同一 URL 前缀下再列一次（base 末尾不带 /）
    for (const d of first.dirs) {
      try {
        const nested = await davPropfind(d, auth, timeoutMs)
        out.push(...nested)
      } catch {
        // 单层失败不整批放弃：这层列不出来就当它不存在，其余照常同步
      }
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

/** 从 WebDAV 下载一个文件：流式写盘 + 大小上限，防止不可信服务端一次
 *  arrayBuffer() 灌爆主进程内存（对齐 scraper.readBodyCapped 的范式）。 */
async function davGet(url: string, auth: string, localPath: string, timeoutMs = 30000): Promise<void> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: { Authorization: auth }, signal: ctrl.signal })
    if (!res.ok) throw new Error(`WebDAV 下载失败 HTTP ${res.status}`)
    const body = res.body
    if (!body) throw new Error('WebDAV 下载失败：响应无内容')
    // 本地快照文件本就不大（存档级），64MB 上限足够宽；流式写避免整读进内存。
    mkdirSync(dirname(localPath), { recursive: true })
    await writeStreamCapped(body, localPath, MAX_DAV_BYTES)
  } finally {
    clearTimeout(t)
  }
}

/** WebDAV 单文件/单响应大小上限。 */
const MAX_DAV_BYTES = 64 * 1024 * 1024

/** 把响应流写入本地文件，超过上限即中止（内容不可信时不能全量进内存）。 */
async function writeStreamCapped(body: ReadableStream<Uint8Array>, dest: string, max: number): Promise<void> {
  const reader = body.getReader()
  const ws = createWriteStream(dest)
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > max) throw new Error('WebDAV 响应超过大小上限，已中止')
      if (!ws.write(Buffer.from(value))) {
        await new Promise<void>((r) => ws.once('drain', r))
      }
    }
    await new Promise<void>((resolve, reject) => {
      ws.end(() => {
        ws.off('error', reject)
        resolve()
      })
      ws.on('error', reject)
    })
  } catch (e) {
    try {
      ws.destroy()
    } catch {
      /* 清理失败忽略 */
    }
    throw e
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

/**
 * 确保文件的远端父目录全部存在：从已建好的 remoteDir 一路向下把缺的层级
 * 逐层 MKCOL 出来，返回目标文件 URL（与传入一致）。PROPFIND 只列文件、快照
 * 嵌套目录又很常见，PUT 前不建父目录多数服务端直接 409。
 */
async function davEnsurePath(fileUrl: string, auth: string, gameDir: string, remoteDir: string): Promise<string> {
  // fileUrl 形如 <remoteDir>/<encodeURIComponent(key)>，key 内的 / 已逐段编码，
  // 这里按未编码的「/」切段重建目录链
  const tail = fileUrl.slice(remoteDir.length).replace(/^\//, '')
  const parts = tail.split('/')
  let acc = remoteDir
  for (let i = 0; i < parts.length - 1; i++) {
    acc += '/' + parts[i]
    if (acc !== gameDir && acc !== remoteDir) await davMkcol(acc, auth)
  }
  return fileUrl
}

/**
 * 云同步（WebDAV）：把某游戏的本地快照双向同步到远端。
 *
 * 本地文件是递归收集的（rel 在 Windows 下带反斜杠如 `sub\cfg.dat`），远端用
 * 正斜杠相对路径作键（`sub/cfg.dat`）。PROPFIND 只列顶层（Depth:1），嵌套目录
 * 必须逐层下钻，否则 `remoteByRel` 永远对不上嵌套文件——每轮同步都会无条件
 * 重复上传、mtime 冲突判定从不生效、远端被 `%5C` 压平（部分服务端拒收这种
 * 文件名）。所以：列目录按层递归 + 键用 `/` 归一 + PUT 前逐层建目录。
 */
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
  // 传输侧闸门：http:// 的 WebDAV（除本机回环）直接拒绝，不发起任何请求。
  // Basic 凭据明文走网络是数据泄露，宁可同步失败也不能把密码送出去。
  const protoErr = webdavUrlError(cfg.url)
  if (protoErr) {
    return { uploaded: 0, downloaded: 0, errors: [protoErr] }
  }
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
  // 远端键用「相对 remoteDir 的正斜杠路径」而不是 basename：本地 rel 是递归
  // 收集的（Windows 下带反斜杠），basename 键会让嵌套文件永远匹配不上。
  // href 是 URL 编码的整条地址，先解码再去掉 remoteDir 前缀。
  const remotePrefix = remoteDir + '/'
  const remoteByRel = new Map(
    remoteFiles.filter((r) => r.href.startsWith(remotePrefix)).map((r) => [r.href.slice(remotePrefix.length), r]),
  )

  for (const rel of localFiles) {
    const localPath = join(snapshotDir, rel)
    // 本地 mtimeMs 是毫秒精度、远端 getlastmodified（HTTP-date）只有秒级——
    // 不取整到秒的话，同内容的文件本地几乎恒比远端「新」，每轮同步都无条件
    // 重传、还会来回拉锯（上传后远端新值又反向判定「远端新」）。
    const localMtime = Math.floor(statSync(localPath).mtimeMs / 1000) * 1000
    const remoteKey = relToRemote(rel)
    const remote = remoteByRel.get(remoteKey)
    // 子目录里没有目录条目（davPropfind 只收文件），PUT 前必须逐层建目录，
    // 否则多数 WebDAV 服务端对不存在的父目录直接 409。
    // 嵌套 rel（`sub/cfg.dat`）必须逐段编码：整串 encodeURIComponent 会把
    // `/` 编成 `%2F`，davEnsurePath 按未编码的 `/` 切段就分不出层级、父目录
    // 建不出来（多数服务端 PUT 409，部分把 %2F 当平级文件名压平）。
    const remoteUrl = await davEnsurePath(
      `${remoteDir}/${remoteKey.split('/').map(encodeURIComponent).join('/')}`,
      auth,
      gameDir,
      remoteDir,
    )
    try {
      if (!remote) {
        await davPut(remoteUrl, auth, localPath)
        result.uploaded++
        continue
      }
      // 两端都有：mtime 新者胜。
      if (localMtime > remote.mtime) {
        await davPut(remoteUrl, auth, localPath)
        result.uploaded++
      } else if (remote.mtime > localMtime) {
        // 远端较新 → 拉下来（冲突：保留本地为 .conflict）
        const conflictPath = join(snapshotDir, rel + '.conflict-' + Date.now())
        await davGet(remoteUrl, auth, conflictPath)
        result.downloaded++
      }
      // 同一时刻：跳过。快照目录在生成后不再变化，两端 mtime 相等 = 内容一致；
      // 这里不做全文件哈希比对——同步跑在每轮备份里，对快照里所有文件逐字节
      // 读一遍会把「几 MB 快照」放大成「每次同步重读全部内容」。mtime 秒级精度
      // 下「同一秒两端各改一次且内容不同」的窗口极小，真有这种需求应改用 etag。
    } catch (e) {
      result.errors.push(`${rel}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return result
}

/** 列出某快照目录下的相对文件路径（含 meta.json）。
 *  内部标记文件（.conflict-* / .pre-restore-*）不进清单：它们是冲突/恢复过程的
 *  副产物，收集进来会被反复上传到远端、又被下一次恢复当普通文件处理。 */
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
      if (e.isDirectory()) {
        // .pre-restore 是恢复前备份目录，不在快照内
        if (e.name.startsWith('.pre-restore-')) continue
        walk(abs)
      } else if (e.isFile() && !/\.conflict-\d+$/.test(e.name)) {
        out.push(relative(snapshotDir, abs))
      }
    }
  }
  walk(snapshotDir)
  return out
}
