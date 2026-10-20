// 验证封面卡 hover 抬升：模拟鼠标悬停，读 transform/阴影变化
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { rmSync, mkdirSync } from 'node:fs'

const APP_ROOT = join(process.cwd())
const PORT = 9383
const DATA_DIR = join(APP_ROOT, '.hover-data')
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
      const e = await ev('!!document.querySelector(".cover-card")')
      if (e) break
      await new Promise((r) => setTimeout(r, 500))
    }
    await new Promise((r) => setTimeout(r, 1000))
    // 读 hover 前 transform
    const before = JSON.parse(
      await ev(`JSON.stringify((() => { const cs = getComputedStyle(document.querySelector('.cover-card')); return { transform: cs.transform, shadow: getComputedStyle(document.querySelector('.cover-thumb')).boxShadow.slice(0, 30) } })())`),
    )
    console.log('  before:', JSON.stringify(before))
    // 模拟 hover：直接给卡片加 :hover 对应的 style（真实 hover 需 CDP Input.moveMouse）
    // 用 CDP 真实鼠标移到卡片上
    const rect = await ev(`JSON.stringify((() => { const el = document.querySelector('.cover-card'); const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 } })())`)
    const rc = JSON.parse(rect)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rc.x, y: rc.y })
    await new Promise((r) => setTimeout(r, 400))
    const after = JSON.parse(
      await ev(`JSON.stringify((() => { const el = document.querySelector('.cover-card'); const cs = getComputedStyle(el); return { transform: cs.transform, matchedPseudo: cs.transition, shadow: getComputedStyle(document.querySelector('.cover-thumb')).boxShadow.slice(0, 40) } })())`),
    )
    console.log('  after hover:', JSON.stringify(after))
    // transform 含 -3px（translateY(-3px) → matrix(1,0,0,1,0,-3)，第 6 个值）
    const m = /matrix\([^)]*,\s*(-?\d+(?:\.\d+)?)\)$/.exec(after?.transform || '')
    const ty = m ? parseFloat(m[1]) : 0
    ck('hover 抬升 transform 应用', Math.abs(ty + 3) < 0.5 || after?.transform?.includes('-3'), 'transform=' + after?.transform)
    ck('hover 封面阴影变化', (before?.shadow || '') !== (after?.shadow || ''), 'before=' + before?.shadow + ' after=' + after?.shadow)
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