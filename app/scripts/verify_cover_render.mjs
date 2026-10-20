// 端到端验证"图刮削"的用户视角：seed 游戏 → 详情打开刮削 → 应用 YMGal 候选（webp 封面）
// → 断言封面墙 <img> 真实渲染（naturalWidth > 0，hh:// 协议喂图成功）。
// 用法：node scripts/verify_cover_render.mjs
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'

const APP_ROOT = join(process.cwd())
const PORT = 9385
const DATA_DIR = join(APP_ROOT, '.cover-render-data')
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

// seed 一款「妹相随」（无封面无元数据）
const games = [
  {
    id: 'g-render-1',
    title: '妹相随～黑白世界的缤纷冒险～',
    rawTitle: '妹相随～黑白世界的缤纷冒险～',
    dir: 'F:\\games\\meixiangsui',
    exePath: 'F:\\games\\meixiangsui\\game.exe',
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
    // 等 App 起来 + 封面墙渲染占位卡
    for (let i = 0; i < 20; i++) {
      const e = await ev('!!document.querySelector(".cover-card")')
      if (e) break
      await new Promise((r) => setTimeout(r, 500))
    }
    await new Promise((r) => setTimeout(r, 1000))
    // 直接走主进程链路：搜索 → 取 YMGal top → 应用
    console.log('== 搜索妹相随 ==')
    const search = await ev(`window.hh.scrapeSearch('妹相随')`)
    const results = search?.results ?? []
    const ym = results.find((c) => c.provider === 'ymgal')
    ck('YMGal 候选出现', !!ym, 'ymgal=' + results.filter((c) => c.provider === 'ymgal').length)
    if (!ym) {
      console.log('  warnings:', JSON.stringify(search?.warnings))
      return
    }
    console.log('  候选封面:', String(ym.coverUrl || '').slice(0, 60))
    const applied = await ev(`window.hh.scrapeApply('g-render-1', ${JSON.stringify(ym)})`)
    ck('刮削应用 ok', applied?.ok === true, JSON.stringify(applied))
    await new Promise((r) => setTimeout(r, 3000))
    // 回读游戏：coverPath/thumbPath
    const back = await ev(`window.hh.listGames()`)
    const g = Array.isArray(back) ? back.find((x) => x.id === 'g-render-1') : null
    ck('coverPath 落库', !!g?.coverPath && existsSync(g.coverPath), g?.coverPath || '')
    ck('thumbPath 落库', !!g?.thumbPath && existsSync(g.thumbPath), g?.thumbPath || '')
    if (g?.coverPath) {
      const st = readFileSync(g.coverPath)
      ck('封面文件非空', st.length > 5000, 'bytes=' + st.length)
      // 文件头：webp (RIFF....WEBP) 或 jpg (FFD8)
      const head = st.subarray(0, 12).toString('hex')
      ck('封面格式可识别 (webp/jpg)', head.startsWith('52494646') || head.startsWith('ffd8'), 'head=' + head.slice(0, 8))
    }
    // 刷新封面墙并等 img 渲染
    await ev(`window.location.reload()`)
    await new Promise((r) => setTimeout(r, 3500))
    for (let i = 0; i < 20; i++) {
      const loaded = await ev(`(() => { const img = document.querySelector('.cover-thumb img'); return !!(img && img.complete && img.naturalWidth > 0) })()`)
      if (loaded) break
      await new Promise((r) => setTimeout(r, 500))
    }
    const imgState = JSON.parse(
      await ev(`JSON.stringify((() => { const img = document.querySelector('.cover-thumb img'); if (!img) return { has: false }; return { has: true, complete: img.complete, w: img.naturalWidth, h: img.naturalHeight, src: (img.src || '').slice(0, 40) } })())`),
    )
    ck('封面墙 img 存在', imgState.has, 'has=' + imgState.has)
    ck('封面图真实渲染 (naturalWidth>0)', imgState.has && imgState.w > 0, JSON.stringify(imgState))
    ck('封面通过 hh:// 协议加载', String(imgState.src || '').startsWith('hh://'), 'src=' + imgState.src)
    console.log('  img:', JSON.stringify(imgState))
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