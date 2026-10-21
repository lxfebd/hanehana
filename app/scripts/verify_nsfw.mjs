// NSFW 遮盖验证：seed 一款带成人 tag（Sexual Content）的游戏 → 封面卡遮盖层渲染，
// 点击遮盖层临时显示（解除遮盖）。对标 ReinaManager 的 NSFW 遮盖功能。
// 用法：node scripts/verify_nsfw.mjs
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const APP_ROOT = join(process.cwd())
const PORT = 9403
const DATA_DIR = join(APP_ROOT, '.nsfw-data')
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
// 给第一款游戏加成人 tag（VNDB 的 Sexual Content）
{
  const gp = join(DATA_DIR, 'games.json')
  const games = JSON.parse(readFileSync(gp, 'utf8'))
  games[0].tags = [...(games[0].tags || []), 'Sexual Content']
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
      const e = await ev('!!document.querySelector(".cover-card")')
      if (e) break
      await new Promise((r) => setTimeout(r, 500))
    }
    await new Promise((r) => setTimeout(r, 1000))
    const st = JSON.parse(
      await ev(`JSON.stringify((() => {
        const nsfw = document.querySelectorAll('.cover-nsfw')
        const first = nsfw[0]
        return {
          count: nsfw.length,
          text: first ? first.textContent.trim() : '',
          title: first ? (first.title || '') : '',
        }
      })())`),
    )
    ck('NSFW 遮盖层渲染', st.count >= 1, 'count=' + st.count)
    ck('遮盖文案「成人内容」', (st.text || '').includes('成人'), 'text=' + st.text)
    // 点击遮盖层 → 临时显示（解除）。用 CDP 真实鼠标点击覆盖层中心（真实用户路径）
    const rect = await ev(`JSON.stringify((() => { const n = document.querySelector('.cover-nsfw'); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 } })())`)
    if (rect) {
      const rc = JSON.parse(rect)
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rc.x, y: rc.y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rc.x, y: rc.y, button: 'left', clickCount: 1 })
    }
    await new Promise((r) => setTimeout(r, 800))
    const after = await ev(`document.querySelectorAll('.cover-nsfw').length`)
    const revealed = await ev(`(() => { const img = document.querySelector('.cover-thumb img'); return !!(img && img.complete && img.naturalWidth > 0) })()`)
    ck('点击遮盖层后解除（遮盖消失）', after === 0, 'after=' + after)
    ck('解除后封面可见', revealed === true, 'revealed=' + revealed)
    console.log('  NSFW:', JSON.stringify({ count: st.count, text: st.text, after: after }))
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