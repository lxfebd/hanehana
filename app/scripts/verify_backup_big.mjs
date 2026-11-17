// 存档备份「不丢件、不涨盘」回归靶（M1）。
//
// 断言链（真实 Electron + 真实 IPC，不是单元桩）：
//  1. save/big.dat（210MB 稀疏文件）不进快照本体 → 它出现在 meta.json 的
//     skipped[] 里（reason='oversize'、size 对得上），且快照目录下确实没有它；
//  2. save/slot1.sav（小存档）照常全量拷贝 → files[] 里有它、快照目录里有它；
//  3. backupCreate 的返回值能看出「有跳过」：skippedCount / skippedBytes；
//  4. backupsList（列表读取路径）同样读得到跳过摘要——旧 meta 没有 skipped
//     字段时按 0 兜底、不能崩。
//
// 为什么用 ftruncate 造 210MB：要真实触发 200MB 单文件闸门，但为一个「一定
// 会被跳过」的文件真写 210MB 数据既慢又费盘；ftruncateSync 只改文件长度。
//
// 自包含：独立 DATA_DIR + seed_layout 造库，跑完清理（Windows 句柄可能还占着
// chromium 目录，带退避重试）。
// 用法（从 app/ 或仓库根目录都行）：
//   node scripts/verify_backup_big.mjs
//   node app/scripts/verify_backup_big.mjs
import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { killTree, pickFreePort } from './lib/probePort.mjs'

// 从脚本位置推 APP_ROOT：既支持 `node scripts/verify_backup_big.mjs`（cwd=app/），
// 也支持仓库根目录调 `node app/scripts/verify_backup_big.mjs`——不能信 process.cwd()。
const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = await pickFreePort()
const DATA_DIR = join(APP_ROOT, '.backup-big-data')
const GAME_ID = 'g1'
const BIG_REL = 'save/big.dat'
const SMALL_REL = 'save/slot1.sav'
const BIG_BYTES = 210 * 1024 * 1024
const SMALL_BYTES = 4096

let proc = null
let stderr = ''
let pass = 0
let fail = 0

