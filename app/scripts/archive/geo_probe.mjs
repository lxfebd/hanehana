// 几何探针：逐元素检测溢出（越出父容器/视口）与文字重叠/挤压。
// 用法：node scripts/geo_probe.mjs
const PORT = process.env.HANEHANA_DEBUG_PORT || '9231'
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

// 等页面就绪
await wait(2500)

// 深度检测：所有可见元素（跳过 svg/script/style/title/meta）
const report = await evalJs(`(function(){
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  const SKIP = new Set(['SCRIPT','STYLE','TITLE','META','LINK','SVG','PATH','NOSCRIPT','BR'])
  const issues = []
  const seen = new Set()

  // 1. 文本挤压/截断：scrollWidth>clientWidth 说明文字被裁或挤压
  const els = [...document.querySelectorAll('body *')]
  for (const el of els) {
    if (SKIP.has(el.tagName)) continue
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const hasText = (el.textContent || '').trim().length > 0
    // 文本被截断：客户区 < 内容区（overflow 裁切）
    if (hasText && el.scrollWidth > el.clientWidth + 2 && cs.overflowX !== 'visible' && (cs.textOverflow !== 'ellipsis')) {
      issues.push({ kind: 'textclip', el: desc(el), sw: el.scrollWidth, cw: el.clientWidth, text: el.textContent.trim().slice(0, 40) })
    }
    // 文本被压缩：正常宽度 < 内容宽度（flex shrink 压扁了文字）
    if (hasText && el.scrollWidth > el.clientWidth + 2 && cs.overflowX === 'visible' && el.clientWidth < 200) {
      // 只有纯文本叶子才报
      if (el.children.length === 0) {
        issues.push({ kind: 'textcrush', el: desc(el), sw: el.scrollWidth, cw: el.clientWidth, text: el.textContent.trim().slice(0, 40) })
      }
    }
  }

  // 2. 元素水平溢出父容器（右边缘超出父右边缘 +5px 为问题）
  for (const el of els) {
    if (SKIP.has(el.tagName)) continue
    const cs = getComputedStyle(el)
    if (cs.position === 'fixed') continue // 浮层不管
    if (cs.display === 'none') continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const parent = el.parentElement
    if (!parent) continue
    if (parent === document.body) continue
    const pr = parent.getBoundingClientRect()
    if (pr.width === 0) continue
    const overflow = r.right - pr.right
    const overflowLeft = pr.left - r.left
    if (overflow > 5) {
      issues.push({ kind: 'h-overflow', el: desc(el), right: Math.round(r.right), pRight: Math.round(pr.right), delta: Math.round(overflow), text: (el.textContent||'').trim().slice(0,30) })
    }
    if (overflowLeft > 5) {
      issues.push({ kind: 'h-overflow-left', el: desc(el), left: Math.round(r.left), pLeft: Math.round(pr.left), delta: Math.round(overflowLeft), text: (el.textContent||'').trim().slice(0,30) })
    }
  }

  function desc(el) {
    // 生成可读标识：tag.cls#id
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : ''
    return el.tagName.toLowerCase() + cls + (el.id ? '#' + el.id : '')
  }
  return { vw, vh, issues, total: els.length }
})()`)
if (report?.__err) {
  console.log('PROBE_ERR:', report.__err)
  process.exit(1)
}

console.log(`视口 ${report.vw}x${report.vh}，扫描 ${report.total} 个元素，发现问题 ${report.issues.length} 条\n`)
for (const it of report.issues) {
  console.log(
    `[${it.kind}] ${String(it.el).padEnd(48)} ${JSON.stringify({ sw: it.sw, cw: it.cw, right: it.right, pRight: it.pRight, delta: it.delta, text: it.text }).slice(0, 130)}`,
  )
}

// 3. 三排重叠检测无（探针 1 已覆盖），补个顶部工具栏专项 dump
console.log('\n==== 顶部标题栏 DOM 几何 ====')
const tb = await evalJs(`(function(){
  const t = document.querySelector('.titlebar')
  if (!t) return null
  const r = t.getBoundingClientRect()
  return {
    titlebar: { x: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) },
    children: [...t.children].map(c => {
      const cr = c.getBoundingClientRect()
      const cs = getComputedStyle(c)
      return { el: c.tagName.toLowerCase() + (c.className ? '.' + String(c.className).split(/\\s+/).slice(0,2).join('.') : ''), x: Math.round(cr.left), w: Math.round(cr.width), right: Math.round(cr.right), sw: c.scrollWidth, cw: c.clientWidth, oy: cs.overflowY, ws: cs.whiteSpace, text: c.textContent.trim().slice(0,50) }
    })
  }
})()`)
console.log(JSON.stringify(tb, null, 2))

ws.close()
