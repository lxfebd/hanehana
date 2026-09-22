// T5 验收：验证 hh:// 协议渲染层可加载（img 请求 hh://thumb/{id} 返回 200 + 图片）。
const PORT = '9226'
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

// 直接构造 img 加载 hh:// 协议，检查能否取到字节
const out = await evalJs(`(async () => {
  const img = new Image()
  img.src = 'hh://thumb/t5-game-1'
  await new Promise((resolve) => { img.onload = resolve; img.onerror = () => resolve('error') })
  return { loaded: img.complete && img.naturalWidth > 0, w: img.naturalWidth, h: img.naturalHeight }
})()`)
console.log(JSON.stringify(out))
const ok = out && out.loaded === true
console.log(`${ok ? 'PASS' : 'FAIL'}  hh://thumb 协议加载`)
// 未命中 id → 404
const miss = await evalJs(`(async () => {
  try { const r = await fetch('hh://thumb/nonexistent'); return r.status } catch (e) { return 'fetch-blocked:' + e.message }
})()`)
console.log('404 probe:', miss)
ws.close()
process.exit(ok ? 0 : 1)