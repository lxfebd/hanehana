// 验证竖版封面刮削后缩略图保持竖版比例（防"封面被压扁"观感问题）：
// 刮削 CLANNAD（VNDB 竖版封面 3:4）→ 断言封面墙缩略图 naturalHeight > naturalWidth。
// 用法：node scripts/verify_cover_aspect.mjs
import { spawn, spawnSync } from 'node:child_process'
import { pickFreePort, killTree } from './lib/probePort.mjs'
import { join } from 'node:path'
import { rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { waitFor } from './lib/waitFor.mjs'

const APP_ROOT = join(process.cwd())
const PORT = await pickFreePort()
const DATA_DIR = join(APP_ROOT, '.aspect-data')
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
const games = [
  {
    id: 'g-aspect-1',
    title: 'CLANNAD',
    rawTitle: 'CLANNAD',
    dir: 'F:\\games\\clannad',
    exePath: 'F:\\games\\clannad\\game.exe',
    tags: [],
    sources: [],
    categories: [],
    favorite: false,
    playMs: 0,
    addedAt: Date.now(),
    manualEdit: false,
    variants: [],
    useLE: false,
    useMagpie: false,
  },
]
writeFileSync(join(DATA_DIR, 'games.json'), JSON.stringify(games, null, 2), 'utf8')
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
  throw new Error('no DevTools | ' + stderr.slice(-400))
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
      }, 120000)
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
    // 等预置 API 挂上（原来固定轮询 + 再等 800ms）
    await waitFor(() => ev('!!window.hh'), { timeoutMs: 20000, label: '预置 API window.hh 就绪' })
    console.log('== 搜索 CLANNAD ==')
    const search = await ev(`window.hh.scrapeSearch('CLANNAD')`)
    const results = search?.results ?? []
    const vndb = results.find((c) => c.provider === 'vndb')
    ck('VNDB 候选出现（竖版封面源）', !!vndb, 'vndb=' + results.filter((c) => c.provider === 'vndb').length)
    if (!vndb) {
      console.log('  warnings:', JSON.stringify(search?.warnings))
      return
    }
    console.log('  候选封面:', String(vndb.coverUrl || '').slice(0, 60))
    const applied = await ev(`window.hh.scrapeApply('g-aspect-1', ${JSON.stringify(vndb)})`)
    ck('刮削应用 ok', applied?.ok === true, JSON.stringify(applied))
    // 等封面/缩略图真的落库（原来固定 3000ms）：落库是异步的，慢机上 3s 不够。
    await waitFor(
      () => ev('window.hh.listGames().then(gs => { const g = gs.find(x => x.id === "g-aspect-1"); return !!(g && g.coverPath && g.thumbPath) })'),
      { timeoutMs: 20000, label: '刮削落库（coverPath + thumbPath）' },
    )
    const back = await ev(`window.hh.listGames()`)
    const g = Array.isArray(back) ? back.find((x) => x.id === 'g-aspect-1') : null
    ck('coverPath 落库', !!g?.coverPath && existsSync(g.coverPath), g?.coverPath || '')
    ck('thumbPath 落库', !!g?.thumbPath && existsSync(g.thumbPath), g?.thumbPath || '')
    // 刷新封面墙并等 img 渲染
    await ev(`window.location.reload()`)
    // 等应用真的起来（原固定 3500ms：慢机上不够，快机上白等）
    await waitFor(() => ev('!!(window.hh && document.querySelector(".app-shell"))'), { timeoutMs: 30000, label: '重载后应用就绪（hh + .app-shell）' })
    // B8：启动页是 home，封面墙在游戏库页——先点「全部游戏」
    // 等侧栏导航挂上再点（重载后侧栏晚于 hh 出现；固定等待换成条件等待）
    await waitFor(() => ev('!!(window.hh && document.querySelector(".sidebar .nav-item"))'), { timeoutMs: 30000, label: '应用就绪（hh + 侧栏导航）' })
    await ev(`(() => { const b=document.querySelector('[data-testid="nav-library"]'); if(b){b.click();return 'ok'} return 'no' })()`)
    // 首跑偶发 2 红（封面图渲染 {"has":false} / w=undefined）就是断在这里：缩略图还没生成或还没挂上
    // img 就断言了。改成两级条件等待：先等 img 元素出现，再等它解码完成（naturalWidth > 0）。
    await waitFor(() => ev('!!document.querySelector(".cover-thumb img")'), { timeoutMs: 15000, label: '封面墙缩略图 img 出现（.cover-thumb img）' })
    await waitFor(
      () => ev('(() => { const img = document.querySelector(".cover-thumb img"); return !!(img && img.complete && img.naturalWidth > 0) })()'),
      { timeoutMs: 20000, label: '封面缩略图解码完成（naturalWidth > 0）' },
    )
    const img = JSON.parse(
      await ev(`JSON.stringify((() => { const img = document.querySelector('.cover-thumb img'); if (!img) return { has: false }; return { has: true, w: img.naturalWidth, h: img.naturalHeight } })())`),
    )
    ck('封面图渲染', img.has && img.w > 0, JSON.stringify(img))
    ck('缩略图为竖版比例 (h > w)', img.has && img.h > img.w, 'w=' + img.w + ' h=' + img.h)
    console.log('  缩略图:', img.w + 'x' + img.h, img.h > img.w ? '(竖版)' : '(横版/扁)')
    console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====')
  } finally {
    ws.close()
    killTree(proc)
  }
}
main().catch((e) => {
  console.error(e)
  console.error(stderr.slice(-1500))
  try {
    killTree(proc)
  } catch {
    /* ignore */
  }
  process.exit(1)
})