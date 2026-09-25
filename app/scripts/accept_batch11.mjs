// T19.5 验收：G16 新作追踪
// 用法：node scripts/accept_batch11.mjs
//  - 用 HANEHANA_VNDB_MOCK_FILE 提供固定 VNDB 响应（离线，不依赖外网）
//  - 断言：
//    1. 订阅列表可添加/删除/列出（tracking.json 落盘）
//    2. 检查出新作：命中 + fresh 标记（与 seen 去重）
//    3. 二次检查同一部 → 不再 fresh（seenIds 已记录）
//    4. 设置页「新作」页签存在，订阅词渲染
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const APP_ROOT = process.cwd()
const PORT = '9267'
const DATA_DIR = join(APP_ROOT, '.batch11-data')
const MOCK_FILE = join(APP_ROOT, '.batch11-mock.json')
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })

// 固定 VNDB 响应：两部「柚子社」相关的新作（developer.name 含中文以匹配订阅词）
writeFileSync(
  MOCK_FILE,
  JSON.stringify([
    { id: 'v1', title: '新作一号 2026', released: '2026-01-15', developers: [{ developer: { name: '柚子社 (Yuzusoft)' } }] },
    { id: 'v2', title: 'Another Title', released: '2026-02-01', developers: [{ developer: { name: 'Key' } }] },
  ]),
  'utf8',
)

const exe = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const proc = spawn(exe, ['--disable-gpu', '.'], {
  cwd: APP_ROOT,
  env: { ...process.env, HANEHANA_DEBUG_PORT: String(PORT), HANEHANA_DATA_DIR: DATA_DIR, HANEHANA_VNDB_MOCK_FILE: MOCK_FILE },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
let stderr = ''
proc.stderr.on('data', (d) => {
  stderr += d.toString()
  const line = d.toString().trim()
  if (line.includes('[hanehana]') || /Error/.test(line)) process.stdout.write('[app] ' + line.slice(0, 300) + '\n')
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
    ws.onopen = () => { clearTimeout(to); resolve(ws) }
    ws.onerror = () => reject(new Error('ws error'))
  })
}
let passed = 0
let failed = 0
function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log('PASS ' + name) }
  else { failed++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

async function main() {
  const wsUrl = await getWsUrl()
  await new Promise((r) => setTimeout(r, 2500))
  const ws = await connectWs(wsUrl)
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
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await send('Page.bringToFront').catch(() => {})
  await wait(800)

  // ---- 1. 订阅 CRUD
  const addR = await evalJs(`(async () => {
    const r = await window.hh.trackAdd('柚子社')
    return { ok: r?.ok, kw: r?.entry?.keyword, id: r?.entry?.id }
  })()`)
  console.log('DEBUG addR', JSON.stringify(addR))
  assert('添加订阅返回 ok', addR.ok === true, JSON.stringify(addR))
  assert('订阅词为柚子社', addR.kw === '柚子社')

  const dupR = await evalJs(`(async () => {
    const r = await window.hh.trackAdd('柚子社')
    return { ok: r?.ok, id: r?.entry?.id }
  })()`)
  assert('重复订阅返回同一 id（不重复建）', dupR.ok === true && dupR.id === addR.id, JSON.stringify(dupR))

  const listR = await evalJs(`(async () => await window.hh.trackList())()`)
  assert('订阅列表含 1 条', Array.isArray(listR) && listR.length === 1, JSON.stringify(listR))
  assert('tracking.json 已落盘', existsSync(join(DATA_DIR, 'tracking.json')))

  // ---- 2. 检查 → 新作（柚子社 相关命中 1 部）
  const checkR = await evalJs(`(async () => await window.hh.trackCheck())()`)
  console.log('DEBUG checkR', JSON.stringify(checkR))
  assert('检查返回 ok', checkR?.ok === true, JSON.stringify(checkR))
  assert('命中 1 部新作', Array.isArray(checkR?.hits) && checkR.hits.length === 1, JSON.stringify(checkR?.hits))
  assert('fresh 标记新作（未 seen）', Array.isArray(checkR?.fresh) && checkR.fresh.length === 1 && checkR.fresh[0].vnId === 'v1', JSON.stringify(checkR?.fresh))

  // ---- 3. 二次检查同一部 → fresh 空（seenIds 已记录）
  const check2R = await evalJs(`(async () => await window.hh.trackCheck())()`)
  console.log('DEBUG check2R', JSON.stringify(check2R))
  assert('二次检查命中仍在（hits 有）', Array.isArray(check2R?.hits) && check2R.hits.length === 1)
  assert('二次检查 fresh 为空（去重生效）', Array.isArray(check2R?.fresh) && check2R.fresh.length === 0, JSON.stringify(check2R?.fresh))

  // ---- 4. 删除订阅
  const delR = await evalJs(`(async () => {
    const r = await window.hh.trackRemove(${JSON.stringify(addR.id)})
    const list = await window.hh.trackList()
    return { ok: r?.ok, len: list.length }
  })()`)
  assert('删除订阅后列表为空', delR.ok === true && delR.len === 0, JSON.stringify(delR))

  // ---- 5. 设置页「新作」页签存在
  await evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('设置'))?.click()`)
  await wait(500)
  const trackTab = await evalJs(`[...document.querySelectorAll('.ant-tabs-tab')].some(t => t.textContent.includes('新作'))`)
  assert('设置页有「新作」页签', trackTab === true)

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