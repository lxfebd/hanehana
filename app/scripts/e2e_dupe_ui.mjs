// E2E：同款不同目录 → 判重后 dupe 明细回给 UI，且「也加进来」真能入库。
// 场景即用户机器实测：G:\ggame 与 F:\gg 各放同一批游戏。
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = join(here, '..')
const PORT = 9283
const DATA_DIR = join(APP_ROOT, '.dupe-ui')
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })

const NAMES = [
  ['妹相随1.4.5+DLC+fffmod1.6.0 步兵整合包小黑盒叮卜汉化（全部使用daseson上色）', 'GamePro.exe'],
  ['妹相随1.4.5+DLC+fffmod1.6.0 步兵整合包小黑盒叮卜汉化（黑白版本！！！）', 'GamePro.exe'],
  ["Yog-Sothoth's Yard", "Yog-Sothoth's Yard.exe"],
]
const G = join(DATA_DIR, 'G', 'ggame')
const F = join(DATA_DIR, 'F', 'gg')
for (const root of [G, F]) {
  for (const [n, exe] of NAMES) {
    mkdirSync(join(root, n), { recursive: true })
    writeFileSync(join(root, n, exe), '')
  }
}

const exe = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const env = { ...process.env, HANEHANA_DEBUG_PORT: String(PORT), HANEHANA_DATA_DIR: DATA_DIR }
delete env.ELECTRON_RUN_AS_NODE
const proc = spawn(exe, ['.'], { cwd: APP_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let stderr = ''
proc.stderr.on('data', (d) => (stderr += d))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function pageWsUrl() {
  for (let i = 0; i < 120; i++) {
    try {
      const t = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const p = t.find((x) => x.type === 'page' && x.webSocketDebuggerUrl)
      if (p) return p.webSocketDebuggerUrl
    } catch { /* 等启动 */ }
    await sleep(300)
  }
  throw new Error('no page target; ' + stderr.slice(-300))
}
const ws = new WebSocket(await pageWsUrl())
await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })
let mid = 0
const pend = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
})
const send = (method, params = {}) => new Promise((r) => { const id = ++mid; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
async function ev(e) {
  const m = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })
  if (m.error) throw new Error(JSON.stringify(m.error))
  return m.result?.result?.value
}

for (let i = 0; i < 60; i++) {
  if (await ev('!!(window.hh && window.hh.scanDir)')) break
  await sleep(300)
}

const r1 = JSON.parse(await ev(`window.hh.scanDir(${JSON.stringify(G)}).then(JSON.stringify)`))
console.log('=== 扫 G 盘 ===')
console.log('  added:', r1.added.length, ' skipped:', r1.skipped, ' dupes:', r1.dupes.length)

const r2 = JSON.parse(await ev(`window.hh.scanDir(${JSON.stringify(F)}).then(JSON.stringify)`))
console.log('=== 扫 F 盘（同款不同盘）===')
console.log('  added:', r2.added.length, ' skipped:', r2.skipped, ' dupes:', r2.dupes.length)
r2.dupes.forEach((d) => console.log('   dupe:', d.rawTitle.slice(0, 20), '→ 库里已有:', d.kept))

// 点「也加进来」：走 addGameOne
let lib = JSON.parse(await ev('window.hh.listGames().then(JSON.stringify)'))
console.log('=== 加之前库内:', lib.length, '款 ===')
if (r2.dupes.length) {
  const target = r2.dupes[0]
  const rr = JSON.parse(await ev(`window.hh.addGameOne(${JSON.stringify(target.exePath)}).then(JSON.stringify)`))
  console.log('  也加进来 →', rr.ok ? '成功' : ('失败: ' + rr.error))
  lib = JSON.parse(await ev('window.hh.listGames().then(JSON.stringify)'))
}
console.log('=== 加之后库内:', lib.length, '款 ===')
// 判定语义：上面的 dupes 是"未入库的同款"，用户主动点「也加进来」后出现同名款
// 是预期（他就是要两份）。真正的回归是——**未经确认**的同款不得自动入库，
// 即扫描返回值 dupes 里列出的路径，不能同时出现在 added 里。
const addedExes = new Set((r2.added ?? []).map((g) => g.exePath.toLowerCase()))
const dupeExes = (r2.dupes ?? []).map((d) => d.exePath.toLowerCase())
const leak = dupeExes.filter((e) => addedExes.has(e))
console.log(leak.length === 0 ? 'PASS 未经确认的同款零入库' : 'FAIL 自动入库了 dupe: ' + JSON.stringify(leak))

// 扫描结果浮层是否真的渲染出 dupe 区块 + 按钮
const ui = JSON.parse(await ev(`(async () => {
  const btn = [...document.querySelectorAll('button')].find(b => (b.textContent||'').includes('扫描'))
  if (btn) btn.click()
  await new Promise(r => setTimeout(r, 500))
  const input = document.querySelector('.scan-body .path-input')
  if (input) { input.value = ${JSON.stringify(F)}; input.dispatchEvent(new Event('input')) }
  await new Promise(r => setTimeout(r, 300))
  const start = [...document.querySelectorAll('.scan-btn')].find(b => (b.textContent||'').includes('开始扫描'))
  if (start) start.click()
  await new Promise(r => setTimeout(r, 4000))
  return JSON.stringify({
    dupeBlock: !!document.querySelector('.dupes'),
    dupeTitle: (document.querySelector('.dupes .hits-title')||{}).textContent,
    dupeRows: document.querySelectorAll('.dupe-row').length,
    addBtns: [...document.querySelectorAll('.dupe-add')].map(b => b.textContent.trim()),
  })
})()`))
console.log('[扫描浮层 UI]', JSON.stringify(ui))

ws.close()
spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
setTimeout(() => process.exit(0), 1500)
