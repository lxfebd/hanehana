// T19.4 验收：G15 便携模式
// 用法：node scripts/accept_batch10.mjs
//  - 用 HANEHANA_PORTABLE_EXEDIR 模拟「exe 在便携根」（同 HANEHANA_NO_OS_FULLSCREEN 测试缝风格），
//    在该目录放 PORTABLE 标记 → 数据目录应落在便携根 data\ 下
//  - 断言：
//    1. 无 PORTABLE 标记 → data_dir = HANEHANA_DATA_DIR（测试通道优先）
//    2. 有 PORTABLE 标记 → data_dir = 便携根\data
//    3. hello().portable = true
//    4. 设置页「关于」显示便携数据目录
//    5. 便携模式下游戏库读写（games.json）都落在便携 data 目录
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const APP_ROOT = process.cwd()
const PORT = '9266'
const DATA_DIR = join(APP_ROOT, '.batch10-data') // HANEHANA_DATA_DIR（普通模式兜底）
const PORTABLE_ROOT = join(APP_ROOT, '.batch10-portable') // 模拟便携根
const PORTABLE_DATA = join(PORTABLE_ROOT, 'data')

// 第一段：无标记（普通模式）——先直接验证普通场景
rmSync(DATA_DIR, { recursive: true, force: true })
rmSync(PORTABLE_ROOT, { recursive: true, force: true })
mkdirSync(join(DATA_DIR, 'covers'), { recursive: true })
mkdirSync(PORTABLE_ROOT, { recursive: true })

let passed = 0
let failed = 0
function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log('PASS ' + name) }
  else { failed++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

async function launchApp(extraEnv = {}) {
  const exe = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  const proc = spawn(exe, ['--disable-gpu', '.'], {
    cwd: APP_ROOT,
    env: { ...process.env, HANEHANA_DEBUG_PORT: String(PORT), HANEHANA_DATA_DIR: DATA_DIR, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  proc.stderr.on('data', (d) => {
    stderr += d.toString()
    const line = d.toString().trim()
    if (line.includes('[hanehana]') || /Error/.test(line)) process.stdout.write('[app] ' + line.slice(0, 300) + '\n')
  })
  const wsUrl = await new Promise((resolve, reject) => {
    let tries = 0
    const t = setInterval(() => {
      tries++
      const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (m) { clearInterval(t); resolve(m[1]) }
      else if (tries > 60) { clearInterval(t); reject(new Error('no DevTools line')) }
    }, 500)
  })
  const ws = await new Promise((resolve, reject) => {
    const w = new WebSocket(wsUrl)
    const to = setTimeout(() => reject(new Error('ws timeout')), 10000)
    w.onopen = () => { clearTimeout(to); resolve(w) }
    w.onerror = () => reject(new Error('ws error'))
  })
  let msgId = 0
  const pending = new Map()
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  let sessionId = null
  const sendRaw = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++msgId
    pending.set(mid, res)
    const msg = { id: mid, method, params }
    if (sessionId) msg.sessionId = sessionId
    ws.send(JSON.stringify(msg))
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('cdp timeout: ' + method)) } }, 15000)
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
    if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.exception?.description ?? 'eval failed') }
    return r.result?.result?.value
  }
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await send('Page.bringToFront').catch(() => {})
  await new Promise((r) => setTimeout(r, 800))
  return { proc, evalJs, ws, send, close: () => { ws.close(); proc.kill() } }
}

// ---- 阶段 1：无 PORTABLE 标记 → 普通模式（data_dir = HANEHANA_DATA_DIR, portable=false）
{
  const app1 = await launchApp()
  const info1 = await app1.evalJs(`(async () => { const i = await window.hh.hello(); return { data_dir: i.data_dir, portable: i.portable } })()`)
  console.log('DEBUG info1', JSON.stringify(info1))
  assert('无标记时 data_dir = HANEHANA_DATA_DIR', info1.data_dir === DATA_DIR, JSON.stringify(info1))
  assert('无标记时 portable = false', info1.portable === false, JSON.stringify(info1))
  app1.close()
  await new Promise((r) => setTimeout(r, 800))
}

// ---- 阶段 2：放 PORTABLE 标记 → 便携模式
writeFileSync(join(PORTABLE_ROOT, 'PORTABLE'), 'portable mode marker', 'utf8')
{
  const app2 = await launchApp({ HANEHANA_PORTABLE_EXEDIR: PORTABLE_ROOT })
  const info2 = await app2.evalJs(`(async () => { const i = await window.hh.hello(); return { data_dir: i.data_dir, portable: i.portable } })()`)
  console.log('DEBUG info2', JSON.stringify(info2))
  assert('有标记时 data_dir = 便携根\\data', info2.data_dir === PORTABLE_DATA, JSON.stringify(info2))
  assert('有标记时 portable = true', info2.portable === true, JSON.stringify(info2))

  // 便携模式下写入游戏 → games.json 应落在便携 data 目录
  const addR = await app2.evalJs(`(async () => {
    const r = await window.hh.updateGame('g-nonexist', { title: 'x' }) // 无该游戏，纯测通道
    const list = await window.hh.listGames()
    return { len: list.length }
  })()`)
  console.log('DEBUG addR', JSON.stringify(addR))

  // 直接验证便携 data 目录被实际使用：写入一个游戏后（经由 store），games.json 在便携根
  // 用 scan 通道真实写入
  const scanR = await app2.evalJs(`(async () => {
    const r = await window.hh.scanDir(${JSON.stringify(APP_ROOT + '\\node_modules')})
    return { added: r?.added?.length ?? 0, skipped: r?.skipped ?? 0 }
  })()`)
  console.log('DEBUG scanR', JSON.stringify(scanR))
  assert('扫描后便携 data\\games.json 存在', existsSync(join(PORTABLE_DATA, 'games.json')), join(PORTABLE_DATA, 'games.json'))
  assert('普通 data 目录无 games.json（未被误写）', !existsSync(join(DATA_DIR, 'games.json')))
  const scannedGames = JSON.parse(readFileSync(join(PORTABLE_DATA, 'games.json'), 'utf8'))
  assert('便携 games.json 里有入库游戏', Array.isArray(scannedGames) && scannedGames.length > 0, 'count=' + scannedGames.length)

  // 设置页「关于」显示便携目录
  await app2.evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('设置'))?.click()`)
  await new Promise((r) => setTimeout(r, 500))
  await app2.evalJs(`[...document.querySelectorAll('.ant-tabs-tab')].find(t => t.textContent.includes('关于'))?.click()`)
  await new Promise((r) => setTimeout(r, 400))
  const portableShown = await app2.evalJs(`[...document.querySelectorAll('.about-row')].some(r => r.textContent.includes('便携数据目录'))`)
  assert('设置页关于显示「便携数据目录」行', portableShown === true)
  const portableVal = await app2.evalJs(`(() => {
    const rows = [...document.querySelectorAll('.about-row')]
    const row = rows.find(r => r.textContent.includes('便携数据目录'))
    return row ? row.querySelector('.about-val')?.textContent.trim() : ''
  })()`)
  console.log('DEBUG portableVal', JSON.stringify(portableVal))
  assert('便携数据目录值 = ' + PORTABLE_DATA, portableVal === PORTABLE_DATA, JSON.stringify(portableVal))

  app2.close()
}

console.log('===== ' + passed + ' passed, ' + failed + ' failed =====')
process.exit(failed ? 1 : 0)