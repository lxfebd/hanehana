// R6 批次验收：P1-3 全屏墙接虚拟滚动
// 用法：node scripts/accept_batch20.mjs   （须先 npm run build）
//  - 10k 种子游戏进全屏 → .fs-card DOM 节点数 < 80（RecycleScroller 窗口化）
//  - 方向键移动仍更新 data-fs-selected（键盘导航语义保留）
//  - Esc 可退出全屏
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const here = join(process.cwd(), 'scripts')
const APP_ROOT = process.cwd()
const PORT = '9277'
const DATA_DIR = join(APP_ROOT, '.batch20-data')
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })

const seed = spawn(process.execPath, [join(here, 'seed_layout.mjs'), DATA_DIR], {
  stdio: ['ignore', 'inherit', 'inherit'],
})
await new Promise((r) => seed.on('exit', r))
if (seed.exitCode !== 0) throw new Error('seed_layout failed')

// 扩到 10000 款（复用首条形状，仅改 id/title/exePath）
{
  const path = join(DATA_DIR, 'games.json')
  const base = JSON.parse(readFileSync(path, 'utf8'))[0]
  const games = []
  for (let i = 0; i < 10000; i++) {
    games.push({
      ...base,
      id: `g${i + 1}`,
      title: `Bulk Title ${i + 1}`,
      rawTitle: `Bulk Title ${i + 1}`,
      dir: `D:\\Bulk\\g${i + 1}`,
      exePath: `D:\\Bulk\\g${i + 1}\\game.exe`,
      favorite: i % 20 === 0,
      categories: [],
      sources: [],
      addedAt: base.addedAt + i,
      playMs: i * 60000,
      releaseDate: '2020-01-01',
      rating: 7 + (i % 3),
      tags: [`tag${i % 8}`],
      description: 'bulk',
      titleNative: undefined,
      coverPath: join(DATA_DIR, 'covers', 'g1.png'),
    })
  }
  writeFileSync(path, JSON.stringify(games, null, 0), 'utf8')
}

