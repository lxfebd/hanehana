// 批次2 验收：统计报表页（G5）
// 用法：node scripts/accept_batch2.mjs
// seed 库 + 预置 play-sessions.json → 统计页 DOM 断言：KPI 值 / 柱状图 SVG / 排行
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const here = join(process.cwd(), 'scripts')
const APP_ROOT = process.cwd()
const PORT = '9236'
const DATA_DIR = join(APP_ROOT, '.batch2-data')
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })

const seed = spawn(process.execPath, [join(here, 'seed_layout.mjs'), DATA_DIR], {
  stdio: ['ignore', 'inherit', 'inherit'],
})
await new Promise((res) => seed.on('exit', res))
if (seed.exitCode !== 0) throw new Error('seed_layout failed')

// 预置游玩会话：今天 2 小时 / 近 7 天 5 小时 / 近 30 天 12 小时（可精确断言）
const now = Date.now()
const DAY = 86400000
const sessions = []
const mk = (gameId, title, daysAgo, ms) => {
  const start = now - daysAgo * DAY - ms
  const end = now - daysAgo * DAY
  sessions.push({ gameId, title, start, end, ms })
}
mk('g1', '美少女万华镜', 0, 2 * 3600000) // 今日 2h
mk('g2', '命运石之门', 1, 3 * 3600000) // 近 7 天 3h
mk('g3', 'White Album 2', 20, 7 * 3600000) // 近 30 天 7h
writeFileSync(join(DATA_DIR, 'play-sessions.json'), JSON.stringify(sessions, null, 2), 'utf8')

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
  await new Promise((r) => setTimeout(r, 2500))
  const ws = await connectWs(wsUrl)
  let msgId = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  let sessionId = null
  const sendRaw = (method, params = {}) =>
    new Promise((res, rej) => {
      const mid = ++msgId
      pending.set(mid, res)
      const msg = { id: mid, method, params }
      if (sessionId) msg.sessionId = sessionId
      ws.send(JSON.stringify(msg))
      setTimeout(() => {
        if (pending.has(mid)) {
          pending.delete(mid)
          rej(new Error('cdp timeout: ' + method))
        }
      }, 12000)
    })
  const targets = await sendRaw('Target.getTargets')
  const page = (targets.result?.targetInfos || []).find((t) => t.type === 'page')
  if (!page) throw new Error('no page target')
  const att = await sendRaw('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  sessionId = att.result?.sessionId
  if (!sessionId) throw new Error('attach failed')
  const send = (method, params = {}) => sendRaw(method, params)
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails)
      return { __err: String(r.result.exceptionDetails.exception?.description ?? 'eval failed') }
    return r.result?.result?.value
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await send('Page.bringToFront').catch(() => {})
  await wait(800)

  // 切到统计页
  await evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('统计'))?.click()`)
  await wait(800)

  // 侧栏「统计」存在
  const navStats = await evalJs(`[...document.querySelectorAll('.nav-item')].some(b => b.textContent.includes('统计'))`)
  assert('侧栏有「统计」入口', navStats === true)

  // KPI 卡片：今日 2h / 近7天 5h / 近30天 12h
  const kpiNums = await evalJs(`[...document.querySelectorAll('.kpi-num')].map(e => e.textContent.trim())`)
  assert('KPI 有 5 张卡', Array.isArray(kpiNums) && kpiNums.length === 5, JSON.stringify(kpiNums))
  assert('今日时长 = 2 小时', kpiNums[0] === '2 小时', String(kpiNums?.[0]))
  assert('近 7 天 = 5 小时', kpiNums[1] === '5 小时', String(kpiNums?.[1]))
  assert('近 30 天 = 12 小时', kpiNums[2] === '12 小时', String(kpiNums?.[2]))

  // 柱状图 SVG 存在（近 30 天 30 根条）
  const barRects = await evalJs(`document.querySelectorAll('.panel svg rect').length`)
  assert('每日柱状图有 30 根条', barRects >= 30, 'rects=' + barRects)

  // 排行图：topGames 3 款（含标题文本）
  const topTitles = await evalJs(`document.querySelectorAll('.panel:last-of-type svg text').length`)
  assert('排行图渲染标题文本', topTitles >= 3, 'texts=' + topTitles)

  console.log('===== ' + passed + ' passed, ' + failed + ' failed =====')
  proc.kill()
  process.exit(failed ? 1 : 0)
}

try {
  await main()
} catch (e) {
  console.error('ERROR', e)
  proc.kill()
  process.exit(1)
}
