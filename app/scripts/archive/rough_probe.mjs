// 粗糙点全量量测：圆角/间距/对齐/字号一致性（不依赖视觉，纯 DOM 几何）
const pages = await (await fetch('http://127.0.0.1:9231/json')).json()
const page = pages.find((p) => p.type === 'page' && p.url.includes('localhost'))
if (!page) throw new Error('no page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
}
const send = (method, params = {}) =>
  new Promise((res) => {
    const mid = ++id
    pending.set(mid, res)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
const expr = `(() => {
  const gs = (el) => el ? getComputedStyle(el) : null
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const br = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), r: gs(el).borderRadius, bg: gs(el).backgroundColor } }
  const sidebar = q('.sidebar')
  const content = q('.content')
  const detail = q('.detail-panel')
  const toolbar = q('.toolbar')
  const searchBox = q('.search-box')
  const cards = qa('.cover-card')
  const firstCard = cards[0]
  const tz = q('.cover-titlezone')
  // 对齐：工具栏搜索框/计数/segmented 的垂直中线和卡片行的对齐
  const toolbarY = toolbar ? Math.round(toolbar.getBoundingClientRect().y) : null
  const searchY = searchBox ? Math.round(searchBox.getBoundingClientRect().y) : null
  return {
    theme: document.documentElement.dataset.theme,
    sidebar: br(sidebar),
    content: br(content),
    detail: detail ? br(detail) : null,
    toolbar: br(toolbar),
    searchBox: br(searchBox),
    toolbarY, searchY,
    cardsInRow: cards.length,
    firstCard: br(firstCard),
    tzH: tz ? Math.round(tz.getBoundingClientRect().height) : null,
    // 细节项
    navFont: gs(q('.nav-item')).fontSize,
    navActiveBg: gs(qa('.nav-item').find(n => n.classList.contains('active'))).backgroundColor,
    chipCount: qa('.cat-chip').length,
    segBtns: qa('.seg-btn').length,
    // 滚动条
    scrollbarW: (() => { const el = q('.sidebar'); return el && el.scrollHeight > el.clientHeight ? 'visible' : 'hidden' })(),
  }
})()`
const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
console.log(JSON.stringify(res.result?.result?.value, null, 1))
ws.close()
