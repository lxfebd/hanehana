// 下载页 UI 验证：真实 dev 窗口里检查侧栏入口、页面切换、空态、新建弹窗。
// 用法：node scripts/cdp_ui_download.mjs
const PORT = process.env.HANEHANA_DEBUG_PORT || '9224'

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
  if (res.result?.exceptionDetails) return { __err: String(res.result.exceptionDetails.exception?.description ?? 'eval failed') }
  return res.result?.result?.value
}

let passed = 0
let failed = 0
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`PASS  ${name}`) }
  else { failed++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
await wait(2000)

// 1. 侧栏有「下载任务」入口
const navText = await evalJs(`[...document.querySelectorAll('.nav-item')].map(e => e.textContent.trim()).join('|')`)
check('侧栏含下载任务入口', typeof navText === 'string' && navText.includes('下载任务'), String(navText))

// 2. 默认在游戏库页（无下载列表容器）
const hasDlListBefore = await evalJs(`!!document.querySelector('.dl-list')`)
check('默认不显示下载列表', hasDlListBefore === false)

// 3. 点「下载任务」切换
await evalJs(`[...document.querySelectorAll('.nav-item')].find(e => e.textContent.includes('下载任务'))?.click()`)
await wait(500)
const hasDlListAfter = await evalJs(`!!document.querySelector('.dl-list')`)
check('切到下载页显示任务列表容器', hasDlListAfter === true)

// 4. 空态文案
const emptyText = await evalJs(`document.querySelector('.dl-empty')?.textContent ?? ''`)
check('空态文案显示', typeof emptyText === 'string' && emptyText.includes('还没有下载任务'), String(emptyText))

// 5. 过滤器（全部/下载中/已暂停/已完成/失败）— segmented chip 行（§5.5）
const filters = await evalJs(`[...document.querySelectorAll('.seg-chip')].map(e => e.textContent.trim()).join('|')`)
check('状态过滤器齐全', typeof filters === 'string' && ['全部', '下载中', '已暂停', '已完成', '失败'].every((f) => filters.includes(f)), String(filters))

// 6. 新建下载按钮存在（打开弹窗）
const hasAddBtn = await evalJs(`[...document.querySelectorAll('button')].some(b => b.title === '新建下载' || b.textContent.includes('新建下载'))`)
check('新建下载按钮存在', hasAddBtn === true)
await evalJs(`[...document.querySelectorAll('button')].find(b => b.title === '新建下载')?.click()`)
await wait(600)
const dlgTitle = await evalJs(`document.querySelector('.ant-modal-title')?.textContent ?? ''`)
check('新建下载弹窗打开', String(dlgTitle).includes('新建下载'), String(dlgTitle))

// 7. 设置弹窗入口
await evalJs(`document.querySelector('.ant-modal-close')?.click()`)
await wait(300)
await evalJs(`[...document.querySelectorAll('.nav-item')].find(e => e.textContent.includes('设置'))?.click()`)
await wait(600)
const settingsTitle = await evalJs(`document.querySelector('.ant-modal-title')?.textContent ?? ''`)
check('设置弹窗打开', String(settingsTitle).includes('偏好设置'), String(settingsTitle))
const tabs = await evalJs(`[...document.querySelectorAll('.ant-tabs-tab')].map(e => e.textContent.trim()).join('|')`)
check('设置页签齐全（含「关于」）', typeof tabs === 'string' && ['下载', '通知', '网络', '外观', '关于'].every((t) => tabs.includes(t)), String(tabs))

console.log(`\n==== ${passed} passed, ${failed} failed ====`)
ws.close()
process.exit(failed > 0 ? 1 : 0)
