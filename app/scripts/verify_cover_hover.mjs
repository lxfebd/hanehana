// 验证封面卡 hover 抬升：模拟鼠标悬停，读 transform/阴影变化
import { spawn, spawnSync } from 'node:child_process'
import { pickFreePort, killTree } from './lib/probePort.mjs'
import { join } from 'node:path'
import { rmSync, mkdirSync } from 'node:fs'
import { waitFor } from './lib/waitFor.mjs'

const APP_ROOT = join(process.cwd())
const PORT = await pickFreePort()
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
  // DevTools 已在监听 ⇒ /json 立刻可取；下面 /json 循环本身就是条件等待。原来固定 2500ms 是白等。
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
        fail++; process.exitCode = 1
        console.log('  [FAIL] ' + n + ' ' + (x || ''))
      }
    }
    // 启动页现在是 home 仪表盘（B8）——封面墙在库页，先导航过去
    // 先等应用就绪（原来这里是固定 2500ms）：慢机上侧栏还没渲染就点导航会拿到 'no'。
    await waitFor(() => ev('!!(window.hh && document.querySelector(".sidebar .nav-item"))'), { timeoutMs: 30000, label: '应用就绪（hh + 侧栏导航）' })
    await ev(`(() => { const b = document.querySelector('[data-testid="nav-library"]'); if (b) { b.click(); return 'ok' } return 'no' })()`)
    // 切页后等封面墙渲染（固定 800+1000ms 与手拉循环都换成条件等待）
    await waitFor(() => ev('!!document.querySelector(".cover-card")'), { timeoutMs: 15000, label: '库页封面墙出现（.cover-card）' })
    // 页头 + KPI 条 + hero + 续读条会占满首屏，封面墙第一行在视口下方——
    // 不滚过去 CDP 鼠标就移到窗口外，hover 根本不触发（elementFromPoint = null）。
    // 这是「首屏有了内容」的必然结果，不是卡片回归。
    await ev(`(() => { const el = document.querySelector('.cover-card'); el?.scrollIntoView({ block: 'center' }); return true })()`)
    // 等滚动真正落位（卡片进视口再移鼠标），原来固定 600ms
    await waitFor(() => ev('(() => { const c = document.querySelector(".cover-card"); if (!c) return false; const r = c.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight })()'), { timeoutMs: 5000, label: '封面墙滚动落位' })
    // 读 hover 前 transform
    const before = JSON.parse(
      await ev(`JSON.stringify((() => { const cs = getComputedStyle(document.querySelector('.cover-card')); return { transform: cs.transform, shadow: getComputedStyle(document.querySelector('.cover-thumb')).boxShadow } })())`),
    )
    console.log('  before:', JSON.stringify(before))
    // 模拟 hover：直接给卡片加 :hover 对应的 style（真实 hover 需 CDP Input.moveMouse）
    // 用 CDP 真实鼠标移到卡片上
    const rect = await ev(`JSON.stringify((() => { const el = document.querySelector('.cover-card'); const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 } })())`)
    const rc = JSON.parse(rect)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rc.x, y: rc.y })
    // 等 hover 的 transform 与 box-shadow 过渡都到终值（getComputedStyle 读到的是过渡中的中间值）：
    // CSS 口径取自 CoverGrid.vue 的 .cover-card:hover / .cover-card:hover .cover-thumb（0 12px 28px）。
    await waitFor(
      () => ev('(() => { const cs = getComputedStyle(document.querySelector(".cover-card")); const s = getComputedStyle(document.querySelector(".cover-thumb")).boxShadow; const px = s.split(" ").filter((x) => x.endsWith("px")).map((x) => parseFloat(x)); return cs.transform !== ' + JSON.stringify(before.transform) + ' && px.length >= 3 && px[1] === 12 && px[2] === 28 })()'),
      { timeoutMs: 3000, label: 'hover 过渡到终值（transform + 0 12px 28px 阴影）' },
    )
    const after = JSON.parse(
      await ev(`JSON.stringify((() => { const el = document.querySelector('.cover-card'); const cs = getComputedStyle(el); return { transform: cs.transform, matchedPseudo: cs.transition, shadow: getComputedStyle(document.querySelector('.cover-thumb')).boxShadow } })())`),
    )
    console.log('  after hover:', JSON.stringify(after))
    // transform 含 -3px（translateY(-3px) → matrix(1,0,0,1,0,-3)，第 6 个值）
    const m = /matrix\([^)]*,\s*(-?\d+(?:\.\d+)?)\)$/.exec(after?.transform || '')
    const ty = m ? parseFloat(m[1]) : 0
    // 只认解析出来的数值：原来的「Math.abs(ty + 3) < 0.5 || transform.includes('-3')」里，
    // 兜底那半句会让 matrix 的 -30px 也过（包含 '-3' 就算对）。CSS 是 translateY(-3px)。
    ck('hover 抬升 transform 应用（解析值 -3px）', m !== null && Math.abs(ty + 3) < 0.5, 'transform=' + after?.transform + ' ty=' + ty)
    // 阴影不再是「变了就行」：hover 值是 0 12px 28px var(--hh-color-thumb-shadow)，
    // 断言「不是 none + 与 hover 前不同 + 偏移/模糊与 CSS 一致」；数值取自 CoverGrid.vue，不引入新魔数。
    const px = String(after?.shadow || '')
      .split(' ')
      .filter((x) => x.endsWith('px'))
      .map((x) => parseFloat(x))
    ck(
      'hover 封面阴影为 0 12px 28px（thumb-shadow）',
      String(after?.shadow || '') !== 'none' &&
        String(after?.shadow || '') !== String(before?.shadow || '') &&
        px.length >= 3 &&
        px[1] === 12 &&
        px[2] === 28,
      'before=' + before?.shadow + ' after=' + after?.shadow,
    )
    console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====')
  } finally {
    ws.close()
    killTree(proc)
  }
}
main().catch((e) => {
  console.error(e)
  console.error(stderr.slice(-1200))
  try {
    killTree(proc)
  } catch {
    /* ignore */
  }
  process.exit(1)
})