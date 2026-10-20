// 统计页渲染质量验证：KPI 卡/近 30 天柱状图/Top 排行/海报导出入口
// 用法：node scripts/verify_stats.mjs
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { rmSync, mkdirSync } from 'node:fs'

const APP_ROOT = join(process.cwd())
const PORT = 9399
const DATA_DIR = join(APP_ROOT, '.stats-data')
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
// 补 play sessions（统计页的柱状图/排行按会话聚合；seed 只有 playMs 无 sessions）
{
  const fs = await import('node:fs')
  const now = Date.now()
  const day = 86400000
  const games = JSON.parse(fs.readFileSync(join(DATA_DIR, 'games.json'), 'utf8'))
  const sessions = []
  for (let i = 0; i < 30; i++) {
    const g = games[i % games.length]
    if (!g) continue
    const ms = 30 * 60000 + (i % 5) * 15 * 60000
    sessions.push({
      gameId: g.id,
      title: g.title,
      start: now - i * day - ms,
      end: now - i * day,
      ms,
    })
  }
  fs.writeFileSync(join(DATA_DIR, 'play-sessions.json'), JSON.stringify(sessions), 'utf8')
}
// 补 play sessions（统计页按会话聚合；seed 有 playMs 无 sessions，兼容路径仍应有总时长）
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
      const e = await ev('!!window.hh')
      if (e) break
      await new Promise((r) => setTimeout(r, 500))
    }
    await new Promise((r) => setTimeout(r, 800))
    // 切到统计页（侧栏「更多 → 统计」）
    await ev(`(() => { const m = [...document.querySelectorAll('.nav-item')].find(x => (x.textContent||'').includes('更多')); if (m) { m.click(); return 'ok' } return 'no-more' })()`)
    await new Promise((r) => setTimeout(r, 500))
    await ev(`(() => { const t = [...document.querySelectorAll('.more-menu .nav-item')].find(x => (x.textContent||'').includes('统计')); if (t) { t.click(); return 'ok' } return 'no-stats' })()`)
    await new Promise((r) => setTimeout(r, 1200))
    const st = JSON.parse(
      await ev(`JSON.stringify((() => {
        const wraps = [...document.querySelectorAll('.chart-wrap')]
        const bars = document.querySelectorAll('.chart-wrap rect').length
        const kpis = [...document.querySelectorAll('.st-kpi, [class*="kpi"]')].map(k => k.textContent.trim())
        const body = document.body.innerText
        const hasDuration = /h|分钟|小时/.test(body)
        const hasPosterBtn = document.body.innerText.includes('海报')
        const wrapCount = wraps.length
        return { bars, kpis, wrapCount, hasDuration, hasPosterBtn }
      })())`),
    )
    ck('统计页有内容（时长/排行文本）', st.hasDuration || st.kpis.length > 0, 'duration=' + st.hasDuration)
    ck('柱状图 SVG rect 渲染（≥25 根）', st.bars >= 25, 'bars=' + st.bars)
    ck('KPI 卡渲染', st.kpis.length >= 3, 'kpis=' + JSON.stringify(st.kpis))
    ck('图表区渲染（柱状图+排行两个 SVG）', st.wrapCount >= 2, 'wraps=' + st.wrapCount)
    ck('海报导出入口存在', st.hasPosterBtn === true, 'poster=' + st.hasPosterBtn)
    console.log('  统计页:', JSON.stringify({ bars: st.bars, wraps: st.wrapCount, kpis: st.kpis.length, poster: st.hasPosterBtn }))
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