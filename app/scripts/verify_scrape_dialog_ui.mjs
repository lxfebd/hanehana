// 验证 ScrapeDialog：ymgal 徽章样式 + 候选封面悬浮缩放存在
// 用法：node scripts/verify_scrape_dialog_ui.mjs
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { rmSync, mkdirSync } from 'node:fs'

const APP_ROOT = join(process.cwd())
const PORT = 9373
const DATA_DIR = join(APP_ROOT, '.scrape-dialog-data')
for (let i = 0; i < 5; i++) {
  try {
    rmSync(DATA_DIR, { recursive: true, force: true })
    break
  } catch {
    await new Promise((r) => setTimeout(r, 800))
  }
}
mkdirSync(join(DATA_DIR, 'covers'), { recursive: true })
mkdirSync(join(DATA_DIR, 'thumbs'), { recursive: true })
spawnSync(process.execPath, [join(APP_ROOT, 'scripts', 'seed_layout.mjs'), DATA_DIR], {
  cwd: APP_ROOT,
  stdio: ['ignore', 'inherit', 'inherit'],
})
// 把第一款游戏的标题改成「妹相随」：打开刮削对话框 watch open 会自动搜这个标题，
// YMGal 中文源会命中并带 ymgal 徽章——直接走真实 UI 全链路，不依赖键盘模拟。
{
  const fs = await import('node:fs')
  const gp = join(DATA_DIR, 'games.json')
  const games = JSON.parse(fs.readFileSync(gp, 'utf8'))
  if (games.length > 0) {
    games[0].title = '妹相随～黑白世界的缤纷冒险～'
    games[0].rawTitle = '妹相随～黑白世界的缤纷冒险～'
    fs.writeFileSync(gp, JSON.stringify(games, null, 2), 'utf8')
    console.log('  [seed] 第一游戏标题 → 妹相随')
  }
}
const env = { ...process.env, HANEHANA_DEBUG_PORT: String(PORT), HANEHANA_DATA_DIR: DATA_DIR }
delete env.ELECTRON_RUN_AS_NODE
const proc = spawn(join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.'], {
  cwd: APP_ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
let stderr = ''
proc.stderr.on('data', (d) => {
  stderr += d.toString()
})
async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)
    if (m) return m[1]
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('no DevTools')
}
function connectWs(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url)
    const to = setTimeout(() => rej(new Error('ws timeout')), 10000)
    ws.onopen = () => {
      clearTimeout(to)
      res(ws)
    }
    ws.onerror = () => rej(new Error('ws err'))
  })
}
async function main() {
  const wsUrl = await getWsUrl()
  await new Promise((r) => setTimeout(r, 2500))
  const port = (wsUrl.match(/:(\d+)\//) || [])[1]
  let pageJson = null
  for (let i = 0; i < 20 && !pageJson; i++) {
    try {
      const l = await (await fetch('http://127.0.0.1:' + port + '/json')).json()
      pageJson = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && /index\.html|renderer/.test(t.url || '')) ?? null
      if (!pageJson) pageJson = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
    } catch {
      /* retry */
    }
    if (!pageJson) await new Promise((r) => setTimeout(r, 500))
  }
  const ws = await connectWs(pageJson.webSocketDebuggerUrl)
  let msgId = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const mid = ++msgId
      pending.set(mid, res)
      ws.send(JSON.stringify({ id: mid, method, params }))
      setTimeout(() => {
        if (pending.has(mid)) {
          pending.delete(mid)
          rej(new Error('timeout'))
        }
      }, 60000)
    })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.exception?.description ?? '') }
    return r.result?.result?.value
  }
  try {
    let pass = 0
    let fail = 0
    const ck = (n, c, x = '') => {
      if (c) {
        pass++
        console.log('  [PASS] ' + n)
      } else {
        fail++
        console.log('  [FAIL] ' + n + ' ' + (x || ''))
      }
    }
    // 等封面墙
    for (let i = 0; i < 20; i++) {
      const e = await ev('!!document.querySelector(".cover-card")')
      if (e) break
      await new Promise((r) => setTimeout(r, 500))
    }
    await new Promise((r) => setTimeout(r, 800))
    // 打开刮削对话框：点第一个封面卡 → 详情面板点刮削按钮
    await ev(`(() => { const c = document.querySelector('.cover-card'); if (c) { c.click(); return 'ok' } return 'no-card' })()`)
    await new Promise((r) => setTimeout(r, 600))
    const scrapeBtn = await ev(`(() => { const b = [...document.querySelectorAll('.ghost-btn')].find(x => (x.textContent||'').includes('刮削') || (x.textContent||'').includes('Scrape')); if (b) { b.click(); return 'ok' } return 'no-btn:' + [...document.querySelectorAll('.ghost-btn')].map(x => x.textContent.trim()).join(',') })()`)
    console.log('  打开刮削:', scrapeBtn)
    await new Promise((r) => setTimeout(r, 800))
    const dlg = await ev(`!!document.querySelector('.scrape-body')`)
    ck('刮削对话框打开', dlg === true, 'dlg=' + dlg)

    // 搜索由 ScrapeDialog 的 watch(open) 自动触发（query = 改后的「妹相随」标题）
    await new Promise((r) => setTimeout(r, 2000))
    const diag = await ev(`JSON.stringify({ q: (document.querySelector('.scrape-body input')||{}).value || '', spin: !!document.querySelector('.scrape-body .spin'), cards: document.querySelectorAll('.result-card').length, warns: [...document.querySelectorAll('.scrape-body .warning')].map(w => w.textContent.trim()).join(' | '), empty: (document.querySelector('.scrape-body .hint')||{}).textContent?.trim() || '' })`)
    console.log('  dialog diag:', diag)
    let ymBadges = 0
    let lastState = ''
    for (let i = 0; i < 30; i++) {
      ymBadges = await ev(`document.querySelectorAll('.r-badge.ymgal').length`)
      lastState = await ev(`JSON.stringify({ cards: document.querySelectorAll('.result-card').length, spin: !!document.querySelector('.scrape-body .spin'), warns: [...document.querySelectorAll('.scrape-body .warning')].map(w => w.textContent.trim()).join(' | ') })`)
      if (i % 6 === 0) console.log('  t+' + i + 's state=' + lastState)
      if (ymBadges > 0) break
      if (i >= 8) {
        const noSpin = await ev(`!document.querySelector('.scrape-body .spin') && document.querySelectorAll('.result-card').length === 0`)
        if (noSpin) break
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    console.log('  final state:', lastState)
    const provs = await ev(`[...document.querySelectorAll('.result-card')].map(c => ({ p: (c.querySelector('.r-badge')||{}).textContent?.trim() || '', t: ((c.querySelector('.r-title')||{}).textContent||'').slice(0, 20) }))`)
    console.log('  results providers:', JSON.stringify(provs))
    ck('YMGal 结果出现', ymBadges > 0, 'ymgal=' + ymBadges)
    await new Promise((r) => setTimeout(r, 800))
    const ui = JSON.parse(await ev(`JSON.stringify((() => {
      const badge = document.querySelector('.r-badge.ymgal')
      const cover = document.querySelector('.r-cover')
      const badgeCs = badge ? getComputedStyle(badge) : null
      const coverCs = cover ? getComputedStyle(cover) : null
      return {
        badgeCount: document.querySelectorAll('.r-badge.ymgal').length,
        badgeBg: badgeCs ? badgeCs.backgroundColor : '',
        badgeColor: badgeCs ? badgeCs.color : '',
        coverRadius: coverCs ? coverCs.borderRadius : '',
        coverShadow: coverCs ? coverCs.boxShadow : '',
        hasHoverScale: !!(document.querySelector('style') && [...document.querySelectorAll('style')].some(s => (s.textContent||'').includes('.result-card:hover .r-cover')))
      }
    })())`))
    ck('ymgal 徽章有底色（非 transparent）', ui.badgeBg && ui.badgeBg !== 'rgba(0, 0, 0, 0)', 'bg=' + ui.badgeBg)
    ck('ymgal 徽章有文字色', ui.badgeColor && ui.badgeColor !== 'rgba(0, 0, 0, 0)', 'color=' + ui.badgeColor)
    ck('候选封面有圆角', ui.coverRadius && ui.coverRadius !== '0px', 'radius=' + ui.coverRadius)
    ck('候选封面有阴影', !!ui.coverShadow && ui.coverShadow !== 'none', 'shadow=' + String(ui.coverShadow).slice(0, 40))
    // hover 缩放：scoped CSS 选择器带 data-v-xxx 属性，从样式表里找含 .result-card:hover .r-cover 的规则
    const hoverExpr = `(() => { for (const sheet of document.styleSheets) { try { const rules = sheet.cssRules || []; for (const r of rules) { if (r.selectorText && r.selectorText.includes('.result-card:hover .r-cover')) return r.style.transform || 'no-transform' } } catch {} } return 'not-found' })()`
    const hoverRes = await ev(hoverExpr)
    console.log('  hover rule:', hoverRes)
    ck('悬浮缩放 hover 规则存在', typeof hoverRes === 'string' && hoverRes !== 'not-found' && hoverRes !== 'no-transform', 'hover=' + hoverRes)
    console.log('  徽章 bg:', ui.badgeBg, '| 封面 radius:', ui.coverRadius, '| shadow:', String(ui.coverShadow).slice(0, 40))
    console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====')
  } finally {
    ws.close()
    proc.kill()
  }
}
main().catch((e) => {
  console.error(e)
  console.error(stderr.slice(-1500))
  try {
    proc.kill()
  } catch {
    /* ignore */
  }
  process.exit(1)
})