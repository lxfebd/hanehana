// 进程状态机（权威在主进程 + 推送 + 派生 launching）真实 UI 走查。
// 断言点：
//  A1 启动后进程状态快照可读（window.hh.processStates）
//  B1 点 hero「启动」→ 按钮进入「启动中…」或「运行中」（状态机推进）
//  B2 IPC 调用期间按钮被禁用（不可重复点）
//  C1 主进程 runningGames 与渲染层 runningGames 一致（权威同步）
//  D1 onProcessChanged 推送能收到（状态机真的在广播）
//  E1 '启动中' 只在 starting 态出现，不会永久卡住（收尾防护）
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = join(here, '..')
const PORT = 9325
const DATA_DIR = join(APP_ROOT, '.ui-proc-data')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
function crc32Safe(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = (CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0; return (c ^ 0xffffffff) >>> 0 }
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const full = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32Safe(full), 0)
  return Buffer.concat([len, full, crc])
}
function grad(w, h, top, bottom) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc(h * (1 + w * 3))
  for (let y = 0; y < h; y++) {
    const t = h === 1 ? 0 : y / (h - 1); const row = y * (1 + w * 3); raw[row] = 0
    for (let x = 0; x < w; x++) { const o = row + 1 + x * 3
      raw[o] = Math.round(top[0] + (bottom[0] - top[0]) * t)
      raw[o + 1] = Math.round(top[1] + (bottom[1] - top[1]) * t)
      raw[o + 2] = Math.round(top[2] + (bottom[2] - top[2]) * t) }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
}

const now = Date.now()
const mk = (id, t, e = {}) => ({ id, dir: `X:\\p\\${t}`, exePath: `X:\\p\\${t}\\game.exe`, rawTitle: t, title: t, description: '', tags: [], categories: [], sources: [], playMs: 0, addedAt: now, useLE: false, useMagpie: false, favorite: false, ...e })

/* seed：一部有封面 + 一个真实可执行的 exe（用记事本当靶子，spawn 必成功且立刻退出） */
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(join(DATA_DIR, 'covers'), { recursive: true })
mkdirSync(join(DATA_DIR, 'thumbs'), { recursive: true })
const c1 = join(DATA_DIR, 'covers', 'a.png').replace(/\\/g, '/')
writeFileSync(c1, grad(300, 420, [214, 136, 86], [120, 40, 46]))
writeFileSync(join(DATA_DIR, 'games.json'), JSON.stringify([
  mk('g1', 'ATRI', { lastPlayed: now - 3600e3, coverPath: c1, developer: 'ANIPLEX.EXE', rating: 9.4,
    exePath: 'C:\\Windows\\System32\\notepad.exe', dir: 'C:\\Windows\\System32' }),
], null, 2))
console.log('[seed] 1 game, exe=notepad.exe（可真实 spawn）')

const exe = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const env = { ...process.env, HANEHANA_DEBUG_PORT: String(PORT), HANEHANA_DATA_DIR: DATA_DIR }
delete env.ELECTRON_RUN_AS_NODE
const proc = spawn(exe, ['.'], { cwd: APP_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let stderr = ''
proc.stderr.on('data', (d) => (stderr += d))
let wsUrl
for (let i = 0; i < 90; i++) {
  try {
    const t = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    const p = t.find((x) => x.type === 'page' && x.webSocketDebuggerUrl)
    if (p) { wsUrl = p.webSocketDebuggerUrl; break }
  } catch { /* wait */ }
  await sleep(500)
}
if (!wsUrl) { console.log('FAIL no cdp; stderr:', stderr.slice(-300)); try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}; process.exit(1) }
const sock = new WebSocket(wsUrl)
await new Promise((r, j) => { sock.addEventListener('open', r); sock.addEventListener('error', j) })
let mid = 0; const pend = new Map(); const errs = []; const pushes = []
sock.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'debug') {
    const a = (m.params.args || []).map((x) => x.value ?? '').join(' ')
    if (a.startsWith('[push]')) pushes.push(a)
  }
  if (m.method === 'Runtime.exceptionThrown') errs.push(((m.params.exceptionDetails.exception || {}).description || '').slice(0, 200))
})
const send = (method, params = {}) => new Promise((r) => { const id = ++mid; pend.set(id, r); sock.send(JSON.stringify({ id, method, params })) })
const ev = async (x) => { const m = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (m.error) throw new Error(JSON.stringify(m.error)); return m.result?.result?.value }

