// 最近续读条验证：seed 有 lastPlayed 的游戏 → 断言 .recent-strip 渲染、项齐全、点击选中
// 用法：node scripts/verify_recent_strip.mjs
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const APP_ROOT = join(process.cwd())
const PORT = 9395
const DATA_DIR = join(APP_ROOT, '.recent-data')
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
spawnSync(process.execPath, [join(APP_ROOT, 'scripts', 'seed_layout.mjs'), DATA_DIR], {
  cwd: APP_ROOT,
  stdio: ['ignore', 'inherit', 'inherit'],
})
// 给前 2 款游戏设 lastPlayed（最近玩过），续读条应显示
{
  const gp = join(DATA_DIR, 'games.json')
  const games = JSON.parse(readFileSync(gp, 'utf8'))
  const now = Date.now()
  games[0].lastPlayed = now - 3600000 // 1 小时前
  games[1].lastPlayed = now - 86400000 * 2 // 2 天前
  writeFileSync(gp, JSON.stringify(games, null, 2), 'utf8')
}
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
        fail++
        console.log('  [FAIL] ' + n + ' ' + (x || ''))
      }
    }
    for (let i = 0; i < 20; i++) {
      const e = await ev('!!document.querySelector(".recent-strip")')
      if (e) break
      await new Promise((r) => setTimeout(r, 500))
    }
    await new Promise((r) => setTimeout(r, 800))
    const st = JSON.parse(
      await ev(`JSON.stringify((() => {
        const strip = document.querySelector('.recent-strip')
        const items = [...document.querySelectorAll('.recent-item')]
        return {
          strip: !!strip,
          count: items.length,
          titles: items.map(i => (i.querySelector('.recent-title')||{}).textContent?.trim() || '').slice(0, 4),
          times: items.map(i => (i.querySelector('.recent-time')||{}).textContent?.trim() || ''),
          label: (document.querySelector('.recent-label')||{}).textContent?.trim() || '',
        }
      })())`),
    )
    ck('续读条渲染', st.strip === true, 'strip=' + st.strip)
    ck('最近玩过的项出现', st.count >= 2, 'count=' + st.count)
    ck('标签「最近续读」', (st.label || '').length > 0, 'label=' + st.label)
    ck('时间显示（今天/昨天/日期）', st.times.some((x) => x.length > 0), 'times=' + JSON.stringify(st.times))
    console.log('  续读条:', JSON.stringify({ count: st.count, titles: st.titles, times: st.times, label: st.label }))
    // 点击第一个续读项 → 选中态
    await ev(`(() => { const i = document.querySelector('.recent-item'); if (i) { i.click(); return 'ok' } return 'no' })()`)
    await new Promise((r) => setTimeout(r, 500))
    const sel = await ev(`document.querySelectorAll('.recent-item.selected').length`)
    ck('点击续读项选中', sel === 1, 'selected=' + sel)
    console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====')
  } finally {
    ws.close()
    proc.kill()
  }
}
main().catch((e) => {
  console.error(e)
  console.error(stderr.slice(-1200))
  try {
    proc.kill()
  } catch {
    /* ignore */
  }
  process.exit(1)
})