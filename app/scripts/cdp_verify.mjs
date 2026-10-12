// 连 Electron CDP，验证真实窗口：DOM 文本、preload 桥状态、截图。
// 用法：node scripts/cdp_verify.mjs [--shot out.png]
import { writeFileSync } from 'node:fs'

const BASE = 'http://127.0.0.1:9222'

async function main() {
  const pages = await (await fetch(`${BASE}/json`)).json()
  const page = pages.find((t) => t.type === 'page' && t.url.includes('localhost:5173'))
  if (!page) {
    console.log('NO_PAGE', pages.map((t) => `${t.type}:${t.title}`).join(' | '))
    return
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id
      pending.set(mid, resolve)
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
  await new Promise((r) => (ws.onopen = r))

  // 等待渲染完成
  await send('Runtime.evaluate', {
    expression: `new Promise(r => { if (document.querySelector('.hero h1')) r(true); else setTimeout(() => r(false), 3000) })`,
    awaitPromise: true,
    returnByValue: true,
  })

  const evalJs = async (expr) => {
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
    return res.result?.result?.value
  }

  const title = await evalJs('document.title')
  const h1 = await evalJs(`document.querySelector('.hero h1')?.textContent ?? '(missing)'`)
  const navItems = await evalJs(`[...document.querySelectorAll('.nav-item')].map(e => e.textContent).join(',')`)
  const bootInfo = await evalJs(`document.querySelector('.hero .status')?.textContent ?? '(missing)'`)
  const bridge = await evalJs(`typeof window.hh`)
  const hello = await evalJs(
    `(async () => { try { const r = await window.hh?.hello(); return r ? r.name + '@' + r.version : 'n/a' } catch (e) { return 'ERR:' + e.message } })()`,
  )

  console.log('TITLE:', title)
  console.log('H1:', h1)
  console.log('NAV:', navItems)
  console.log('BOOT:', bootInfo)
  console.log('BRIDGE:', bridge)
  console.log('HELLO:', hello)

  // 截图
  if (process.argv.includes('--shot')) {
    const idx = process.argv.indexOf('--shot')
    const out = process.argv[idx + 1] ?? 'hh_cdp.png'
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    if (shot.result?.data) {
      writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
      console.log('SHOT:', out)
    } else {
      console.log('SHOT_FAIL', JSON.stringify(shot).slice(0, 300))
    }
  }
  ws.close()
}
main().catch((e) => {
  console.log('FATAL', e.message)
  process.exit(1)
})
