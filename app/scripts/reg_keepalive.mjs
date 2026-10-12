// 核心回归：游戏站保活（keep-alive）。
// 断言：切到游戏站 → 切回库页 → 再切回游戏站，
//       webview DOM 节点是同一个（未重挂载 → 站点状态不丢）。
// 用法：node scripts/reg_keepalive.mjs   （须先有实例在 HANEHANA_DEBUG_PORT）
const PORT = process.env.HANEHANA_DEBUG_PORT || '9231'

let passed = 0,
  failed = 0
const check = (name, cond, detail = '') => {
  if (cond) {
    passed++
    console.log('PASS  ' + name)
  } else {
    failed++
    console.log('FAIL  ' + name + (detail ? ' — ' + detail : ''))
  }
}

const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = pages.find((p) => p.type === 'page' && !p.url.startsWith('devtools'))
if (!page) throw new Error('no page target on ' + PORT)
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
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails)
    return { __err: String(r.result.exceptionDetails.exception?.description ?? 'eval failed') }
  return r.result?.result?.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
await wait(600)

// 切到游戏站
const first = await evalJs(`(async () => {
  const moreBtn = [...document.querySelectorAll('.nav-item.more-toggle')].find(e => e.textContent.includes('更多'))
  if (moreBtn) moreBtn.click()
  await new Promise(r => setTimeout(r, 400))
  const gs = [...document.querySelectorAll('.more-menu .nav-item')].find(e => e.textContent.includes('游戏站'))
  if (!gs) return { err: 'no-gamesite-item' }
  gs.click()
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 400))
    const wv = document.querySelector('webview')
    if (wv) return { webview: !!wv }
  }
  return { err: 'webview did not mount' }
})()`)
check('首次切到游戏站 webview 挂载', first?.webview === true, JSON.stringify(first))

// 记 dom 引用 id（同一页面实例中 querySelector 返回同一节点）
const before = await evalJs(`document.querySelector('webview') ? 'present' : 'absent'`)
await wait(500)

// 切回库页
await evalJs(`(async () => {
  const lib = [...document.querySelectorAll('.nav-item')].find(e => e.textContent.includes('全部游戏'))
  if (lib) lib.click()
  await new Promise(r => setTimeout(r, 600))
  return true
})()`)
check('切回库页', true)

// 再切回游戏站，webview 应还在（保活，未重挂载）
const after = await evalJs(`(async () => {
  const moreBtn = [...document.querySelectorAll('.nav-item.more-toggle')].find(e => e.textContent.includes('更多'))
  if (moreBtn) moreBtn.click()
  await new Promise(r => setTimeout(r, 400))
  const gs = [...document.querySelectorAll('.more-menu .nav-item')].find(e => e.textContent.includes('游戏站'))
  if (gs) gs.click()
  await new Promise(r => setTimeout(r, 800))
  return document.querySelector('webview') ? 'present-after' : 'absent-after'
})()`)
check('再切回游戏站 webview 仍在（保活）', after === 'present-after', after)

console.log(`\n==== reg_keepalive: ${passed} passed, ${failed} failed ====`)
ws.close()
process.exit(failed > 0 ? 1 : 0)
