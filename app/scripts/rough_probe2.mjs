// 下载页 + 列表视图粗质量测
const pages = await (await fetch('http://127.0.0.1:9231/json')).json()
const page = pages.find((p) => p.type === 'page' && p.url.includes('localhost'))
if (!page) throw new Error('no page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })) })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// 切到下载页
await send('Runtime.evaluate', { expression: `(() => { const items=[...document.querySelectorAll('.nav-item')]; const d=items.find(i=>i.textContent.includes('下载')); if(d) d.click(); return !!d })()`, returnByValue: true })
await wait(500)
const dl = await send('Runtime.evaluate', { expression: `(() => {
  const gs = (el) => el ? getComputedStyle(el) : null
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const br = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), r: gs(el).borderRadius, bg: gs(el).backgroundColor, bd: gs(el).border } }
  const toolbar = q('.dl-toolbar')
  const seg = q('.seg-filter')
  const rows = qa('.task-row')
  const btns = qa('.dl-btn')
  return {
    toolbar: toolbar ? br(toolbar) : null,
    seg: seg ? br(seg) : null,
    rowCount: rows.length,
    firstRow: rows[0] ? br(rows[0]) : null,
    rowGap: rows[0] && rows[1] ? Math.round(rows[1].getBoundingClientRect().y - rows[0].getBoundingClientRect().bottom) : null,
    dlBtn: btns[0] ? br(btns[0]) : null,
    empty: !!q('.dl-empty'),
  }
})()`, returnByValue: true })
console.log('DL:', JSON.stringify(dl.result?.result?.value, null, 1))

// 切回库页并切列表视图
await send('Runtime.evaluate', { expression: `(() => { const items=[...document.querySelectorAll('.nav-item')]; const l=items.find(i=>i.textContent.includes('全部游戏')); if(l) l.click(); const sb=[...document.querySelectorAll('.seg-btn')]; const lst=sb.find(b=>b.title==='列表视图'); if(lst) lst.click(); return !!lst })()`, returnByValue: true })
await wait(500)
const list = await send('Runtime.evaluate', { expression: `(() => {
  const gs = (el) => el ? getComputedStyle(el) : null
  const qa = (s) => [...document.querySelectorAll(s)]
  const rows = qa('.list-row')
  const br = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), r: gs(el).borderRadius, bg: gs(el).backgroundColor } }
  return {
    rowCount: rows.length,
    first: rows[0] ? br(rows[0]) : null,
    second: rows[1] ? br(rows[1]) : null,
    gap: rows[0] && rows[1] ? Math.round(rows[1].getBoundingClientRect().y - rows[0].getBoundingClientRect().bottom) : null,
  }
})()`, returnByValue: true })
console.log('LIST:', JSON.stringify(list.result?.result?.value, null, 1))
ws.close()
