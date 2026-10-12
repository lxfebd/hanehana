// 核心回归：游戏站桥冒烟。
// 走 window.hh 桥直连主进程站点注册表 + 渲染层 GameSites 接线：
//   - sitesList() 返回三站（gamer520/nekogal/playzip）
//   - 渲染层 GameSites.vue 挂载后站点列表出现在 .g-sites 容器
//   - 切到游戏站页有 webview 且 src 指向站点首页（hanehana: 通道注册正确）
// 说明：不依赖外网搜索（站内搜索可能被反爬），只验证桥与渲染接线；
//       真实站内搜索由 manual/ 流程覆盖。
// 用法：node scripts/reg_sites.mjs   （须先有实例在 HANEHANA_DEBUG_PORT）
const PORT = process.env.HANEHANA_DEBUG_PORT || '9231'
const EXPECTED = ['gamer520', 'nekogal', 'playzip']

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

// 1. 桥直连：三站注册
const list = await evalJs(
  `(async () => { try { const r = await window.hh.sitesList(); return r.map(s => s.id).sort() } catch (e) { return 'ERR:' + e.message } })()`,
)
check('sitesList 通', Array.isArray(list), String(list))
check('注册三站', Array.isArray(list) && EXPECTED.every((id) => list.includes(id)), String(list))

// 2. 渲染层：切到游戏站页，GameSites.vue 应把站点列表渲染出来
const ui = await evalJs(`(async () => {
  const moreBtn = [...document.querySelectorAll('.nav-item.more-toggle')].find(e => e.textContent.includes('更多'))
  if (moreBtn) moreBtn.click()
  await new Promise(r => setTimeout(r, 400))
  const gs = [...document.querySelectorAll('.more-menu .nav-item')].find(e => e.textContent.includes('游戏站'))
  if (!gs) return { err: 'no-gamesite-item' }
  gs.click()
  await new Promise(r => setTimeout(r, 1200))
  return {
    webview: !!document.querySelector('webview'),
    siteTabs: [...document.querySelectorAll('.g-site')].map(e => e.textContent.trim()).slice(0, 5),
    hasSearchBox: !!document.querySelector('.g-input, input[placeholder*="搜索"]'),
  }
})()`)
check('切到游戏站有 webview', ui?.webview === true, JSON.stringify(ui))
check('站点列表渲染', Array.isArray(ui?.siteTabs) && ui.siteTabs.length >= 3, JSON.stringify(ui?.siteTabs))
check('有搜索框', ui?.hasSearchBox === true, JSON.stringify(ui))

// 3. webview 已挂上首页（did-start-loading 已触发过 → address 有值）
const addr = await evalJs(`(async () => {
  await new Promise(r => setTimeout(r, 500))
  const wv = document.querySelector('webview')
  return { src: wv?.getAttribute('src') ?? '', title: wv?.getTitle?.() ?? '' }
})()`)
check('webview 指向站点首页', typeof addr?.src === 'string' && addr.src.startsWith('http'), JSON.stringify(addr))

console.log(`\n==== reg_sites: ${passed} passed, ${failed} failed ====`)
ws.close()
process.exit(failed > 0 ? 1 : 0)
