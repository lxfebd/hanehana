// 全面布局探针：双主题 × 多视口 × 库页(网格/列表) × 下载页。
// 逐元素检测：H 溢出、文本截断、文本挤压、标题栏塌陷。
const PORT = process.env.HANEHANA_DEBUG_PORT || '9231'
const VIEWPORTS = process.env.THEME_VIEWPORTS
  ? process.env.THEME_VIEWPORTS.split(',').map(Number)
  : [960, 1100, 1280, 1536]

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
  const v = res.result?.result?.value
  if (v === undefined) {
    // 大对象偶尔丢字段，用 JSON 通道兜底
    const r2 = await send('Runtime.evaluate', { expression: `JSON.stringify(${expr.includes('=>') ? '(' + expr + ')()' : expr})`, awaitPromise: true, returnByValue: true })
    try { return JSON.parse(r2.result?.result?.value) } catch { return undefined }
  }
  return v
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
await send('Page.bringToFront').catch(() => {})
await wait(600)

let passed = 0, failed = 0
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`PASS  ${name}`) } else { failed++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

const PROBE_FN = `(function(){
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  const SKIP = new Set(['SCRIPT','STYLE','TITLE','META','LINK','SVG','PATH','NOSCRIPT','BR','BUTTON'])
  const issues = []
  const els = [...document.querySelectorAll('body *')]

  for (const el of els) {
    if (SKIP.has(el.tagName)) continue
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const hasText = (el.textContent || '').trim().length > 0
    const descEl = (el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : ''))
    const text = (el.textContent || '').trim().replace(/\\s+/g,' ').slice(0, 30)

    // 文本截断：内容 > 客户区 且不可见溢出（被裁）
    if (hasText && el.scrollWidth > el.clientWidth + 3 && cs.overflowX !== 'visible' && cs.textOverflow !== 'ellipsis') {
      issues.push({ kind: 'textclip', el: descEl, sw: el.scrollWidth, cw: el.clientWidth, text })
    }
    // 文本挤压：内容 > 客户区 且可见溢出（文字压扁）
    if (hasText && el.scrollWidth > el.clientWidth + 3 && cs.overflowX === 'visible' && el.clientWidth < 300 && el.children.length <= 1) {
      issues.push({ kind: 'textcrush', el: descEl, sw: el.scrollWidth, cw: el.clientWidth, text })
    }
    // 元素 H 溢出不贴视口右缘（滚动容器内部不算）
    // 装饰层（aria-hidden，如 .app-bg 动态底图）刻意出血，不参与布局判定
    const decorative = el.getAttribute && el.getAttribute('aria-hidden') === 'true'
    const parent = el.parentElement
    if (!decorative && parent && parent !== document.body && parent !== document.documentElement) {
      const pr = parent.getBoundingClientRect()
      if (pr.width > 0) {
        // 父级裁剪可见溢出（overflow hidden/clip/scroll）→ 几何超界不呈现在视觉上。
        // 反例：cover-thumb img hover scale(1.06) 稳定放大，左右各超 5px 被 overflow:hidden 裁掉，
        // 不判溢出；否则探针把 hover 态误报成布局 bug。
        const pcs = getComputedStyle(parent)
        const clips = ['hidden', 'clip', 'scroll'].includes(pcs.overflowX)
        if (!clips) {
          const ovR = r.right - pr.right
          const ovL = pr.left - r.left
          if (ovR > 5) issues.push({ kind: 'h-overflow', el: descEl, right: Math.round(r.right), pRight: Math.round(pr.right), d: Math.round(ovR), text })
          if (ovL > 5) issues.push({ kind: 'h-overflow-left', el: descEl, left: Math.round(r.left), pLeft: Math.round(pr.left), d: Math.round(ovL), text })
        }
      }
    }
  }
  // 标题栏必查
  const tb = document.querySelector('.titlebar')
  const tbH = tb ? getComputedStyle(tb).height : null
  if (tbH && tbH !== '40px') issues.push({ kind: 'titlebar', el: '.titlebar', h: tbH, text: '标题栏高度异常' })
  return { vw, vh, issues }
})()`

async function probe() {
  // PROBE_FN 本身是自调用表达式，直接执行并用 JSON 序列化返回
  const res = await send('Runtime.evaluate', {
    expression: `JSON.stringify(${PROBE_FN})`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (res.result?.exceptionDetails) return { issues: [{ kind: 'err', el: 'probe', text: String(res.result.exceptionDetails.exception?.description ?? 'eval failed') }] }
  try {
    return JSON.parse(res.result?.result?.value)
  } catch {
    return { issues: [{ kind: 'err', el: 'probe', text: 'parse fail: ' + String(res.result?.result?.value).slice(0, 200) }] }
  }
}

/** 跑一个主题一遍：切主题 → reload → 各视口 × 各页面 */
async function runTheme(darkLabel) {
  console.log(`\n########## 主题: ${darkLabel} ##########`)
  for (const w of VIEWPORTS) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: 800, deviceScaleFactor: 1, mobile: false })
    await wait(400)

    // 库页（网格）
    const g = await probe()
    const titlebarOK = !g.issues.some((i) => i.kind === 'titlebar')
    check(`${darkLabel} @${w} 库页标题栏 40px`, titlebarOK, JSON.stringify(g.issues.find((i) => i.kind === 'titlebar')))
    const gBad = g.issues.filter((i) => i.kind !== 'titlebar')
    if (gBad.length) console.log(`  库页网格问题 ${gBad.length}:`, JSON.stringify(gBad).slice(0, 500))
    check(`${darkLabel} @${w} 库页网格无溢出/截断`, gBad.length === 0, gBad.slice(0, 3).map((i) => `${i.kind}:${i.el}`).join(' | '))

    // 切列表视图
    await evalJs(`(function(){ const b=[...document.querySelectorAll('button')].find(x=>x.title==='列表视图'||x.getAttribute('aria-label')==='列表'); if(b) b.click(); })()`)
    await wait(500)
    const l = await probe()
    const lBad = l.issues.filter((i) => i.kind !== 'titlebar')
    if (lBad.length) console.log(`  库页列表问题 ${lBad.length}:`, JSON.stringify(lBad).slice(0, 500))
    check(`${darkLabel} @${w} 库页列表无溢出/截断`, lBad.length === 0, lBad.slice(0, 3).map((i) => `${i.kind}:${i.el}`).join(' | '))

    // 回网格 + 下载页
    await evalJs(`(function(){ const b=[...document.querySelectorAll('button')].find(x=>x.title==='网格视图'||x.getAttribute('aria-label')==='网格'); if(b) b.click(); })()`)
    await evalJs(`[...document.querySelectorAll('.nav-item')].find(e => e.textContent.includes('下载任务'))?.click()`)
    await wait(600)
    const d = await probe()
    const dBad = d.issues.filter((i) => i.kind !== 'titlebar')
    if (dBad.length) console.log(`  下载页问题 ${dBad.length}:`, JSON.stringify(dBad).slice(0, 600))
    check(`${darkLabel} @${w} 下载页无溢出/截断`, dBad.length === 0, dBad.slice(0, 3).map((i) => `${i.kind}:${i.el}`).join(' | '))

    // 回库页
    await evalJs(`[...document.querySelectorAll('.nav-item')].find(e => e.textContent.includes('全部游戏'))?.click()`)
    await wait(400)
  }
}

// ===== 深色 =====
await evalJs(`window.hh.getSettings().then(async (s) => { if (!s.dark) await window.hh.saveSettings({ ...s, dark: true }); return true })`)
await send('Page.reload', { ignoreCache: true })
await wait(4000)
await runTheme('深色')

// ===== 浅色 =====
await evalJs(`window.hh.getSettings().then(async (s) => { if (s.dark) await window.hh.saveSettings({ ...s, dark: false }); return true })`)
await send('Page.reload', { ignoreCache: true })
await wait(4000)
await runTheme('浅色')

console.log(`\n==== ${passed} passed, ${failed} failed ====`)
ws.close()
process.exit(failed > 0 ? 1 : 0)