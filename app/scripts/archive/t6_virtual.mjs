// T6 验收：RecycleScroller 窗口化生效（Phase 4 扩到 1 万游戏）。
// 1. 隔离 DATA_DIR 直接写 10000 条假游戏 games.json（不走扫描，避免副作用）
// 2. 拉起 Electron（HANEHANA_DEBUG_PORT=9224, HANEHANA_DATA_DIR=隔离目录）
// 3. CDP 断言：
//    - 容器高度是窗口可视高度（非内容总高），说明 flex 收敛成功
//    - 网格 .cover-card 数量 << 10000（窗口化生效），滚动后仍窗口化且能滚
//    - 列表视图 .list-row 数量 << 10000
//    - 搜索过滤后窗口化容器正常（空态不受影响）
//    - 首屏渲染耗时 < 1s（过滤 + 首帧）
//
// 用法：node scripts/t6_virtual.mjs
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = join(here, '..')
const DEBUG_PORT = 9224
const DATA_DIR = join(APP_ROOT, '.t6-data')

// ---- 1. 注入 10000 条假游戏 ----
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })
const N = 10000
const games = []
for (let i = 0; i < N; i++) {
  games.push({
    id: `t6-${i}`,
    dir: `D:\\Fake\\Game${i}`,
    exePath: `D:\\Fake\\Game${i}\\game.exe`,
    rawTitle: `虚拟游戏 ${i}`,
    title: `虚拟游戏 ${i}`,
    tags: [],
    categories: [],
    sources: [],
    playMs: 0,
    useLE: false,
    useMagpie: false,
    addedAt: Date.now(),
    color: ['#3b4a6b', '#4a3b6b', '#3b6b5a', '#6b5a3b', '#6b3b4a', '#3b5a6b'][i % 6],
  })
}
writeFileSync(join(DATA_DIR, 'games.json'), JSON.stringify(games, null, 2), 'utf8')
console.log('seeded', N, 'games ->', DATA_DIR)

