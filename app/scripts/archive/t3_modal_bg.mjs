// T3 验收：打开设置弹窗，断言 .ant-modal-content 背景为实色浮层 rgb(38,38,43)。
const PORT = '9225'
const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = pages.find((p) => p.type === 'page' && !p.url.startsWith('devtools'))
if (!page) throw new Error('no page target')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let msgId = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
}
await new Promise((r) => (ws.onopen = r))
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const mid = ++msgId
    pending.set(mid, resolve)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
const evalJs = async (expr) => {
  const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (res.result?.exceptionDetails)
    return { __err: String(res.result.exceptionDetails.exception?.description ?? 'eval failed') }
  return res.result?.result?.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

await wait(2000)
// 点侧栏「设置」打开弹窗
await evalJs(`[...document.querySelectorAll('.nav-item')].find(e => e.textContent.includes('设置'))?.click()`)
await wait(800)
const bg = await evalJs(`getComputedStyle(document.querySelector('.ant-modal-content')).backgroundColor`)
const result = bg === 'rgb(38, 38, 43)'
console.log(`${result ? 'PASS' : 'FAIL'}  modal-content bg = ${bg}`)
ws.close()
process.exit(result ? 0 : 1)
