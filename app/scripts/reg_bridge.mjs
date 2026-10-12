// 核心回归：桥与导航。
// 连运行中 Electron（HANEHANA_DEBUG_PORT），断言：
//   - window.hh 桥存在且 hello() 通（引擎自检）
//   - 标题栏 logo「羽花 HaneHana」渲染
//   - 主导航四主项存在（全部游戏/下载任务/扫描/设置）
//   - 更多菜单含「游戏站」，点开可切页
// 用法：node scripts/reg_bridge.mjs   （须先有 dev/打包实例在 HANEHANA_DEBUG_PORT）
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

const bridge = await evalJs(`typeof window.hh`)
check('window.hh 桥存在', bridge === 'object', String(bridge))

const hello = await evalJs(
  `(async () => { try { const r = await window.hh?.hello(); return r ? r.name + '@' + r.version + (r.engine_ok ? '+engine' : '-noengine') : 'n/a' } catch (e) { return 'ERR:' + e.message } })()`,
)
check(
  'hello() 通且引擎自检',
  typeof hello === 'string' && hello.includes('@') && hello.includes('engine'),
  String(hello),
)

const logo = await evalJs(`document.querySelector('.titlebar .logo')?.textContent?.trim() ?? '(missing)'`)
check('标题栏 logo 渲染', logo.includes('羽花') && logo.includes('HaneHana'), logo)

const nav = await evalJs(`[...document.querySelectorAll('.nav-item')].map(e => e.textContent.trim())`)
check(
  '导航含全部游戏',
  nav.some((t) => t.includes('全部游戏')),
  nav.join('|'),
)
check(
  '导航含下载任务',
  nav.some((t) => t.includes('下载任务')),
  nav.join('|'),
)
check(
  '导航含扫描',
  nav.some((t) => t.includes('扫描')),
  nav.join('|'),
)
check(
  '导航含设置',
  nav.some((t) => t.includes('设置')),
  nav.join('|'),
)

// 更多菜单：打开 → 断言含游戏站 → 点开切页 → 关菜单
const moreNav = await evalJs(`(async () => {
  const moreBtn = [...document.querySelectorAll('.nav-item.more-toggle')].find(e => e.textContent.includes('更多'))
  if (!moreBtn) return { items: [], hasMore: false }
  moreBtn.click()
  // v-if 挂载是异步的：等 Vue 重渲染出 .more-menu 再读
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 100))
    const items = [...document.querySelectorAll('.more-menu .nav-item')].map(e => e.textContent.trim())
    if (items.length) return { items, hasMore: true }
  }
  return { items: [], hasMore: true }
})()`)
check('更多菜单可展开', moreNav?.hasMore === true, JSON.stringify(moreNav))
check(
  '更多含游戏站',
  (moreNav?.items || []).some((t) => t.includes('游戏站')),
  JSON.stringify(moreNav?.items),
)

const switchPage = await evalJs(`(async () => {
  // 上一段已把菜单打开；若已开就直接找游戏站项，不重复点 more-toggle（会关掉它）
  if (!document.querySelector('.more-menu')) {
    const btn = [...document.querySelectorAll('.nav-item.more-toggle')].find(e => e.textContent.includes('更多'))
    if (!btn) return 'no-more-btn'
    btn.click()
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 100))
      if (document.querySelector('.more-menu')) break
    }
  }
  const gs = [...document.querySelectorAll('.more-menu .nav-item')].find(e => e.textContent.includes('游戏站'))
  if (!gs) return 'no-gamesite-item'
  gs.click(); await new Promise(r => setTimeout(r, 800))
  const web = document.querySelector('webview')
  return { hasWebview: !!web, pageMarkers: document.querySelectorAll('.g-sites, .site-tabs, .g-site').length }
})()`)
check('切到游戏站有 webview', switchPage?.hasWebview === true, JSON.stringify(switchPage))

await wait(800)
const webviewSrc = await evalJs(`document.querySelector('webview')?.getAttribute('src') ?? ''`)
check('webview 加载站点首页', webviewSrc.includes('http'), webviewSrc.slice(0, 80))

console.log(`\n==== reg_bridge: ${passed} passed, ${failed} failed ====`)
ws.close()
process.exit(failed > 0 ? 1 : 0)
