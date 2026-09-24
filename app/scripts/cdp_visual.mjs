// Phase 5 视觉验收：8 条断言，覆盖「P2 批量」打磨项的运行时证据。
// 断言对象是真实渲染出来的 DOM/CSS（不是截图），可与 docs/shots/ 基准图互补。
// 自带导航：无论从哪个页面连入，都会回到库页、点开详情与设置弹窗再逐条断言。
//
// 用法：node scripts/cdp_visual.mjs（默认连 9223，可用 HANEHANA_DEBUG_PORT 覆盖）
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.HANEHANA_DEBUG_PORT || '9223'

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
  new Promise((res) => {
    const mid = ++msgId
    pending.set(mid, res)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.exception?.description ?? 'eval failed') }
  return r.result?.result?.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// 背景最小化会把 CSS 动画冻结（document.visibilityState='hidden'），断言前强制聚焦。
await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
await send('Page.bringToFront').catch(() => {})
await wait(400)

// ---- 导航到库页并点开第一个封面（详情面板 + 折叠按钮都依赖它）----
await evalJs(`(() => {
  const lib = [...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('全部游戏'))
  if (lib) lib.click()
})()`)
await wait(500)
await evalJs(`document.querySelector('.cover-card')?.click()`)
await wait(600)

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail ?? '' })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`)
}

// 1. token 单真值源：--hh-* 变量在 :root 上（getComputedStyle 只暴露自定义属性）
const tokenCheck = await evalJs(`(() => {
  const s = getComputedStyle(document.documentElement)
  let n = 0
  for (const k of s) if (k.startsWith('--hh-')) n++
  return n
})()`)
check('token 单真值源：--hh-* 变量可用', tokenCheck >= 20, `vars=${tokenCheck}`)

// 2. .glass-card 死代码已删：运行时没有任何元素带 glass-card 类
const glass = await evalJs(`document.querySelectorAll('.glass-card').length`)
check('glass-card 类已删除', glass === 0, `count=${glass}`)

// 3. 主按钮渐变统一：primary/CTA 按钮背景是渐变（accent-grad 的唯一应用处）
const gradBtn = await evalJs(`(() => {
  const btns = [...document.querySelectorAll('.empty-cta, .primary-btn, .dl-btn.primary')]
  if (!btns.length) return { n: 0, ok: false }
  const bad = btns.filter(b => !getComputedStyle(b).backgroundImage.includes('linear-gradient'))
              .map(b => b.className)
  return { n: btns.length, ok: bad.length === 0, bad }
})()`)
check('主按钮/空态 CTA 渐变统一', gradBtn.ok, `n=${gradBtn.n} bad=[${gradBtn.bad}]`)

// 4. 点击目标 ≥30px：seg-btn/.ibtn/.cat-chip 的高度（先确保在库页、toolbar 已渲染）
const hitTargets = await evalJs(`(async () => {
  const lib = [...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('全部游戏'))
  if (lib) lib.click()
  await new Promise(r => setTimeout(r, 800))
  const items = [...document.querySelectorAll('.seg-btn, .ibtn, .cat-chips .cat-chip')]
  const q = (ss) => { try { return [...ss.cssRules] } catch { return [] } }
  const bad = items.filter(el => el.getBoundingClientRect().height < 30)
                  .map(el => {
                    const r = el.getBoundingClientRect()  // eslint-disable-line
                    const cs = getComputedStyle(el)
                    const hits = [...document.styleSheets].flatMap(q)
                      .filter(ru => ru.selectorText && el.matches(ru.selectorText) && ru.style.height)
                      .map(ru => ru.selectorText + ':' + ru.style.height).slice(-4)
                    return el.className.split(' ').slice(0, 2).join('.') + '@' + r.height.toFixed(2) +
                      ' css=' + cs.height + ' box=' + cs.boxSizing + ' b=' + cs.borderTopWidth + '+' + cs.borderBottomWidth +
                      ' p=' + cs.paddingTop + '+' + cs.paddingBottom + ' hits=[' + hits.join(' | ') + ']'
                  })
  return { n: items.length, bad, dpr: devicePixelRatio, zoom: document.body.style.zoom || document.documentElement.style.zoom || 'none' }
})()`)
check('点击目标 ≥30px', hitTargets.n === 0 || hitTargets.bad.length === 0, `n=${hitTargets.n} dpr=${hitTargets.dpr} bad=[${hitTargets.bad}]`)

// 5. img @error 兜底：封面/横幅的 img 都挂了 onerror（隐藏破图）
const imgGuard = await evalJs(`(() => {
  const imgs = [...document.querySelectorAll('.cover-card img, .detail-banner img, .r-cover img')]
  if (!imgs.length) return { n: 0, ok: true }
  const ok = imgs.every(img => img.onerror !== null)
  return { n: imgs.length, ok }
})()`)
check('封面/横幅 img @error 兜底', imgGuard.ok, `n=${imgGuard.n}`)

// 6. 详情面板可折叠：折叠按钮存在且带图标
const collapse = await evalJs(`(() => {
  const btn = document.querySelector('.detail-collapse, .detail-collapsed')
  return { n: btn ? 1 : 0, icon: btn ? !!btn.querySelector('svg') : false }
})()`)
check('详情面板折叠按钮存在', collapse.n === 1, `n=${collapse.n} icon=${collapse.icon}`)

// 7. Settings 保存守卫：代理格式非法时保存按钮禁用
const settingsGuard = await evalJs(`(async () => {
  const closeBtn = document.querySelector('.ant-modal-close')
  if (closeBtn) closeBtn.click()
  await new Promise(r => setTimeout(r, 400))
  const gear = [...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('设置'))
  if (!gear) return { ok: false, why: 'no settings nav' }
  gear.click()
  await new Promise(r => setTimeout(r, 800))
  const modalNow = !!document.querySelector('.ant-modal')
  const tabsNow = [...document.querySelectorAll('.ant-tabs-tab')].map(t => t.textContent.trim())
  if (!modalNow) return { ok: false, why: 'modal not open after settings click; tabs=' + JSON.stringify(tabsNow) }
  const netTab = tabsNow.find(t => t.includes('网络'))
  if (!netTab) return { ok: false, why: 'no net tab; tabs=' + JSON.stringify(tabsNow) }
  const netTabEl = [...document.querySelectorAll('.ant-tabs-tab')].find(t => t.textContent.includes('网络'))
  netTabEl.click()
  await new Promise(r => setTimeout(r, 500))
  // 代理行的 Input：Form.Item label 含「代理」且类型为文本
  const proxyItem = [...document.querySelectorAll('.ant-form-item')]
    .find(item => item.textContent.includes('代理') && item.querySelector('input'))
  const proxyInput = proxyItem?.querySelector('input')
  if (!proxyInput) return { ok: false, why: 'no proxy input' }
  const setVal = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setVal.call(proxyInput, 'ftp://127.0.0.1') // ftp 不在白名单 → 必然非法
  proxyInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'ftp://127.0.0.1' }))
  await new Promise(r => setTimeout(r, 500))
  const modalBtns = [...document.querySelectorAll('.ant-modal button')].map(b => b.textContent.trim())
  const saveBtn = [...document.querySelectorAll('.ant-modal button')].find(b => b.textContent.replaceAll(' ', '') === '保存')
  if (!saveBtn) return { ok: false, why: 'no save btn; modal buttons=' + JSON.stringify(modalBtns) }
  const disabled = saveBtn.disabled
  const hint = [...document.querySelectorAll('.ant-modal .save-hint')].some(el => getComputedStyle(el).display !== 'none')
  const errText = proxyItem.textContent // 完整 dump 现场
  const dump = {
    tabsNow, inputValue: proxyInput.value, disabled, hint,
    errText: errText.slice(0, 80),
    saveBtnClass: saveBtn.className,
    saveBtnDisabledAttr: saveBtn.getAttribute('disabled'),
    modalCount: document.querySelectorAll('.ant-modal').length,
    coverOpen: !!document.querySelector('.cover-card .open') || !!document.querySelector('.detail-panel'),
  }
  setVal.call(proxyInput, '')
  proxyInput.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 200))
  return { ok: disabled, ...dump }
})()`)
check('代理格式非法时保存被禁用', settingsGuard.ok, `disabled=${settingsGuard.disabled} hint=${settingsGuard.hint} dump=${JSON.stringify(settingsGuard).slice(0, 300)}`)

// 8. 对比度统一：同一语义（错误提示）只用 token 定义的错误色
const errColor = await evalJs(`(() => {
  const elems = [...document.querySelectorAll('.hint-err, .save-hint')]
  const colors = new Set()
  for (const el of elems) colors.add(getComputedStyle(el).color)
  return { elems: elems.length, distinct: colors.size, colors: [...colors].slice(0, 4) }
})()`)
check('错误文案颜色单一真值', errColor.elems === 0 || errColor.distinct <= 1, `distinct=${errColor.distinct} elems=${errColor.elems}`)

// 收尾：关掉设置弹窗，回到下载页
await evalJs(`document.querySelector('.ant-modal-close')?.click()`).catch(() => {})
await evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('下载任务'))?.click()`).catch(() => {})

ws.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} PASS`)
process.exit(failed.length === 0 ? 0 : 1)