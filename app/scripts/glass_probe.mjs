// 玻璃/圆角轮专项探针：选中游戏后截 深色库页 / 浅色库页 / 深色下载页，
// 并量测面板半透明度、app-bg 是否挂上封面、标题栏文本。
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
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
await new Promise((r) => (ws.onopen = r))
const send = (method, params = {}) => new Promise((res) => { const mid = ++msgId; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })) })
const evalJs = async (expr) => {
  const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (res.result?.exceptionDetails) return { __err: String(res.result.exceptionDetails.exception?.description ?? 'eval failed') }
  return res.result?.result?.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  if (r.result?.data) { writeFileSync(join(OUT, name), Buffer.from(r.result.data, 'base64')); console.log('SHOT:', name) }
}

await send('Emulation.setDeviceMetricsOverride', { width: 1692, height: 1031, deviceScaleFactor: 1.5, mobile: false })
await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
await send('Page.bringToFront').catch(() => {})

async function setDark(dark) {
  await evalJs(`window.hh.getSettings().then(async (s) => { if (s.dark !== ${dark}) await window.hh.saveSettings({ ...s, dark: ${dark} }); return true })`)
  await send('Page.reload', { ignoreCache: true })
  await wait(3500)
}

async function selectGame(idx) {
  return evalJs(`(() => {
    const cards = document.querySelectorAll('.cover-card')
    if (!cards[${idx}]) return 'no-card'
    cards[${idx}].click()
    return 'clicked'
  })()`)
}

const probe = () => evalJs(`(() => {
  const bg = document.querySelector('.app-bg')
  const detail = document.querySelector('.detail')
  const sidebar = document.querySelector('.sidebar')
  const cs = (el) => el ? getComputedStyle(el) : null
  return {
    titlebar: document.querySelector('.titlebar')?.textContent?.trim(),
    bgImage: bg ? getComputedStyle(bg).backgroundImage.slice(0, 80) : null,
    detailBg: detail ? cs(detail).backgroundColor : null,
    sidebarBg: sidebar ? cs(sidebar).backgroundColor : null,
    detailBlur: detail ? cs(detail).backdropFilter : null,
  }
})()`)

// 深色 + 选中 ATRI（棕调封面，光晕明显）
await setDark(true)
console.log('select:', await selectGame(4))
await wait(800)
console.log('DARK ', JSON.stringify(await probe(), null, 1))
await shot('glass2-dark-selected.png')

// 浅色 + 选中同一游戏
await setDark(false)
console.log('select:', await selectGame(4))
await wait(800)
console.log('LIGHT', JSON.stringify(await probe(), null, 1))
await shot('glass2-light-selected.png')

// 浅色下载页（无选中光晕，纯面板玻璃）
await evalJs(`(() => { const items=[...document.querySelectorAll('.nav-item')]; const d=items.find(i=>i.textContent.includes('下载')); if(d) d.click(); return !!d })()`)
await wait(600)
await shot('glass2-light-downloads.png')
ws.close()
