// 批量编辑 UI 走查：多选 2 款 → 批量面板出现（计数/收藏/移除）→ 收藏切换 → 回读
// 用法：node scripts/verify_batch_edit.mjs
import { spawn, spawnSync } from 'node:child_process'
import { pickFreePort, killTree } from './lib/probePort.mjs'
import { join } from 'node:path'
import { rmSync, mkdirSync } from 'node:fs'
import { waitFor } from './lib/waitFor.mjs'

const APP_ROOT = join(process.cwd())
const PORT = await pickFreePort()
const DATA_DIR = join(APP_ROOT, '.batedit-data')
for (let i = 0; i < 5; i++) {
  try {
    rmSync(DATA_DIR, { recursive: true, force: true })
    break
  } catch {
    // 数据目录被上一轮进程占用的重试退避（不是等页面状态）
    await new Promise((r) => setTimeout(r, 800))
  }
}
mkdirSync(join(DATA_DIR, 'covers'), { recursive: true })
mkdirSync(join(DATA_DIR, 'thumbs'), { recursive: true })
spawnSync(process.execPath, [join(APP_ROOT, 'scripts', 'seed_layout.mjs'), DATA_DIR], {
  cwd: APP_ROOT,
  stdio: ['ignore', 'inherit', 'inherit'],
})
const env = { ...process.env, HANEHANA_DEBUG_PORT: String(PORT), HANEHANA_DATA_DIR: DATA_DIR }
delete env.ELECTRON_RUN_AS_NODE
const proc = spawn(join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.'], {
  cwd: APP_ROOT,
  env,
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
  throw new Error('no DevTools')
}
function connectWs(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url)
    const to = setTimeout(() => rej(new Error('ws timeout')), 10000)
    ws.onopen = () => {
      clearTimeout(to)
      res(ws)
    }
    ws.onerror = () => rej(new Error('ws err'))
  })
}
async function main() {
  const wsUrl = await getWsUrl()
  // DevTools 已在监听 ⇒ /json 立刻可取；下面 /json 循环本身就是条件等待。原来固定 2500ms 是白等。
  const port = (wsUrl.match(/:(\d+)\//) || [])[1]
  let pageJson = null
  for (let i = 0; i < 20 && !pageJson; i++) {
    try {
      const l = await (await fetch('http://127.0.0.1:' + port + '/json')).json()
      pageJson =
        l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && /index\.html|renderer/.test(t.url || '')) ?? null
      if (!pageJson) pageJson = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
    } catch {
      /* retry */
    }
    if (!pageJson) await new Promise((r) => setTimeout(r, 500))
  }
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
          rej(new Error('timeout'))
        }
      }, 30000)
    })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.exception?.description ?? '') }
    return r.result?.result?.value
  }
  try {
    let pass = 0
    let fail = 0
    const ck = (n, c, x = '') => {
      if (c) {
        pass++
        console.log('  [PASS] ' + n)
      } else {
        fail++; process.exitCode = 1
        console.log('  [FAIL] ' + n + ' ' + (x || ''))
      }
    }
    // 启动页现在是 home 仪表盘（B8）——封面墙/工具栏在库页，先导航过去
    // 先等应用就绪（原来这里是固定 2500ms）：慢机上侧栏还没渲染就点导航会拿到 'no'。
    await waitFor(() => ev('!!(window.hh && document.querySelector(".sidebar .nav-item"))'), { timeoutMs: 30000, label: '应用就绪（hh + 侧栏导航）' })
    await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => (x.textContent || '').includes('全部游戏') || (x.textContent || '').includes('Library')); if (b) { b.click(); return 'ok' } return 'no' })()`)
    // 切页后等封面墙真的渲染（固定 800+800ms 和手拉循环都换成条件等待）
    await waitFor(() => ev('!!document.querySelector(".cover-card")'), { timeoutMs: 15000, label: '库页封面墙出现（.cover-card）' })
    // 首屏被页头 + KPI 条 + hero + 续读条占满：先滚到封面墙再点选
    // （CDP 鼠标移到视口外的卡片上 = 什么都没点到）。
    await ev(`(() => { document.querySelector('.cover-card')?.scrollIntoView({ block: 'center' }); return true })()`)
    // 等滚动真正落位（卡片中心进视口）再取坐标点击：CDP 点视口外等于没点
    await waitFor(() => ev('(() => { const c = document.querySelector(".cover-card"); if (!c) return false; const r = c.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight })()'), { timeoutMs: 5000, label: '封面墙滚动落位' })
    // 进入多选模式。按**文案**定位而不是 aria-pressed（toolbar 里多个 toggle
    // 都带 aria-pressed，取「第一个 aria-pressed」会命中正则搜索）。
    const multi = await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-pressed') !== null) && ((x.title || '') + (x.textContent || '')).includes('多选')); if (b) { b.click(); return 'ok' } return 'no-multi-btn' })()`)
    ck('进入多选模式', multi === 'ok', 'multi=' + multi)
    await waitFor(() => ev('(() => { const b = [...document.querySelectorAll("button")].find(x => x.getAttribute("aria-pressed") === "true"); return !!b })()'), { timeoutMs: 5000, label: '多选按钮进入按下态' })
    // 选 2 款（CDP 完整鼠标序列：moved → pressed → released，点击卡片中心）
    const cardRects = await ev(`JSON.stringify([...document.querySelectorAll('.cover-card')].slice(0, 2).map(c => { const r = c.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 } }))`)
    const rects = JSON.parse(cardRects)
    for (let i = 0; i < rects.length; i++) {
      const rc = rects[i]
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rc.x, y: rc.y })
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rc.x, y: rc.y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rc.x, y: rc.y, button: 'left', clickCount: 1 })
      // 每点一张就等「选中数 = 已点数」到位（原来固定 250ms + 800ms 两层白等）
      await waitFor(() => ev('document.querySelectorAll(".cover-card.checked").length >= ' + (i + 1)), { timeoutMs: 5000, label: '第 ' + (i + 1) + ' 张卡进入选中态' })
    }
    const st = JSON.parse(
      await ev(`JSON.stringify((() => {
        const panel = document.querySelector('.batch-overlay')
        const count = (document.querySelector('.batch-count')||{}).textContent?.trim() || ''
        const favBtn = [...document.querySelectorAll('.batch-panel button')].find(b => (b.textContent||'').includes('收藏'))
        const removeBtn = [...document.querySelectorAll('.batch-panel button')].find(b => (b.textContent||'').includes('移除'))
        const sel = document.querySelectorAll('.cover-card.checked').length
        return { panel: !!panel, count, fav: !!favBtn, remove: !!removeBtn, sel }
      })())`),
    )
    ck('批量面板出现', st.panel === true, 'panel=' + st.panel)
    ck('计数显示选中 2', (st.count || '').includes('2'), 'count=' + st.count)
    ck('收藏/移除按钮在面板', st.fav && st.remove, 'fav=' + st.fav + ' remove=' + st.remove)
    ck('两张卡呈选中态', st.sel >= 2, 'sel=' + st.sel)
    // 点收藏 → 回读两款都收藏
    await ev(`(() => { const b = [...document.querySelectorAll('.batch-panel button')].find(x => (x.textContent||'').includes('收藏')); if (b) { b.click(); return 'ok' } return 'no' })()`)
    // 等批量收藏真正落到数据层（乐观更新 + IPC 回读），原来固定 900ms
    await waitFor(() => ev('window.hh.listGames().then(gs => gs.filter(g => g.favorite).length >= 2)'), { timeoutMs: 8000, label: '批量收藏落库（favorite ≥ 2）' })
    // Runtime.evaluate 顶层不能用 await（awaitPromise 只消化返回的 promise）——用 .then 链
    const favsExpr = `window.hh.listGames().then(gs => JSON.stringify(gs.filter(g => g.favorite).length))`
    const favs = await ev(favsExpr)
    ck('两款都变收藏', parseInt(favs, 10) >= 2, 'favs=' + favs)
    console.log('  批量编辑:', JSON.stringify({ count: st.count, sel: st.sel, favs: favs }))
    console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====')
  } finally {
    ws.close()
    killTree(proc)
  }
}
main().catch((e) => {
  console.error(e)
  console.error(stderr.slice(-1200))
  try {
    killTree(proc)
  } catch {
    /* ignore */
  }
  process.exit(1)
})