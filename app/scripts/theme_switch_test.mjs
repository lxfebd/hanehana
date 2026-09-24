// 干净的双主题切换验证：起点=深色，走完整 UI：打开设置 → 外观 tab → 关开关 → 保存 → 验证浅色。
const PORT = process.env.THEME_PORT || '9230'
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
  return res.result?.result?.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// 后台窗口（脚本自己起的 Electron）会冻结 CSS 动画与 rAF，antd 弹窗的关闭动画
// 停在中点，destroy-on-close 的 afterClose 永不触发——先强制聚焦解冻。
await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
await send('Page.bringToFront').catch(() => {})
await wait(600)

let passed = 0, failed = 0
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`PASS  ${name}`) } else { failed++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

// 0. 刷新页面拿到干净状态（设置 dark 由 initTasks 同步，此时应为 true）
await send('Page.reload', { ignoreCache: true })
await wait(3500)
const boot = await evalJs(`document.querySelector('.tag')?.textContent ?? ''`)
console.log('BOOT:', boot)
let theme0 = await evalJs(`({ theme: document.documentElement.dataset.theme, accent: getComputedStyle(document.documentElement).getPropertyValue('--hh-color-accent').trim() })`)
console.log('THEME_INIT:', JSON.stringify(theme0))
check('刷新后为深色（settings dark=true 同步）', theme0?.theme === 'dark', String(theme0?.theme))

// 若当前设置已是 light，先切回 dark 再测
if (theme0?.theme !== 'dark') {
  await evalJs(`window.hh.getSettings().then(async (s) => { await window.hh.saveSettings({ ...s, dark: true }); return true })`)
  await send('Page.reload', { ignoreCache: true })
  await wait(3500)
  theme0 = await evalJs(`({ theme: document.documentElement.dataset.theme, accent: getComputedStyle(document.documentElement).getPropertyValue('--hh-color-accent').trim() })`)
  console.log('THEME_RESET:', JSON.stringify(theme0))
  check('重置后为深色', theme0?.theme === 'dark', String(theme0?.theme))
}

// 1. 打开设置
await evalJs(`[...document.querySelectorAll('.nav-item')].find(e => e.textContent.includes('设置'))?.click()`)
await wait(900)
const modalOpen = await evalJs(`!!document.querySelector('.ant-modal-wrap:not([style*="display: none"])')`)
check('设置弹窗打开', modalOpen === true, String(modalOpen))

// 2. 切到外观 tab
await evalJs(`[...document.querySelectorAll('.ant-tabs-tab')].find(e => e.textContent.includes('外观'))?.click()`)
await wait(500)

// 3. 检查开关（应 checked=true 深色）
const sw1 = await evalJs(`(() => { const s=document.querySelector('.ant-switch'); return s?.classList.contains('ant-switch-checked') ?? null })()`)
console.log('SWITCH_INIT:', sw1)
check('开关初始为深色', sw1 === true, String(sw1))

// 4. 点击切到浅色
await evalJs(`document.querySelector('.ant-switch')?.click()`)
await wait(500)
const sw2 = await evalJs(`(() => { const s=document.querySelector('.ant-switch'); return s?.classList.contains('ant-switch-checked') ?? null })()`)
console.log('SWITCH_AFTER:', sw2)
check('开关已切到浅色', sw1 === true && sw2 === false, `${sw1}->${sw2}`)

// 5. 点保存
const clicked = await evalJs(`(() => {
  const b = [...document.querySelectorAll('.ant-modal-wrap button')].find(x => x.textContent.replace(/\\s/g, '') === '保存' && !x.disabled)
  if (b) { b.click(); return true }
  return false
})()`)
console.log('SAVE_CLICKED:', clicked)
check('保存按钮已点击', clicked === true, String(clicked))
await wait(2500)

// 6. 验证主题切到浅色
const theme1 = await evalJs(`({
  theme: document.documentElement.dataset.theme,
  accent: getComputedStyle(document.documentElement).getPropertyValue('--hh-color-accent').trim(),
  window: getComputedStyle(document.documentElement).getPropertyValue('--hh-color-window-fallback').trim(),
  star: getComputedStyle(document.documentElement).getPropertyValue('--hh-color-star').trim(),
})`)
console.log('THEME_AFTER_SAVE:', JSON.stringify(theme1))
check('保存后 data-theme=light', theme1?.theme === 'light', String(theme1?.theme))
check('accent 纯黑 #18181B', theme1?.accent === '#18181B', String(theme1?.accent))
check('window 底 #F7F7F8', theme1?.window === '#F7F7F8', String(theme1?.window))
check('star 变深色系', typeof theme1?.star === 'string' && theme1.star === '#B07C1F', String(theme1?.star))

// 7. 弹窗已关闭（保存成功）
const modalClosed = await evalJs(`!document.querySelector('.ant-modal-wrap:not([style*="display: none"])')`)
check('设置弹窗已关闭', modalClosed === true, String(modalClosed))

// 8. 落盘验证
const disk = await evalJs(`window.hh.getSettings().then(s => s.dark)`)
check('settings.json dark=false 已落盘', disk === false, String(disk))

console.log(`\n==== ${passed} passed, ${failed} failed ====`)
ws.close()
process.exit(failed > 0 ? 1 : 0)