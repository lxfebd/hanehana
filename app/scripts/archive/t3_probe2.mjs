// 深探：seed colorPrimary / colorBgBase 是否生效，以及各组件实际样式
const PORT = '9225'
const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = pages.find((p) => p.type === 'page' && !p.url.startsWith('devtools'))
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

await wait(1500)
const out = await evalJs(`(() => {
  const rs = (el, prop) => el ? getComputedStyle(el)[prop] : 'N/A'
  const root = getComputedStyle(document.documentElement)
  return {
    bodyBg: rs(document.body, 'backgroundColor'),
    appBg: rs(document.querySelector('.app-shell'), 'backgroundColor'),
    primaryBtnBg: rs(document.querySelector('.ant-modal .ant-btn-primary'), 'backgroundColor'),
    primaryBtnText: rs(document.querySelector('.ant-modal .ant-btn-primary'), 'color'),
    tabColor: rs(document.querySelector('.ant-tabs-tab'), 'color'),
    switchBg: rs(document.querySelector('.ant-switch'), 'backgroundColor'),
    checkboxBg: rs(document.querySelector('.ant-checkbox-inner'), 'backgroundColor'),
    cssVars: {
      antPrimary: root.getPropertyValue('--ant-color-primary') || 'none',
    },
  }
})()`)
console.log(JSON.stringify(out, null, 2))
ws.close()
