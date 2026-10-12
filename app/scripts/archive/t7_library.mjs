// T7 验收：游戏库屏重建（§5.3）。
// 场景A（隔离 DATA_DIR 空库）：空态含单一按钮；
// 场景B（注入 8 条带 thumbPath 假游戏 + 1 条无 thumb）：卡内无 backdrop-filter、
//   有 thumb 的 img src 以 hh://thumb/ 开头、无 thumb 走占位字、评分不上卡。
//
// 用法：node scripts/t7_library.mjs
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = join(here, '..')
const DEBUG_PORT = 9225
const DATA_DIR = join(APP_ROOT, '.t7-data')

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`)
  } else {
    failed++
    console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`)
  }
}

async function launch(dataDir, port) {
  // 注意：不 rmSync——调用方负责在 launch 前写好感数据；
  // launch 内清理会删掉刚注入的 games.json。
  mkdirSync(dataDir, { recursive: true })
  const exe = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  const proc = spawn(exe, ['.'], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      HANEHANA_DEBUG_PORT: String(port),
      HANEHANA_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  proc.stderr.on('data', (d) => console.log('[app]', d.toString().trim().slice(0, 160)))
  for (let i = 0; i < 60; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      if (pages.some((p) => p.type === 'page' && !p.url.startsWith('devtools'))) return proc
    } catch {
      /* 再等 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Electron CDP 端口 ${port} 没在 30s 内就绪`)
}

async function connect(port) {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = pages.find((p) => p.type === 'page' && !p.url.startsWith('devtools'))
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map()
  let msgId = 0
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  await new Promise((r) => (ws.onopen = r))
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++msgId
      pending.set(mid, resolve)
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
  const evalJs = async (expr) => {
    const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (res.result?.exceptionDetails)
      return { __err: String(res.result.exceptionDetails.exception?.description ?? 'eval failed') }
    return res.result?.result?.value
  }
  return { ws, evalJs }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

let proc = null
let conn = null
let evalJs = null

// ---- 场景A：空库空态 ----
try {
  rmSync(DATA_DIR, { recursive: true, force: true })
  mkdirSync(DATA_DIR, { recursive: true })
  proc = await launch(DATA_DIR, DEBUG_PORT)
  conn = await connect(DEBUG_PORT)
  evalJs = conn.evalJs
  await wait(1500)

  const empty = await evalJs(`(() => {
    const empty = document.querySelector('.empty')
    if (!empty) return { present: false }
    const btns = empty.querySelectorAll('button')
    return { present: true, btns: btns.length, text: empty.textContent }
  })()`)
  check('空态存在且含单一 button', empty.present === true && empty.btns === 1, JSON.stringify(empty))

  proc.kill()
  await wait(1200)
  // 确保旧进程彻底退出（单实例锁），否则新实例被挡、CDP 连到旧空库
  try {
    proc.kill('SIGKILL')
  } catch {
    /* 已退出 */
  }
  await wait(800)

  // ---- 场景B：8 条带 thumbPath + 1 条无 thumb ----
  const games = []
  for (let i = 0; i < 8; i++) {
    games.push({
      id: `t7-thumb-${i}`,
      dir: `D:\\Fake\\G${i}`,
      exePath: `D:\\Fake\\G${i}\\game.exe`,
      rawTitle: `有缩略图 ${i}`,
      title: `有缩略图 ${i}`,
      tags: [],
      categories: ['RPG'],
      sources: [],
      playMs: 0,
      useLE: false,
      useMagpie: false,
      addedAt: Date.now(),
      thumbPath: `C:\\fake\\thumbs\\${i}.jpg`,
      rating: 8.5,
    })
  }
  games.push({
    id: 't7-no-thumb',
    dir: 'D:\\Fake\\NoThumb',
    exePath: 'D:\\Fake\\NoThumb\\game.exe',
    rawTitle: '无缩略图',
    title: '无缩略图',
    tags: [],
    categories: ['AVG'],
    sources: [],
    playMs: 0,
    useLE: false,
    useMagpie: false,
    addedAt: Date.now(),
    color: '#3b4a6b',
    rating: 9.1,
  })
  writeFileSync(join(DATA_DIR, 'games.json'), JSON.stringify(games, null, 2), 'utf8')

  proc = await launch(DATA_DIR, DEBUG_PORT)
  conn = await connect(DEBUG_PORT)
  evalJs = conn.evalJs
  // 轮询等卡片出现（backfillThumbs 串行 + hh:// 请求要时间）
  for (let i = 0; i < 20; i++) {
    const n = await evalJs(`document.querySelectorAll('.cover-card').length`)
    if (n >= 8) break
    await wait(300)
  }
  await wait(500)

  const grid = await evalJs(`(() => {
    const cards = [...document.querySelectorAll('.cover-card')]
    if (cards.length === 0) return { err: 'no cards' }
    // 有 thumb 的 img src
    const imgs = [...document.querySelectorAll('.cover-thumb img')].map((i) => i.src)
    const thumbImgs = imgs.filter((s) => s.startsWith('hh://thumb/'))
    // 卡内无 backdrop-filter
    const cardBf = cards.every((c) => {
      const cs = getComputedStyle(c)
      return !cs.backdropFilter || cs.backdropFilter === 'none'
    })
    // 占位字（无 thumb 的卡显示前两字）
    const letters = [...document.querySelectorAll('.cover-letter')].map((l) => l.textContent)
    // 评分不上卡
    const noRating = !document.querySelector('.cover-card .cover-rating')
    // 标题在封面下（cover-titlezone 在 cover-thumb 之后）
    const card0 = cards[0]
    const thumb = card0.querySelector('.cover-thumb')
    const titlezone = card0.querySelector('.cover-titlezone')
    const below = thumb && titlezone && thumb.getBoundingClientRect().bottom <= titlezone.getBoundingClientRect().top + 1
    return { cards: cards.length, thumbImgs: thumbImgs.length, cardBf, letters, noRating, below }
  })()`)
  check('网格渲染出卡片', grid.cards >= 8, JSON.stringify(grid))
  check('有 thumb 的 img 全部走 hh://thumb/', grid.thumbImgs === 8, `thumbImgs=${grid.thumbImgs}`)
  check('卡内无 backdrop-filter', grid.cardBf === true)
  check(
    '无 thumb 卡显示占位前两字',
    Array.isArray(grid.letters) && grid.letters.includes('无缩略图'.slice(0, 2)),
    `letters=${JSON.stringify(grid.letters)}`,
  )
  check('评分不上卡', grid.noRating === true)
  check('标题区在封面下方', grid.below === true)

  // 分类 chips：allCategories 来自 store，这里 games 含 RPG/AVG
  const chips = await evalJs(`[...document.querySelectorAll('.cat-chip')].map(e => e.textContent.trim()).join('|')`)
  check(
    '分类 chip 行含「全部/RPG/AVG」',
    typeof chips === 'string' && ['全部', 'RPG', 'AVG'].every((c) => chips.includes(c)),
    String(chips),
  )

  // 视图切换按钮存在
  const segBtns = await evalJs(`[...document.querySelectorAll('.seg-btn')].map(b => b.title).join('|')`)
  check(
    'segmented 有网格/列表两按钮',
    typeof segBtns === 'string' && segBtns.includes('网格视图') && segBtns.includes('列表视图'),
    String(segBtns),
  )

  // 搜索框有内嵌图标
  const hasSearchIc = await evalJs(`!!document.querySelector('.search-ic')`)
  check('搜索框内嵌 Search 图标', hasSearchIc === true)
} catch (e) {
  failed++
  console.log('FATAL', e instanceof Error ? e.message : String(e))
} finally {
  try {
    proc?.kill()
  } catch {
    /* 已退出 */
  }
  conn?.ws?.close()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}
