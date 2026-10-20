// 验证 hero 统计卡渲染：seed 12 款 + 任务 → hero 右侧 .hero-stats 存在且显示统计
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { rmSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const APP_ROOT = join(process.cwd())
const PORT = 9353
const DATA_DIR = join(APP_ROOT, '.hero-stats-data')
rmSync(DATA_DIR, { recursive: true, force: true })
const seed = spawnSync(process.execPath, [join(APP_ROOT, 'scripts', 'seed_layout.mjs'), DATA_DIR], { cwd: APP_ROOT, stdio: ['ignore', 'inherit', 'inherit'] })
if (seed.status !== 0) throw new Error('seed failed')
const env = { ...process.env, HANEHANA_DEBUG_PORT: String(PORT), HANEHANA_DATA_DIR: DATA_DIR }
delete env.ELECTRON_RUN_AS_NODE
const proc = spawn(join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.'], { cwd: APP_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let stderr = ''
proc.stderr.on('data', (d) => (stderr += d.toString()))
async function getWsUrl() { for (let i = 0; i < 60; i++) { const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) return m[1]; await new Promise((r) => setTimeout(r, 500)) } throw new Error('no DevTools') }
function connectWs(url) { return new Promise((res, rej) => { const ws = new WebSocket(url); const to = setTimeout(() => rej(new Error('ws timeout')), 10000); ws.onopen = () => { clearTimeout(to); res(ws) }; ws.onerror = () => rej(new Error('ws err')) }) }
async function main() {
  const wsUrl = await getWsUrl()
  await new Promise((r) => setTimeout(r, 2500))
  const port = (wsUrl.match(/:(\d+)\//) || [])[1]
  let pageJson = null
  for (let i = 0; i < 20 && !pageJson; i++) { try { const l = await (await fetch('http://127.0.0.1:' + port + '/json')).json(); pageJson = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null } catch {} if (!pageJson) await new Promise((r) => setTimeout(r, 500)) }
  const ws = await connectWs(pageJson.webSocketDebuggerUrl)
  let msgId = 0
  const pending = new Map()
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params = {}) => new Promise((res, rej) => { const mid = ++msgId; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('timeout')) } }, 30000) })
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.exception?.description ?? '') }; return r.result?.result?.value }
  try {
    let pass = 0, fail = 0
    const ck = (n, c, x = '') => { if (c) { pass++; console.log('  [PASS] ' + n) } else { fail++; console.log('  [FAIL] ' + n + ' ' + (x || '')) } }
    // 等 hero 渲染
    for (let i = 0; i < 20; i++) { const h = await ev('!!document.querySelector(".hero")'); if (h) break; await new Promise((r) => setTimeout(r, 500)) }
    await new Promise((r) => setTimeout(r, 1500))
    const st = JSON.parse(await ev('JSON.stringify((() => { const s = document.querySelector(".hero-stats"); const rows = [...document.querySelectorAll(".hs-row, .hs-prog")].map(r => r.textContent.trim()); const bar = document.querySelector(".hs-fill"); const pct = document.querySelector(".hs-pct"); return { hasStats: !!s, rows, barW: bar ? bar.style.width : "", pct: pct ? pct.textContent : "" } })())'))
    ck('统计卡渲染', st.hasStats, 'hasStats=' + st.hasStats)
    ck('统计卡 4 行（总时长/已玩/本月/续读）', st.rows.length >= 4, JSON.stringify(st.rows))
    ck('总时长行有值', st.rows.some((r) => /h|m|:/.test(r)), JSON.stringify(st.rows))
    ck('续读进度条有宽度', !!st.barW && st.barW !== '0%', 'barW=' + st.barW)
    console.log('  统计卡内容:', JSON.stringify(st.rows))
    console.log('  续读:', st.pct, 'bar:', st.barW)
    console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====')
  } finally { ws.close(); proc.kill() }
}
main().catch((e) => { console.error(e); console.error(stderr.slice(-1500)); try { proc.kill() } catch {} ; process.exit(1) })

