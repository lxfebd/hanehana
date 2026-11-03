// UI 层叠回归闸门（真机命中测试）：打开每个浮层/弹窗，用 document.elementFromPoint
// 断言「浮层是命中点最顶层元素」——若被下面的游戏卡片/其它内容盖住则 FAIL。
// 用法：node scripts/verify_ui_layers.mjs
// 覆盖的浮层：右键菜单 / 导出下拉 / 批量编辑浮条 / 详情整页展开 / 设置对话框 /
// 侧栏"更多"菜单 / 快捷键帮助面板。
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'

const APP_ROOT = process.cwd()
const PORT = 9423
const DATA_DIR = join(APP_ROOT, '.uilayer-data')
const SHOTS = join(APP_ROOT, '.shots', 'uilayer')
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
mkdirSync(SHOTS, { recursive: true })
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 页内命中探针：对 sel 指向的浮层，在其内部网格采样 + 与 .cover-card 相交处采样，
// 任一采样点 elementFromPoint 的最顶层不是浮层自身/后代 ⇒ 被盖住。
const PROBE = `(sel) => {
  const el = document.querySelector(sel)
  if (!el) return { found: false }
  const r = el.getBoundingClientRect()
  if (r.width < 4 || r.height < 4) return { found: true, tiny: true, rect: [r.left, r.top, r.width, r.height].map(Math.round) }
  const pts = []
  const N = 5
  for (let i = 1; i < N; i++) for (let j = 1; j < N; j++) pts.push([r.left + (r.width * i) / N, r.top + (r.height * j) / N])
  for (const c of document.querySelectorAll('.cover-card')) {
    const cr = c.getBoundingClientRect()
    const x0 = Math.max(r.left, cr.left), y0 = Math.max(r.top, cr.top)
    const x1 = Math.min(r.right, cr.right), y1 = Math.min(r.bottom, cr.bottom)
    if (x1 > x0 + 2 && y1 > y0 + 2) pts.push([(x0 + x1) / 2, (y0 + y1) / 2])
  }
  const bad = []
  for (const p of pts) {
    const top = document.elementFromPoint(p[0], p[1])
    if (!top) continue
    if (top === el || el.contains(top)) continue
    bad.push({
      x: Math.round(p[0]), y: Math.round(p[1]),
      tag: top.tagName,
      cls: String(top.className || '').split(' ').slice(0, 3).join('.'),
      inCard: !!top.closest('.cover-card'),
    })
  }
  return { found: true, rect: [r.left, r.top, r.width, r.height].map(Math.round), total: pts.length, badCount: bad.length, bad: bad.slice(0, 5) }
}`

