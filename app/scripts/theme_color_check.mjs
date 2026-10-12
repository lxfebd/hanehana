// 程序化视觉验证：双主题下采样关键 UI 元素的计算样式，确认不残留蓝色/AI 深蓝。
// 遍历两个主题：检查主色、文本色、卡片、按钮、导航等元素的真实渲染色。
const PORT = process.env.THEME_PORT || '9230'
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

await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
await send('Page.bringToFront').catch(() => {})
await wait(600)

let passed = 0,
  failed = 0
const check = (name, cond, detail = '') => {
  if (cond) {
    passed++
    console.log(`PASS  ${name}`)
  } else {
    failed++
    console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`)
  }
}

// 判断颜色是否偏蓝（AI 蓝检测）：rgba/hex → {r,g,b}，b 明显高于 r/g 且饱和度够高
function isBluish(col) {
  if (!col) return false
  const m = col.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)/)
  if (m) {
    const [, r, g, b] = m.map(Number)
    return b > r + 25 && b > g + 25
  }
  const h = col.match(/#([0-9a-fA-F]{6})/)
  if (h) {
    const n = parseInt(h[1], 16)
    const r = (n >> 16) & 255,
      g = (n >> 8) & 255,
      b = n & 255
    return b > r + 25 && b > g + 25
  }
  return false
}

async function sampleTheme(themeLabel) {
  console.log(`\n======== ${themeLabel.toUpperCase()} ========`)
  const s = await evalJs(`(function(){
    const G = (sel) => { const el = document.querySelector(sel); if (!el) return null; const cs = getComputedStyle(el); return { bg: cs.backgroundColor, color: cs.color, borderColor: cs.borderColor, boxShadow: cs.boxShadow.slice(0,60) } }
    return {
      theme: document.documentElement.dataset.theme,
      body: G('body'),
      sidebar: G('.sidebar'),
      navActive: G('.nav-item.active'),
      main: G('.app-main'),
      primaryBtn: (() => { const b = document.querySelector('.ant-btn-primary'); if (!b) return null; const cs = getComputedStyle(b); return { bg: cs.backgroundColor, color: cs.color, shadow: cs.boxShadow.slice(0,60) } })(),
      input: (() => { const el = document.querySelector('.search input, .ant-input'); if (!el) return null; const cs = getComputedStyle(el); return { bg: cs.backgroundColor, color: cs.color } })(),
      coverText: (() => { const el = document.querySelector('.cover .t, .cover-title'); if (!el) return null; const cs = getComputedStyle(el); return { color: cs.color } })(),
      card: (() => { const el = document.querySelector('.glass-card, .cover, .task-row'); if (!el) return null; const cs = getComputedStyle(el); return { bg: cs.backgroundColor } })(),
    }
  })()`)
  console.log(JSON.stringify(s, null, 2))

  const blueHunt = await evalJs(`(function(){
    const sel = ['body','.sidebar','.nav-item.active','.app-main','.search input, .ant-input','.cover','.task-row','.dl-card','.ant-btn','.ant-btn-primary','.chip','.seg-chip','.glass','.glass-card','.detail-panel','.ant-modal-content','.ant-tabs-tab-active']
    const out = []
    for (const s of sel) {
      for (const el of document.querySelectorAll(s)) {
        const cs = getComputedStyle(el)
        for (const prop of ['backgroundColor','color','borderColor']) {
          const v = cs[prop]
          out.push({ sel: s, prop, v })
        }
      }
    }
    return out
  })()`)
  const blueHits = blueHunt.filter((x) => isBluish(x.v) && !x.v.startsWith('rgba(0, 0, 0'))
  console.log('BLUE_HITS:', blueHits.length)
  for (const h of blueHits.slice(0, 15)) console.log('  ' + h.sel + '[' + h.prop + '] = ' + h.v)
  check(
    `${themeLabel} 无蓝色残留 (${blueHits.length} hits)`,
    blueHits.length === 0,
    blueHits.map((h) => `${h.sel}.${h.prop}=${h.v}`).join(' | '),
  )
  return { s, blueHits }
}

// 深色
await evalJs(
  `window.hh.getSettings().then(async (s) => { if (!s.dark) await window.hh.saveSettings({ ...s, dark: true }); return true })`,
)
await send('Page.reload', { ignoreCache: true })
await wait(4000)
const dark = await sampleTheme('dark')
check('深色 theme=dark', dark.s?.theme === 'dark', String(dark.s?.theme))
check(
  '深色 sidebar 底是深灰/纯黑系',
  (dark.s?.sidebar?.bg || '').includes('(24, 24, 24)') ||
    (dark.s?.sidebar?.bg || '').includes('rgb(10, 10, 10)') ||
    (dark.s?.sidebar?.bg || '').includes('0, 0, 0'),
  String(dark.s?.sidebar?.bg),
)
check(
  '深色文本为亮字',
  (dark.s?.body?.color || '').includes('250, 250, 250') || (dark.s?.body?.color || '').includes('255, 255, 255'),
  String(dark.s?.body?.color),
)

// 浅色
await evalJs(
  `window.hh.getSettings().then(async (s) => { if (s.dark) await window.hh.saveSettings({ ...s, dark: false }); return true })`,
)
await send('Page.reload', { ignoreCache: true })
await wait(4000)
const light = await sampleTheme('light')
check('浅色 theme=light', light.s?.theme === 'light', String(light.s?.theme))
check(
  '浅色正文为深字',
  (light.s?.body?.color || '').includes('24, 24, 27') || (light.s?.body?.color || '').includes('0, 0, 0'),
  String(light.s?.body?.color),
)
check(
  '浅色 body 底为白/浅灰',
  (light.s?.body?.bg || '').includes('255, 255, 255') ||
    (light.s?.body?.bg || '').includes('247, 247, 248') ||
    light.s?.body?.bg === 'rgba(0, 0, 0, 0)',
  String(light.s?.body?.bg),
)

console.log(`\n==== ${passed} passed, ${failed} failed ====`)
ws.close()
process.exit(failed > 0 ? 1 : 0)
