// 视觉细节量测探针：量出实机当前所有关键视觉参数
const pages = await (await fetch('http://127.0.0.1:9231/json')).json()
const page = pages.find((p) => p.type === 'page' && p.url.includes('localhost'))
if (!page) throw new Error('no page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })) })
const expr = `(() => {
  const gs = (el) => el ? getComputedStyle(el) : null
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const r = (el) => el ? Math.round(el.getBoundingClientRect().height) : null
  const titlebar = q('.titlebar')
  const search = q('.search-input')
  const chips = qa('.cat-chip')
  const seg = q('.segmented')
  const nav = qa('.nav-item')
  const cover = q('.cover-card')
  const thumb = q('.cover-thumb')
  const tz = q('.cover-titlezone')
  const row = q('.list-row')
  return {
    theme: document.documentElement.dataset.theme,
    vw: document.documentElement.clientWidth,
    titlebarH: r(titlebar),
    logoFont: titlebar && gs(q('.logo')).fontSize,
    tagFont: titlebar && gs(q('.tag')).fontSize,
    searchBorderR: search && gs(search).borderRadius,
    chipBorderR: chips[0] && gs(chips[0]).borderRadius,
    chipFont: chips[0] && gs(chips[0]).fontSize,
    segBorderR: seg && gs(seg).borderRadius,
    navCountFont: nav[0] && gs(nav[0].querySelector('.count')).fontSize,
    coverW: cover && Math.round(cover.getBoundingClientRect().width),
    thumbRatio: thumb && (Math.round((thumb.getBoundingClientRect().height / thumb.getBoundingClientRect().width) * 1000) / 1000),
    tzH: r(tz),
    rowH: r(row),
    appBgOpacity: q('.app-bg') && gs(q('.app-bg')).opacity,
    appBgFilter: q('.app-bg') && gs(q('.app-bg')).filter,
    glassBackdrop: q('.sidebar') && gs(q('.sidebar')).backdropFilter,
    glassBg: q('.sidebar') && gs(q('.sidebar')).backgroundColor,
    panelRadius: q('.sidebar') && gs(q('.sidebar')).borderRadius,
    rootVars: {
      radiusPanel: getComputedStyle(document.documentElement).getPropertyValue('--hh-radius-panel').trim(),
      glassBlurPanel: getComputedStyle(document.documentElement).getPropertyValue('--hh-glass-blur-panel').trim(),
      glassSat: getComputedStyle(document.documentElement).getPropertyValue('--hh-glass-saturate').trim(),
    },
  }
})()`
const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
console.log(JSON.stringify(res.result?.result?.value, null, 1))
ws.close()
