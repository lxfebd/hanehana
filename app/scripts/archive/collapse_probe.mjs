// 收起态 + 变宽列数联动探针
const PORT = process.env.HANEHANA_DEBUG_PORT || '9231'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
const OUT = join(process.cwd(), 'scripts', 'wide_shots')
mkdirSync(OUT, { recursive: true })
const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = pages.find((p) => p.type === 'page' && p.url.includes('localhost'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
let msgId = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
}
await new Promise((r) => (ws.onopen = r))
const send = (method, params = {}) =>
  new Promise((res) => {
    const mid = ++msgId
    pending.set(mid, res)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
const evalJs = async (expr) => {
  const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (res.result?.exceptionDetails)
    return { __err: String(res.result.exceptionDetails.exception?.description ?? 'eval failed') }
  return res.result?.result?.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  if (r.result?.data) {
    writeFileSync(join(OUT, name), Buffer.from(r.result.data, 'base64'))
    console.log('SHOT:', name)
  }
}

const state = () =>
  evalJs(`(() => {
  const wall = document.querySelector('.cover-wall')
  const row = document.querySelector('.grid-row')
  const collapsed = document.querySelector('.detail-collapsed')
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  return {
    vw: document.documentElement.clientWidth,
    wall: rect(wall) && { w: rect(wall).w, x: rect(wall).x },
    cardsInRow: row ? row.children.length : null,
    collapsedRect: rect(collapsed),
    collapsedBtn: rect(collapsed && collapsed.querySelector('button')),
    collapseBtnInDetail: rect(document.querySelector('.detail button')),
  }
})()`)

await send('Emulation.setDeviceMetricsOverride', { width: 1692, height: 1031, deviceScaleFactor: 1.5, mobile: false })
await send('Page.bringToFront').catch(() => {})
await wait(800)
// 回到库页
await evalJs(`[...document.querySelectorAll('.nav-item')].find(e => e.textContent.includes('全部游戏'))?.click()`)
await wait(800)
console.log('A 展开态:', JSON.stringify(await state()))

// 点收起按钮（DetailPanel 头部 PanelRightClose）
const clicked = await evalJs(`(() => {
  const btns = [...document.querySelectorAll('.detail button')]
  const b = btns[0]
  if (b) { b.click(); return true }
  return false
})()`)
console.log('clicked collapse:', clicked)
await wait(900)
const b = await state()
console.log('B 收起态:', JSON.stringify(b))
await shot('collapsed-1692.png')

// 缩到 960 再拉回 1692，验证 ResizeObserver 跟得上
await send('Emulation.setDeviceMetricsOverride', { width: 960, height: 800, deviceScaleFactor: 1.5, mobile: false })
await wait(900)
console.log('C 960:', JSON.stringify(await state()))
await send('Emulation.setDeviceMetricsOverride', { width: 1692, height: 1031, deviceScaleFactor: 1.5, mobile: false })
await wait(900)
console.log('D 回1692:', JSON.stringify(await state()))
await shot('resize-back-1692.png')

await send('Emulation.clearDeviceMetricsOverride').catch(() => {})
ws.close()
process.exit(0)