function ck(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  [PASS] ${name}`)
  } else {
    fail++
    process.exitCode = 1
    console.log(`  [FAIL] ${name}${extra ? ' :: ' + extra : ''}`)
  }
}

/** 相对路径归一：meta 里的 rel 在 Windows 下是反斜杠，断言统一按正斜杠比。 */
function normRel(p) {
  return String(p ?? '')
    .split('\\')
    .join('/')
}

/** 删临时目录并退避重试：Electron 刚退出时 chromium 子进程可能还占着句柄。 */
async function rmRetry(p, tries = 10) {
  for (let i = 0; i < tries; i++) {
    try {
      rmSync(p, { recursive: true, force: true })
      return true
    } catch {
      /* 句柄未释放，等一轮再试 */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

/**
 * 主进程产物是否比改动过的源码新。为什么靶子要自检构建：这个靶断言的是
 * 「真实主进程」的行为，拿旧的 out/ 去跑，绿的全是老代码——那是假绿。
 * 只在缺失/过期时构建，连跑第二次不会触发。
 */
function ensureBuilt() {
  const out = join(APP_ROOT, 'out', 'main', 'index.js')
  const sources = [
    'src/main/saves.ts',
    'src/main/ipc/backup.ts',
    'src/shared/types.ts',
    'src/renderer/components/BackupDialog.vue',
  ]
  let newest = 0
  for (const rel of sources) {
    try {
      newest = Math.max(newest, statSync(join(APP_ROOT, rel)).mtimeMs)
    } catch {
      /* 源文件缺失交给构建阶段报错 */
    }
  }
  const built = existsSync(out) ? statSync(out).mtimeMs : 0
  if (built > 0 && built > newest) return
  console.log('[build] out/ 缺失或比源码旧 → npm run build')
  const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/c', 'npm run build'], {
    cwd: APP_ROOT,
    stdio: 'inherit',
  })
  if (r.status !== 0) throw new Error('npm run build 失败')
}

function waitExit(p, ms = 8000) {
  return new Promise((resolve) => {
    if (!p || p.exitCode !== null) return resolve()
    const t = setTimeout(resolve, ms)
    p.once('exit', () => {
      clearTimeout(t)
      resolve()
    })
  })
}

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)
    if (m) return m[1]
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('no DevTools line')
}

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const to = setTimeout(() => reject(new Error('ws timeout')), 10000)
    ws.onopen = () => {
      clearTimeout(to)
      resolve(ws)
    }
    ws.onerror = () => reject(new Error('ws error'))
  })
}

async function main() {
  // 0) 清理上次残留（崩溃时可能留下被占用的 chromium 目录）
  await rmRetry(DATA_DIR)
  mkdirSync(DATA_DIR, { recursive: true })

  // 1) 造种子库（12 款游戏；只用第一款）
  const seed = spawnSync(process.execPath, [join(APP_ROOT, 'scripts', 'seed_layout.mjs'), DATA_DIR], {
    cwd: APP_ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  if (seed.status !== 0) throw new Error('seed_layout.mjs 失败')

  // 2) 把第一款游戏指向真实目录：seed 里的 dir 是虚构的 D:\Galgame\...，
  //    不改的话 createSnapshot 会因「游戏目录不存在」直接返回 null。
  const gamesPath = join(DATA_DIR, 'games.json')
  const games = JSON.parse(readFileSync(gamesPath, 'utf8'))
  const game = games.find((g) => g.id === GAME_ID) ?? games[0]
  if (!game) throw new Error('seed 里没有游戏')
  const gameDir = join(DATA_DIR, 'games', game.id)
  game.dir = gameDir
  game.backupEnabled = true
  writeFileSync(gamesPath, JSON.stringify(games, null, 2), 'utf8')

  // 3) 造两个存档：210MB 稀疏大文件（触发单文件闸）+ 小文件（必须照常拷贝）
  mkdirSync(join(gameDir, 'save'), { recursive: true })
  const fd = openSync(join(gameDir, BIG_REL), 'w')
  try {
    ftruncateSync(fd, BIG_BYTES)
  } finally {
    closeSync(fd)
  }
  writeFileSync(join(gameDir, SMALL_REL), Buffer.alloc(SMALL_BYTES, 7))
  if (statSync(join(gameDir, BIG_REL)).size !== BIG_BYTES) throw new Error('稀疏大文件尺寸不对')

  ensureBuilt()

  const electronBin = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  if (!existsSync(electronBin)) throw new Error('找不到 electron: ' + electronBin)
  const env = {
    ...process.env,
    HANEHANA_DEBUG_PORT: String(PORT),
    HANEHANA_DATA_DIR: DATA_DIR,
    HANEHANA_NO_OS_FULLSCREEN: '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  proc = spawn(electronBin, ['.'], {
    cwd: APP_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  proc.stderr.on('data', (d) => (stderr += d.toString()))
  proc.stdout.on('data', () => {})

  const wsUrl = await getWsUrl()
  await new Promise((r) => setTimeout(r, 2500))
  const port = (wsUrl.match(/:(\d+)\//) || [])[1]
  let pageJson = null
  for (let i = 0; i < 20 && !pageJson; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      pageJson = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
    } catch {
      /* retry */
    }
    if (!pageJson) await new Promise((r) => setTimeout(r, 500))
  }
  if (!pageJson) throw new Error('no page target')

  const ws = await connectWs(pageJson.webSocketDebuggerUrl)
  let msgId = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const mid = ++msgId
      pending.set(mid, res)
      ws.send(JSON.stringify({ id: mid, method, params }))
      setTimeout(() => {
        if (pending.has(mid)) {
          pending.delete(mid)
          rej(new Error('cdp timeout: ' + method))
        }
      }, 60000)
    })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) {
      throw new Error('eval failed: ' + String(r.result.exceptionDetails.exception?.description ?? expr))
    }
    return r.result?.result?.value
  }

  try {
    // 等 preload 桥就绪（渲染层 boot 完成前 window.hh 还不存在）
    for (let i = 0; i < 60; i++) {
      if ((await ev('!!(window.hh && window.hh.backupCreate)')) === true) break
      await new Promise((r) => setTimeout(r, 250))
    }
    ck('preload 桥就绪', (await ev('!!(window.hh && window.hh.backupCreate)')) === true)

    // 真实 IPC：走 window.hh.backupCreate（主进程 createSnapshot 同步跑）
    const snap = await ev(`window.hh.backupCreate(${JSON.stringify(game.id)})`)
    ck(
      'backupCreate 返回快照信息',
      snap && typeof snap === 'object' && typeof snap.dirPath === 'string' && !('error' in snap),
      JSON.stringify(snap).slice(0, 300),
    )
    if (!snap || typeof snap.dirPath !== 'string') throw new Error('备份没有产出快照，后续断言无法进行')

    // 返回值摘要：数量 + 字节（渲染层据此提示）
    ck('返回值带跳过数量', snap.skippedCount === 1, `skippedCount=${snap.skippedCount}`)
    ck('返回值带跳过字节数（210MB）', snap.skippedBytes === BIG_BYTES, `skippedBytes=${snap.skippedBytes}`)
    ck(
      '小存档照常进快照（files/totalBytes）',
      snap.files === 1 && snap.totalBytes === SMALL_BYTES,
      `files=${snap.files} totalBytes=${snap.totalBytes}`,
    )

    // meta.json 落盘断言
    const meta = JSON.parse(readFileSync(join(snap.dirPath, 'meta.json'), 'utf8'))
    const skipped = Array.isArray(meta.skipped) ? meta.skipped : []
    const bigEntry = skipped.find((s) => normRel(s && s.rel) === BIG_REL)
    ck('meta.skipped 含 save/big.dat', !!bigEntry, JSON.stringify(skipped))
    ck('大文件 reason=oversize', !!bigEntry && bigEntry.reason === 'oversize', `reason=${bigEntry && bigEntry.reason}`)
    ck('大文件 size=210MB', !!bigEntry && bigEntry.size === BIG_BYTES, `size=${bigEntry && bigEntry.size}`)
    ck(
      '大文件没有被复制进快照目录',
      !existsSync(join(snap.dirPath, 'save', 'big.dat')),
      'save/big.dat 竟出现在快照目录',
    )
    const files = Array.isArray(meta.files) ? meta.files : []
    const smallEntry = files.find((f) => normRel(f && f.rel) === SMALL_REL)
    ck('meta.files 含 save/slot1.sav', !!smallEntry, JSON.stringify(files.map((f) => normRel(f && f.rel))))
    ck('小存档已复制进快照目录', existsSync(join(snap.dirPath, 'save', 'slot1.sav')))
    ck('大文件不在 files 清单里', !files.some((f) => normRel(f && f.rel) === BIG_REL))

    // 列表读取路径：旧 meta 没有 skipped 字段也不能崩，新 meta 要能读出摘要
    const list = await ev('window.hh.backupsList()')
    const stat = Array.isArray(list) ? list.find((b) => b.gameId === game.id) : null
    const listed = stat && Array.isArray(stat.snapshots) ? stat.snapshots[0] : null
    ck(
      'backupsList 能读到跳过摘要',
      !!listed && listed.skippedCount === 1 && listed.skippedBytes === BIG_BYTES,
      JSON.stringify(listed && { skippedCount: listed.skippedCount, skippedBytes: listed.skippedBytes }),
    )
    ck(
      '列表里的快照体量只含小存档',
      !!listed && listed.totalBytes === SMALL_BYTES,
      `totalBytes=${listed && listed.totalBytes}`,
    )

    console.log(
      `  skipped=${skipped.length} big.dat=${(BIG_BYTES / 1024 / 1024).toFixed(0)}MB(oversize) ` +
        `files=${files.length} slot1.sav=${SMALL_BYTES}B`,
    )
    console.log(`\n==== ${pass} passed, ${fail} failed ====`)
  } finally {
    try {
      ws.close()
    } catch {
      /* 已关闭 */
    }
    killTree(proc)
    await waitExit(proc)
    proc = null
    const cleaned = await rmRetry(DATA_DIR)
    console.log(cleaned ? `  [cleanup] 已删除 ${DATA_DIR}` : `  [cleanup-warn] 删不掉 ${DATA_DIR}（句柄仍被占用）`)
  }
}

main().catch(async (e) => {
  console.error(e)
  console.error('--- stderr tail ---')
  console.error(stderr.slice(-2000))
  process.exitCode = 1
  killTree(proc)
  await waitExit(proc)
  await rmRetry(DATA_DIR)
})
