// 双主题截图 + 布局检查：分别切到深浅色，截图库页/下载页/设置弹窗。
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const PORT = process.env.THEME_PORT || '9230'
const OUT = join(process.cwd(), 'scripts', 'theme_shots')
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

await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
await send('Page.bringToFront').catch(() => {})
await wait(600)

let passed = 0,
  failed = 0
const check = (name, cond, detail = '') => {
  if (cond) {
    passed++
    console.log(`PASS  ${name}`)
  } else {
    failed++
    console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`)
  }
}

async function shot(name, selector = '.layout') {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  if (r.result?.data) {
    writeFileSync(join(OUT, name), Buffer.from(r.result.data, 'base64'))
    console.log('SHOT:', name)
  }
}

async function layoutCheck() {
  const overflow = await evalJs(`(() => {
    const doc = document.documentElement
    const layout = document.querySelector('.layout')
    return {
      docSw: doc.scrollWidth, vw: doc.clientWidth,
      horizontalOverflow: doc.scrollWidth > doc.clientWidth + 2,
      layoutRect: layout ? { w: layout.clientWidth, sw: layout.scrollWidth } : null,
    }
  })()`)
  return overflow
}

// ===== 深色 =====
// 确保起点深色
await evalJs(
  `window.hh.getSettings().then(async (s) => { if (!s.dark) await window.hh.saveSettings({ ...s, dark: true }); return true })`,
)
await send('Page.reload', { ignoreCache: true })
await wait(3500)

const darkOv = await layoutCheck()
console.log('DARK_LAYOUT:', JSON.stringify(darkOv))
check('深色无横向溢出', darkOv?.horizontalOverflow === false, JSON.stringify(darkOv))
await wait(400)
await shot('dark-library.png')

// 切下载页
await evalJs(`[...document.querySelectorAll('.nav-item')].find(e => e.textContent.includes('下载任务'))?.click()`)
await wait(800)
const dlOv = await layoutCheck()
console.log('DARK_DL_LAYOUT:', JSON.stringify(dlOv))
check('深色下载页无横向溢出', dlOv?.horizontalOverflow === false, JSON.stringify(dlOv))
await shot('dark-downloads.png')

// 回库页并打开设置
await evalJs(`[...document.querySelectorAll('.nav-item')].find(e => e.textContent.includes('全部游戏'))?.click()`)
await wait(600)
await evalJs(`[...document.querySelectorAll('.nav-item')].find(e => e.textContent.includes('设置'))?.click()`)
await wait(900)
await shot('dark-settings.png')
await evalJs(`document.querySelector('.ant-modal-close')?.click()`)
await wait(800)

// ===== 浅色 =====
await evalJs(
  `window.hh.getSettings().then(async (s) => { if (s.dark) await window.hh.saveSettings({ ...s, dark: false }); return true })`,
)
await send('Page.reload', { ignoreCache: true })
await wait(3500)
const lightOv = await layoutCheck()
console.log('LIGHT_LAYOUT:', JSON.stringify(lightOv))
check('浅色无横向溢出', lightOv?.horizontalOverflow === false, JSON.stringify(lightOv))
await shot('light-library.png')

await evalJs(`[...document.querySelectorAll('.nav-item')].find(e => e.textContent.includes('下载任务'))?.click()`)
await wait(800)
const lightDlOv = await layoutCheck()
console.log('LIGHT_DL_LAYOUT:', JSON.stringify(lightDlOv))
check('浅色下载页无横向溢出', lightDlOv?.horizontalOverflow === false, JSON.stringify(lightDlOv))
await shot('light-downloads.png')

await evalJs(`[...document.querySelectorAll('.nav-item')].find(e => e.textContent.includes('全部游戏'))?.click()`)
await wait(600)
await evalJs(`[...document.querySelectorAll('.nav-item')].find(e => e.textContent.includes('设置'))?.click()`)
await wait(900)
await shot('light-settings.png')

console.log(`\n==== ${passed} passed, ${failed} failed ====`)
ws.close()
process.exit(failed > 0 ? 1 : 0)
