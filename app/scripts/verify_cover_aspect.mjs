// 验证竖版封面刮削后缩略图保持竖版比例（防"封面被压扁"观感问题）：
// 刮削 CLANNAD（VNDB 竖版封面 3:4）→ 断言封面墙缩略图 naturalHeight > naturalWidth。
// 用法：node scripts/verify_cover_aspect.mjs
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'

const APP_ROOT = join(process.cwd())
const PORT = 9387
const DATA_DIR = join(APP_ROOT, '.aspect-data')
for (let i = 0; i < 5; i++) {
  try {
    rmSync(DATA_DIR, { recursive: true, force: true })
    break
  } catch {
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
  await new Promise((r) => setTimeout(r, 2500))
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
        fail++
        console.log('  [FAIL] ' + n + ' ' + (x || ''))
      }
    }
    for (let i = 0; i < 20; i++) {
      const e = await ev('!!window.hh')
      if (e) break
      await new Promise((r) => setTimeout(r, 500))
    }
    await new Promise((r) => setTimeout(r, 800))
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
    await new Promise((r) => setTimeout(r, 3000))
    const back = await ev(`window.hh.listGames()`)
    const g = Array.isArray(back) ? back.find((x) => x.id === 'g-aspect-1') : null
    ck('coverPath 落库', !!g?.coverPath && existsSync(g.coverPath), g?.coverPath || '')
    ck('thumbPath 落库', !!g?.thumbPath && existsSync(g.thumbPath), g?.thumbPath || '')
    // 刷新封面墙并等 img 渲染
    await ev(`window.location.reload()`)
    await new Promise((r) => setTimeout(r, 3500))
    for (let i = 0; i < 20; i++) {
      const loaded = await ev(`(() => { const img = document.querySelector('.cover-thumb img'); return !!(img && img.complete && img.naturalWidth > 0) })()`)
      if (loaded) break
      await new Promise((r) => setTimeout(r, 500))
    }
    const img = JSON.parse(
      await ev(`JSON.stringify((() => { const img = document.querySelector('.cover-thumb img'); if (!img) return { has: false }; return { has: true, w: img.naturalWidth, h: img.naturalHeight } })())`),
    )
    ck('封面图渲染', img.has && img.w > 0, JSON.stringify(img))
    ck('缩略图为竖版比例 (h > w)', img.has && img.h > img.w, 'w=' + img.w + ' h=' + img.h)
    console.log('  缩略图:', img.w + 'x' + img.h, img.h > img.w ? '(竖版)' : '(横版/扁)')
    console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====')
  } finally {
    ws.close()
    proc.kill()
  }
}
main().catch((e) => {
  console.error(e)
  console.error(stderr.slice(-1500))
  try {
    proc.kill()
  } catch {
    /* ignore */
  }
  process.exit(1)
})