await send('Runtime.enable')
await send('Page.enable')
function pass(name, ok, extra = '') { console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${extra ? '  -- ' + extra : ''}`); if (!ok) process.exitCode = 1 }

// B8：启动页 = home（hero 在首页、封面墙在库页）。hero 在启动页就绪即可开测
for (let i = 0; i < 60; i++) { if (await ev('!!(window.hh && document.querySelector(".hero"))')) break; await sleep(300) }
await sleep(800)

console.log('==== 进程状态机（主进程权威 + 推送 + 派生）====')

/* 桥接可用性诊断：拿不到就先报清楚，不要带着 undefined 往下跑 */
const bridgeDiag = await ev(`JSON.stringify({
  hasHh: typeof window.hh,
  hasProcessStates: typeof window.hh?.processStates,
  hasOnProcessChanged: typeof window.hh?.onProcessChanged,
  hasRunningGames: typeof window.hh?.runningGames,
})`)
console.log('  [diag] bridge =', bridgeDiag)
if (!bridgeDiag.includes('"hasProcessStates":"function"')) {
  console.log('  [FAIL] preload 未暴露 processStates —— out/preload/index.cjs 是旧的或 app 未重载')
  console.log('==== 中止 ====')
  try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  process.exit(1)
}

/* 注意：ev() 的表达式里不能直接用 await（returnByValue 拿不到 Promise 结果），
   一律走 .then() 链把值摊平后再 JSON.stringify。 */
const callProcessStates = `window.hh.processStates().then(v => 'OK:' + JSON.stringify(v)).catch(e => 'ERR:' + (e && e.message))`

console.log('== A 启动对齐 ==')
const raw0 = await ev(callProcessStates)
console.log('  [diag] 初始快照 =', raw0)
const snap0 = raw0.startsWith('OK:') ? JSON.parse(raw0.slice(3)) : null
pass('A1 processStates 可调用且返回对象', !!snap0 && typeof snap0 === 'object', `raw=${raw0}`)
pass('A2 无进程时表为空', !!snap0 && Object.keys(snap0).length === 0, `keys=${snap0 ? Object.keys(snap0).length : 'n/a'}`)

console.log('== B 点启动 → 状态机推进 ==')
// 订阅推送（在点启动前挂上，才能抓到 starting/running）
await ev(`window.__pushes = []; window.hh.onProcessChanged((e) => { window.__pushes.push(e.state.status + ':' + e.gameId) })`)
const clickRes = await ev(`(() => { const b = document.querySelector('.hero-play'); if(!b) return 'no-btn'; b.click(); return 'clicked' })()`)
console.log('  [diag] click =', clickRes)
// 立即采一次（抓 starting 或已经推进到 running）
const earlyRaw = await ev(`Promise.all([window.hh.processStates()]).then(([s]) => JSON.stringify({ states: s, btn: (document.querySelector('.hero-play')||{}).textContent||'', disabled: (document.querySelector('.hero-play')||{}).disabled })).catch(e => 'ERR:' + (e && e.message))`)
console.log('  [diag] 点击后立即 =', earlyRaw)
await sleep(1500)
const laterRaw = await ev(`Promise.all([window.hh.processStates()]).then(([s]) => JSON.stringify({ states: s, btn: (document.querySelector('.hero-play')||{}).textContent||'', disabled: (document.querySelector('.hero-play')||{}).disabled, pushes: window.__pushes })).catch(e => 'ERR:' + (e && e.message))`)
console.log('  [diag] 1.5s 后 =', laterRaw)
const later = laterRaw.startsWith('OK:') || laterRaw.startsWith('{') ? (laterRaw.startsWith('{') ? JSON.parse(laterRaw) : JSON.parse(laterRaw)) : null
const st = later ? later.states : {}
const pid1 = st.g1 ? st.g1.pid : null
pass('B1 状态机有该游戏条目', !!st.g1, `g1=${JSON.stringify(st.g1)}`)
pass('B2 状态为 running（进程已落定）', !!(st.g1 && st.g1.status === 'running'), `status=${st.g1 && st.g1.status}`)
pass('B3 pid 已下发', typeof pid1 === 'number' && pid1 > 0, `pid=${pid1}`)
pass('B4 按钮显示「运行中」',
  !!(later && (later.btn.includes('运行中') || later.btn.includes('Running'))),
  `btn=${later && later.btn}`)
pass('B5 推送真的收到了（starting→running）', !!(later && later.pushes.length >= 1), `pushes=${later && JSON.stringify(later.pushes)}`)

console.log('== C 主进程与渲染层一致 ==')
// 封面墙（运行角标）在库页：导航过去数角标；D 段的 hero-play 再回首页
await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => (x.textContent || '').includes('全部游戏') || (x.textContent || '').includes('Library')); if (b) { b.click(); return 'ok' } return 'no' })()`)
await sleep(900)
const bothRaw = await ev(`window.hh.runningGames().then(r => JSON.stringify({ mainRunning: r, renderRunning: document.querySelectorAll('.cover-running').length })).catch(e => 'ERR:' + (e && e.message))`)
console.log('  [diag] =', bothRaw)
const both = bothRaw.startsWith('{') ? JSON.parse(bothRaw) : { mainRunning: [], renderRunning: 0 }
pass('C1 主进程 runningGames 含 g1', both.mainRunning.includes('g1'), `main=${JSON.stringify(both.mainRunning)}`)
pass('C2 渲染层封面墙有运行角标', both.renderRunning >= 1, `marks=${both.renderRunning}`)

