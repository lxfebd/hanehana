// 端到端验证批量刮削：seed 两款游戏（中文名「妹相随」+ 英文名「CLANNAD」），
// 真实调批量刮削流程，断言两款都能刮出候选（YMGal 命中中文、VNDB 命中英文）并落库。
// 用法：node scripts/verify_batch_scrape.mjs
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'

const APP_ROOT = join(process.cwd())
const PORT = 9381
const DATA_DIR = join(APP_ROOT, '.batch-scrape-data')
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

// seed 两款游戏：中文名 + 英文名
const games = [
  {
    id: 'g-batch-1',
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
  {
    id: 'g-batch-2',
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
    // 等 App 起来
    for (let i = 0; i < 20; i++) {
      const e = await ev('!!window.hh')
      if (e) break
      await new Promise((r) => setTimeout(r, 500))
    }
    await new Promise((r) => setTimeout(r, 1000))
    // 主进程搜索两款游戏（模拟批量刮削每步：scrapeSearch → 取 top → apply）
    for (const g of games) {
      console.log('== 批量刮削: ' + g.title + ' ==')
      const search = await ev(`window.hh.scrapeSearch(${JSON.stringify(g.title)})`)
      const results = search?.results ?? []
      const warns = search?.warnings ?? []
      const bySrc = {}
      for (const c of results) bySrc[c.provider] = (bySrc[c.provider] || 0) + 1
      ck('搜索出结果', results.length > 0, 'results=' + results.length + ' src=' + JSON.stringify(bySrc) + ' warn=' + JSON.stringify(warns.slice(0, 1)))
      if (!results.length) continue
      // 模拟 pickAuto：取第一个候选应用
      const top = results[0]
      const applied = await ev(`window.hh.scrapeApply(${JSON.stringify(g.id)}, ${JSON.stringify(top)})`)
      ck('刮削应用 ok', applied?.ok === true, JSON.stringify(applied))
    }
    // 回读落库结果
    await new Promise((r) => setTimeout(r, 2000))
    const back = await ev(`window.hh.listGames()`)
    if (Array.isArray(back)) {
      for (const g of games) {
        const b = back.find((x) => x.id === g.id)
        if (b) {
          ck(
            g.title + ' 落库（来源/开发商/封面）',
            b.sources?.length > 0 && b.developer && b.coverPath,
            'sources=' + JSON.stringify(b.sources) + ' dev=' + (b.developer || '') + ' cover=' + (b.coverPath ? 'yes' : 'no'),
          )
        } else {
          ck(g.title + ' 回读存在', false, 'not found')
        }
      }
    } else {
      ck('listGames 返回数组', false, JSON.stringify(back))
    }
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