async function main() {
  const wsUrl = await getWsUrl()
  await sleep(2500)
  const port = (wsUrl.match(/:(\d+)\//) || [])[1]
  let pageJson = null
  for (let i = 0; i < 20 && !pageJson; i++) {
    try {
      const l = await (await fetch('http://127.0.0.1:' + port + '/json')).json()
      pageJson =
        l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && /index\.html|renderer/.test(t.url || '')) ??
        l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ??
        null
    } catch {
      /* retry */
    }
    if (!pageJson) await sleep(500)
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
          rej(new Error('timeout ' + method))
        }
      }, 30000)
    })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.exception?.description ?? '') }
    return r.result?.result?.value
  }
  const probe = (sel) => ev('(' + PROBE + ')(' + JSON.stringify(sel) + ')')
  const shot = async (name) => {
    try {
      await send('Page.enable')
      const r = await send('Page.captureScreenshot', { format: 'png' })
      if (r.result?.data) writeFileSync(join(SHOTS, name + '.png'), Buffer.from(r.result.data, 'base64'))
    } catch {
      /* 截图失败不阻断 */
    }
  }
  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    await sleep(200)
  }
  const esc = async () => {
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    }
    await sleep(250)
  }
  const pressQ = async () => {
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', { type, key: '?', code: 'Slash', windowsVirtualKeyCode: 191, nativeVirtualKeyCode: 191, text: '?' })
    }
    await sleep(400)
  }

  try {
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    let pass = 0
    let fail = 0
    const ck = (n, c, x = '') => {
      if (c) {
        pass++
        console.log('  [PASS] ' + n)
      } else {
        fail++
        console.log('  [FAIL] ' + n + (x ? '  ' + x : ''))
      }
    }
    const scenario = async (name, sel) => {
      await sleep(500)
      const p = await probe(sel)
      await shot(name)
      if (!p || !p.found) {
        ck(name, false, '浮层未出现: ' + sel + ' ' + JSON.stringify(p))
        return false
      }
      if (p.tiny) {
        ck(name, false, '浮层尺寸异常: ' + JSON.stringify(p.rect))
        return false
      }
      ck(name, p.badCount === 0, '被盖住采样 ' + p.badCount + '/' + p.total + ' rect=' + JSON.stringify(p.rect) + ' bad=' + JSON.stringify(p.bad))
      return p.badCount === 0
    }

    // 进库页
    await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => (x.textContent || '').includes('全部游戏') || (x.textContent || '').includes('Library')); if (b) { b.click(); return 'ok' } return 'no' })()`)
    await sleep(800)
    for (let i = 0; i < 20; i++) {
      if (await ev('!!document.querySelector(".cover-card")')) break
      await sleep(500)
    }
    await ev('document.querySelector(".cover-card")?.scrollIntoView({ block: "center" })')
    await sleep(600)
    ck('库页封面墙就绪', await ev('!!document.querySelector(".cover-card")'))

    // ---- 1. 右键菜单 .ctx-menu（Teleport body, z 1100）----
    await ev(`(() => { const c = document.querySelector('.cover-card'); if (!c) return 'no-card'; const r = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + r.width/2, clientY: r.top + r.height/2, button: 2 })); return 'ok' })()`)
    await scenario('右键菜单 ctx-menu', '.ctx-menu')
    await esc()
    await sleep(300)

    // ---- 2. 导出下拉 .export-menu（absolute z30，未 Teleport —— 重点怀疑对象）----
    await ev(`(() => { const b = document.querySelector('.export-wrap button'); if (b) { b.click(); return 'ok' } return 'no' })()`)
    await scenario('导出下拉 export-menu', '.export-menu')
    await ev(`(() => { const b = document.querySelector('.export-wrap button'); if (b) { b.click(); return 'ok' } return 'no' })()`)
    await sleep(300)

    // ---- 3. 侧栏"更多"菜单 .more-menu（absolute z40）----
    await ev(`(() => { const b = document.querySelector('.more-toggle'); if (b) { b.click(); return 'ok' } return 'no' })()`)
    await scenario('侧栏更多菜单 more-menu', '.more-menu')
    await ev(`(() => { const b = document.querySelector('.more-toggle'); if (b) { b.click(); return 'ok' } return 'no' })()`)
    await sleep(300)

    // ---- 4. 设置对话框 .ds-panel（DialogShell, Teleport body, z1000）----
    await ev(`(() => { const b = document.querySelector('.tb-round'); if (b) { b.click(); return 'ok' } return 'no' })()`)
    await scenario('设置对话框 ds-panel', '.ds-panel')
    await esc()
    await sleep(300)

    // ---- 5. 快捷键帮助 .sc-panel（Teleport body, modal 层）----
    await esc()
    await pressQ()
    await scenario('快捷键帮助 sc-panel', '.sc-panel')
    // ShortcutHelp 自己 stopPropagation，Esc 不一定退它——点关闭钮确保关掉
    await ev('document.querySelector(".sc-close")?.click(); true')
    await sleep(300)

    // ---- 6. 详情整页展开 .detail-panel.is-expanded（fixed z60，嵌套在 .layout 内 —— 重点怀疑对象）----
    // 先单击一张卡选中，右栏出现 DetailPanel
    await ev(`(() => { const c = document.querySelector('.cover-card'); if (!c) return 'no-card'; c.click(); return 'ok' })()`)
    await sleep(700)
    ck('选中游戏后详情面板出现', await ev('!!document.querySelector(".detail-panel")'))
    await ev(`(() => { const b = document.querySelector('.dp-head-actions .dp-icon-btn[aria-pressed]'); if (b) { b.click(); return 'ok' } return 'no' })()`)
    await sleep(500)
    ck('详情面板进入 is-expanded', await ev('!!document.querySelector(".detail-panel.is-expanded")'))
    await scenario('详情整页展开 detail-panel.is-expanded', '.detail-panel.is-expanded')
    await ev(`(() => { const b = document.querySelector('.dp-head-actions .dp-icon-btn[aria-pressed]'); if (b) { b.click(); return 'ok' } return 'no' })()`)
    await sleep(400)

    // ---- 7. 批量编辑浮条 .batch-overlay（absolute z30，在 .cover-wrap 内 —— 重点怀疑对象）----
    await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-pressed') !== null) && ((x.title || '') + (x.textContent || '')).includes('多选')); if (b) { b.click(); return 'ok' } return 'no' })()`)
    await sleep(400)
    const rects = JSON.parse(
      await ev(`JSON.stringify([...document.querySelectorAll('.cover-card')].slice(0, 2).map(c => { const r = c.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 } }))`),
    )
    for (const rc of rects) await clickAt(rc.x, rc.y)
    await sleep(700)
    await scenario('批量编辑浮条 batch-overlay', '.batch-overlay')
    await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-pressed') !== null) && ((x.title || '') + (x.textContent || '')).includes('多选')); if (b) { b.click(); return 'ok' } return 'no' })()`)

    console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====')
    if (fail > 0) process.exitCode = 1
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