console.log('== D 状态不会永久卡在启动中 ==')
// 回首页：D2 看的是 hero 启动按钮文案
await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => (x.textContent || '').includes('首页') || (x.textContent || '').includes('Home')); if (b) { b.click(); return 'ok' } return 'no' })()`)
await sleep(700)
// notepad 开着窗口不会自己退出——走查自己 taskkill 靶进程，
// 主进程监听 exit → 状态转 exited / 清条目 → 按钮恢复。
// （旧注释「notepad 会立刻退出」是错的，脚本因此永远挂在 D）
if (typeof pid1 === 'number' && pid1 > 0) {
  spawn('taskkill', ['/pid', String(pid1), '/f'], { stdio: 'ignore' })
}
await sleep(3000)
const finalRaw = await ev(`window.hh.processStates().then(s => JSON.stringify({ states: s, btn: (document.querySelector('.hero-play')||{}).textContent||'' })).catch(e => 'ERR:' + (e && e.message))`)
console.log('  [diag] 退出后 =', finalRaw)
const final = finalRaw.startsWith('{') ? JSON.parse(finalRaw) : { states: {}, btn: '' }
const fs2 = final.states
pass('D1 退出后状态不是 running（或转为 exited）', !fs2.g1 || fs2.g1.status !== 'running', `g1=${JSON.stringify(fs2.g1)}`)
pass('D2 按钮离开「运行中/启动中…」', !/运行中|启动中|Starting|Running/.test(final.btn), `btn=${final.btn}`)

console.log('== E 无异常 ==')
pass('E1 无 Runtime.exceptionThrown', errs.length === 0, JSON.stringify(errs.slice(0, 2)))

console.log('==== 完成 ====')
try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
// electron 完全退出前持着 DATA_DIR 的句柄，立刻 rmSync 会 EPERM——
// 等它落定再清，清不掉也不该让整个走查以红收尾（断言已经跑完）。
await sleep(1500)
try {
  rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 })
} catch { /* 数据目录留到下次 seed 前清 */ }
