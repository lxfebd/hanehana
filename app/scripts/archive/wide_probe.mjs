// 宽窗口（用户实机 1692x1031 CSS @ dsf1.5）专项探针：
//  库页：cols 是否跟得上宽视口 / 占位封面色 / cover-shade / detail 收起条几何
//  下载页：.dot 竖条与卡片的关系 / .prog 进度条几何
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const PORT = process.env.HANEHANA_DEBUG_PORT || '9231'
const OUT = join(process.cwd(), 'scripts', 'wide_shots')
mkdirSync(OUT, { recursive: true })
const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = pages.find((p) => p.type === 'page' && p.url.includes('localhost'))
if (!page) throw new Error('no page target')
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

await send('Emulation.setDeviceMetricsOverride', { width: 1692, height: 1031, deviceScaleFactor: 1.5, mobile: false })
await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
await send('Page.bringToFront').catch(() => {})

// 浅色 + 重置详情收起态（模拟用户宽窗）
await evalJs(
  `window.hh.getSettings().then(async (s) => { if (s.dark) await window.hh.saveSettings({ ...s, dark: false }); return true })`,
)
await send('Page.reload', { ignoreCache: true })
await wait(3500)

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  if (r.result?.data) {
    writeFileSync(join(OUT, name), Buffer.from(r.result.data, 'base64'))
    console.log('SHOT:', name)
  }
}

console.log('== 库页 ==')
const lib = await evalJs(`(() => {
  const wall = document.querySelector('.cover-wall')
  const wrap = document.querySelector('.grid-wrapper') || document.querySelector('.scroller')
  const row = document.querySelector('.grid-row')
  const cards = row ? [...row.children] : []
  const detail = document.querySelector('.detail')
  const collapsed = document.querySelector('.detail-collapsed')
  const shade = document.querySelector('.cover-shade')
  const thumbs = [...document.querySelectorAll('.cover-thumb')].slice(0, 4).map(t => {
    const img = t.querySelector('img')
    return { bg: getComputedStyle(t).background.slice(0, 120), hasImg: !!img, imgSrc: img ? img.src.slice(0, 60) : null }
  })
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  return {
    vw: document.documentElement.clientWidth,
    wall: rect(wall), wrap: rect(wrap),
    rowRect: rect(row), cardsInRow: cards.length,
    card0: rect(cards[0]), card1: rect(cards[1]),
    gap: cards.length > 1 ? Math.round(rect(cards[1]).x - (rect(cards[0]).x + rect(cards[0]).w)) : null,
    detail: rect(detail), collapsed: rect(collapsed),
    collapsedBtn: rect(document.querySelector('.detail-collapsed button') || (collapsed && collapsed.querySelector('button'))),
    shade: shade ? { display: getComputedStyle(shade).display, bg: getComputedStyle(shade).background.slice(0, 160), h: Math.round(shade.getBoundingClientRect().height) } : null,
    thumbs,
  }
})()`)
console.log(JSON.stringify(lib, null, 1))
await shot('wide-library.png')

console.log('== 下载页 ==')
await evalJs(`[...document.querySelectorAll('.nav-item')].find(e => e.textContent.includes('下载任务'))?.click()`)
await wait(900)
const dl = await evalJs(`(() => {
  const rows = [...document.querySelectorAll('.task-row')].slice(0, 6)
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  return rows.map(r => {
    const dot = r.querySelector('.dot')
    const prog = r.querySelector('.prog')
    const fill = r.querySelector('.bar-fill')
    const rr = rect(r)
    const dr = rect(dot)
    const pr = rect(prog)
    return {
      state: [...r.classList].join('.'),
      row: rr,
      dotRel: dr && rr ? { leftIn: dr.x - rr.x, topOver: dr.y - rr.y, h: dr.h, rowH: rr.h } : null,
      progRel: pr && rr ? { leftIn: pr.x - rr.x, bottomGap: (rr.y + rr.h) - (pr.y + pr.h), w: pr.w, h: pr.h } : null,
      fill: rect(fill),
    }
  })
})()`)
console.log(JSON.stringify(dl, null, 1))
await shot('wide-downloads.png')

await send('Emulation.clearDeviceMetricsOverride').catch(() => {})
ws.close()
process.exit(0)