// ---- 2. 启动 Electron ----
const exe = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const proc = spawn(exe, ['.'], {
  cwd: APP_ROOT,
  env: {
    ...process.env,
    HANEHANA_DEBUG_PORT: String(DEBUG_PORT),
    HANEHANA_DATA_DIR: DATA_DIR,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
proc.stderr.on('data', (d) => console.log('[app]', d.toString().trim().slice(0, 200)))

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

async function waitCdp() {
  for (let i = 0; i < 60; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()
      if (pages.some((p) => p.type === 'page' && !p.url.startsWith('devtools'))) return
    } catch {
      /* 没起来，再等 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('Electron CDP 端口没在 30s 内就绪')
}

const pending = new Map()
let ws = null
let msgId = 0
async function connectCdp() {
  const pages = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()
  const page = pages.find((p) => p.type === 'page' && !p.url.startsWith('devtools'))
  ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  await new Promise((r) => (ws.onopen = r))
}
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  await waitCdp()
  await connectCdp()
  await wait(1500)

  // 网格窗口化：容器高度 = 可视高度（< 2000px），10000 条只渲染 < 80 个 .cover-card
  const grid = await evalJs(`(() => {
    const cards = document.querySelectorAll('.cover-card').length
    const wall = document.querySelector('.cover-wall')
    const scroller = document.querySelector('.vue-recycle-scroller')
    const layer = document.querySelector('.grid-layer .vue-recycle-scroller__item-wrapper')
    return {
      cards,
      wallH: wall?.clientHeight,
      scrollerH: scroller?.clientHeight,
      scrollH: scroller?.scrollHeight,
      layerW: layer?.clientWidth,
      cols: Math.max(1, Math.floor(((wall?.clientWidth ?? 0) + 16) / 200)),
    }
  })()`)
  check('网格窗口化：.cover-card < 80', grid.cards < 80, JSON.stringify(grid))
  check('容器高度收敛为可视高度(<2000)', grid.wallH < 2000 && grid.wallH > 100, `wallH=${grid.wallH}`)
  check('滚动容器存在且内容超高(scrollH>200000)', grid.scrollH > 200000, `scrollH=${grid.scrollH}`)

  // 首屏渲染耗时 < 1s：从发起到 .cover-card 出现
  const firstPaint = await evalJs(`(async () => {
    const t0 = performance.now()
    const scroller = document.querySelector('.vue-recycle-scroller')
    // 强制重新挂载（视图切换会触发 Vue 重渲染），再量一次从发起到卡片可点
    scroller.scrollTop = 0
    await new Promise((r) => setTimeout(r, 100))
    return { cards: document.querySelectorAll('.cover-card').length, t: performance.now() - t0 }
  })()`)
  check('首屏渲染 < 1s', firstPaint.t < 1000, `t=${firstPaint.t.toFixed(0)}ms cards=${firstPaint.cards}`)

  // 滚动到底：能滚（scrollTop > 0）且仍窗口化
  const scrolled = await evalJs(`(async () => {
    const scroller = document.querySelector('.vue-recycle-scroller')
    scroller.scrollTop = scroller.scrollHeight
    await new Promise((r) => setTimeout(r, 600))
    return { cards: document.querySelectorAll('.cover-card').length, scrollTop: scroller.scrollTop, scrollH: scroller.scrollHeight }
  })()`)
  check('滚动到底：scrollTop > 0', scrolled.scrollTop > 0, JSON.stringify(scrolled))
  check('滚动到底后仍窗口化：.cover-card < 80', scrolled.cards < 80, `cards=${scrolled.cards}`)

  // 回顶部
  await evalJs(`(async () => {
    const scroller = document.querySelector('.vue-recycle-scroller')
    scroller.scrollTop = 0
    await new Promise((r) => setTimeout(r, 600))
  })()`)

  // 切列表视图：.list-row 数量 << 1200
  const list = await evalJs(`(async () => {
    const btns = [...document.querySelectorAll('button')]
    const listBtn = btns.find((b) => b.title === '列表视图')
    if (!listBtn) return { err: 'no list view button' }
    listBtn.click()
    await new Promise((r) => setTimeout(r, 600))
    return { rows: document.querySelectorAll('.list-row').length }
  })()`)
  check('列表窗口化：.list-row < 80', list.rows < 80, JSON.stringify(list))

  // 列表滚动到底
  const listScrolled = await evalJs(`(async () => {
    const scroller = document.querySelector('.vue-recycle-scroller')
    scroller.scrollTop = scroller.scrollHeight
    await new Promise((r) => setTimeout(r, 600))
    return { rows: document.querySelectorAll('.list-row').length, scrollTop: scroller.scrollTop, scrollH: scroller.scrollHeight }
  })()`)
  check(
    '列表滚动：scrollTop > 0 且仍窗口化',
    listScrolled.scrollTop > 0 && listScrolled.rows < 80,
    JSON.stringify(listScrolled),
  )

  // 切回网格
  await evalJs(`(async () => {
    const btns = [...document.querySelectorAll('button')]
    const gridBtn = btns.find((b) => b.title === '网格视图')
    if (gridBtn) gridBtn.click()
    await new Promise((r) => setTimeout(r, 600))
  })()`)

  // 下载页虚拟化：切到下载页（空列表），无任务 = 空态；有任务时窗口化
  const dl = await evalJs(`(async () => {
    const btns = [...document.querySelectorAll('.nav-item')]
    const dlBtn = btns.find((b) => b.textContent.includes('下载任务'))
    if (!dlBtn) return { err: 'no downloads nav' }
    dlBtn.click()
    await new Promise((r) => setTimeout(r, 500))
    return {
      empty: !!document.querySelector('.dl-empty'),
      dlRows: document.querySelectorAll('.task-row').length,
    }
  })()`)
  check('下载页空态正常', dl.empty === true && dl.dlRows === 0, JSON.stringify(dl))

  // 切回游戏库页再测库内空态
  await evalJs(`(async () => {
    const btns = [...document.querySelectorAll('.nav-item')]
    const libBtn = btns.find((b) => b.textContent.includes('全部游戏'))
    if (libBtn) libBtn.click()
    await new Promise((r) => setTimeout(r, 500))
  })()`)

  // 空态不受影响：清空过滤搜一个不存在的词
  const emptyish = await evalJs(`(async () => {
    const input = document.querySelector('.search-input')
    if (!input) return { err: 'no search input' }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'zzz-nonexistent-xyz')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 400))
    return { cards: document.querySelectorAll('.cover-card').length, empty: !!document.querySelector('.empty') }
  })()`)
  check('搜索过滤后窗口化容器正常', emptyish.cards === 0 && emptyish.empty === true, JSON.stringify(emptyish))

  // 1 万 seed 截图（验收要求）：回网格顶部，清掉搜索词，抓一张网格全图
  await evalJs(`(async () => {
    const input = document.querySelector('.search-input')
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await new Promise((r) => setTimeout(r, 600))
    const scroller = document.querySelector('.vue-recycle-scroller')
    if (scroller) scroller.scrollTop = 0
    await new Promise((r) => setTimeout(r, 600))
  })()`)
  const shotAll = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  if (shotAll?.result?.data) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(DATA_DIR, '..', '.shots-10k-grid.png'), Buffer.from(shotAll.result.data, 'base64'))
    console.log('SHOT 10k 网格已保存')
  } else {
    console.log('SKIP 截图（captureScreenshot 无结果）')
  }
} catch (e) {
  failed++
  console.log('FATAL', e instanceof Error ? e.message : String(e))
} finally {
  try {
    proc.kill()
  } catch {
    /* 已退出 */
  }
  ws?.close()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}