const exe = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const proc = spawn(exe, ['--disable-gpu', '.'], {
  cwd: APP_ROOT,
  env: { ...process.env, HANEHANA_DEBUG_PORT: String(PORT), HANEHANA_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
let stderr = ''
proc.stderr.on('data', (d) => {
  stderr += d.toString()
})

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

let passed = 0
let failed = 0
function assert(name, cond, extra = '') {
  if (cond) {
    passed++
    console.log('PASS ' + name)
  } else {
    failed++
    console.log('FAIL ' + name + (extra ? ' :: ' + extra : ''))
  }
}

async function main() {
  const wsUrl = await getWsUrl()
  await new Promise((r) => setTimeout(r, 3000))
  const port = (wsUrl.match(/:(\d+)\//) || [])[1]
  let pageJson = null
  let lastJson = ''
  for (let i = 0; i < 20 && !pageJson; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      lastJson = JSON.stringify(list.map((t) => ({ type: t.type, url: t.url })))
      pageJson = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
    } catch (e) {
      lastJson = 'fetch fail: ' + e
    }
    if (!pageJson) await new Promise((r) => setTimeout(r, 500))
  }
  if (!pageJson) throw new Error('no page target via /json | ' + lastJson)
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
  const sendRaw = (method, params = {}) =>
    new Promise((res, rej) => {
      const mid = ++msgId
      pending.set(mid, res)
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }))
      setTimeout(() => {
        if (pending.has(mid)) {
          pending.delete(mid)
          rej(new Error('cdp timeout: ' + method))
        }
      }, 15000)
    })
  const send = (method, params = {}) => sendRaw(method, params)
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails)
      return { __err: String(r.result.exceptionDetails.exception?.description ?? 'eval failed') }
    return r.result?.result?.value
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  try {
    await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    await send('Page.bringToFront').catch(() => {})
    await send('Page.reload', { ignoreCache: true })
    await wait(5000)

    const boot = await evalJs(`(() => ({
      tag: document.querySelector('.tag')?.textContent ?? '',
      coverCards: document.querySelectorAll('.cover-card').length,
      libCount: document.querySelectorAll('.nav-item .count')[0]?.textContent ?? '',
    }))()`)
    console.log('BOOT:', JSON.stringify(boot))
    assert('库已加载 10k', String(boot?.libCount || '').includes('10000'), JSON.stringify(boot))

    // 进全屏（工具栏侧栏 → 更多 → 全屏模式，或直接调 enterFullscreen 绑定的 UI）
    // 更稳：点侧栏「更多」再点「全屏模式」
    const enter = await evalJs(`(() => {
      const more = document.querySelector('.sidebar .more-toggle')
      if (more) more.click()
      return { hasMore: !!more }
    })()`)
    await wait(300)
    const enter2 = await evalJs(`(() => {
      const item = [...document.querySelectorAll('.more-menu .nav-item')].find(b => (b.textContent || '').includes('全屏'))
      if (!item) return { step: 'no-item', items: [...document.querySelectorAll('.more-menu .nav-item')].map(b => b.textContent) }
      item.click()
      return { step: 'ok' }
    })()`)
    console.log('ENTER_FS:', JSON.stringify(enter), JSON.stringify(enter2))
    assert('打开更多并点全屏', enter2?.step === 'ok', JSON.stringify(enter2))
    await wait(1200)

    const fs = await evalJs(`(() => {
      const root = document.querySelector('.fs-root')
      const cards = document.querySelectorAll('.fs-card').length
      const scroller = document.querySelectorAll('.fs-scroller, .vue-recycle-scroller').length
      return { hasFs: !!root, cards, scroller, selected: document.querySelectorAll('[data-fs-selected="true"]').length }
    })()`)
    console.log('FS:', JSON.stringify(fs))
    assert('全屏层已打开', fs?.hasFs === true, JSON.stringify(fs))
    assert(
      '10k 库下 .fs-card DOM < 80',
      typeof fs?.cards === 'number' && fs.cards > 0 && fs.cards < 80,
      String(fs?.cards),
    )
    assert('RecycleScroller 已挂载', (fs?.scroller ?? 0) >= 1, String(fs?.scroller))
    assert('有且仅有一个选中卡', fs?.selected === 1, String(fs?.selected))

    // 键盘右移 → 选中 index 变化
    const beforeSel = await evalJs(`(() => {
      const el = document.querySelector('[data-fs-selected="true"] .fs-title')
      return el?.textContent ?? ''
    })()`)
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'ArrowRight',
      code: 'ArrowRight',
      windowsVirtualKeyCode: 39,
      nativeVirtualKeyCode: 39,
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'ArrowRight',
      code: 'ArrowRight',
      windowsVirtualKeyCode: 39,
      nativeVirtualKeyCode: 39,
    })
    await wait(400)
    const afterSel = await evalJs(`(() => {
      const el = document.querySelector('[data-fs-selected="true"] .fs-title')
      return el?.textContent ?? ''
    })()`)
    console.log('KEY:', beforeSel, '->', afterSel)
    assert('方向键移动改变选中', !!afterSel && afterSel !== beforeSel, JSON.stringify({ beforeSel, afterSel }))

    // Esc 退出
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    })
    await wait(500)
    const afterEsc = await evalJs(`(() => ({ hasFs: !!document.querySelector('.fs-root') }))()`)
    console.log('ESC:', JSON.stringify(afterEsc))
    assert('Esc 退出全屏', afterEsc?.hasFs === false, JSON.stringify(afterEsc))
  } finally {
    console.log(`\n==== ${passed} passed, ${failed} failed ====`)
    ws.close()
    proc.kill()
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  console.error('--- stderr tail ---')
  console.error(stderr.slice(-2000))
  try {
    proc.kill()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
