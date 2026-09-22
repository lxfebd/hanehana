// 探测 antd token 生效情况：Modal content/header、Input、Select、Button、Message
const PORT = '9225'
const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = pages.find((p) => p.type === 'page' && !p.url.startsWith('devtools'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
let msgId = 0
const pending = new Map()
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
await new Promise((r) => (ws.onopen = r))
const send = (method, params = {}) => new Promise((resolve) => { const mid = ++msgId; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params })) })
const evalJs = async (expr) => {
  const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (res.result?.exceptionDetails) return { __err: String(res.result.exceptionDetails.exception?.description ?? 'eval failed') }
  return res.result?.result?.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

await wait(1500)
const out = await evalJs(`(() => {
  const modal = document.querySelector('.ant-modal-content')
  const header = document.querySelector('.ant-modal-header')
  const input = document.querySelector('.ant-modal input')
  const btn = document.querySelector('.ant-modal .ant-btn-primary')
  const rs = (el, prop) => el ? getComputedStyle(el)[prop] : 'N/A'
  return {
    modalBg: rs(modal, 'backgroundColor'),
    headerBg: rs(header, 'backgroundColor'),
    inputBg: rs(input, 'backgroundColor'),
    inputRadius: rs(input, 'borderRadius'),
    primaryBg: rs(btn, 'backgroundColor'),
    primaryShadow: rs(btn, 'boxShadow'),
    modalRadius: rs(modal, 'borderRadius'),
  }
})()`)
console.log(JSON.stringify(out, null, 2))
ws.close()
