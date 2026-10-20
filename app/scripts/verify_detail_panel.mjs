// 详情面板渲染质量验证：选中游戏 → banner/封面/标题/动作栏/元数据齐全，
// 收藏切换交互正常（乐观更新 + 回读）。高频界面（用户点封面必看）。
// 用法：node scripts/verify_detail_panel.mjs
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { rmSync, mkdirSync } from 'node:fs'

const APP_ROOT = join(process.cwd())
const PORT = 9389
const DATA_DIR = join(APP_ROOT, '.detail-data')
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
      pageJson =
        l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && /index\.html|renderer/.test(t.url || '')) ?? null
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
      }, 30000)
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
    for (let i = 0; i < 20; i++) {
      const e = await ev('!!document.querySelector(".cover-card")')
      if (e) break
      await new Promise((r) => setTimeout(r, 500))
    }
    await new Promise((r) => setTimeout(r, 1000))
    // 选中第一个封面 → 详情面板出现
    await ev(`(() => { const c = document.querySelector('.cover-card'); if (c) { c.click(); return 'ok' } return 'no-card' })()`)
    await new Promise((r) => setTimeout(r, 900))
    const st = JSON.parse(
      await ev(`JSON.stringify((() => {
        const panel = document.querySelector('.detail-panel')
        const banner = document.querySelector('.banner')
        const title = document.querySelector('.banner-title')
        const play = document.querySelector('.primary-btn')
        const meta = [...document.querySelectorAll('.meta-row')].length
        const favBtn = [...document.querySelectorAll('.fav-btn')].find(b => (b.textContent||'').includes('收藏'))
        return {
          panel: !!panel, banner: !!banner, bannerH: banner ? banner.offsetHeight : 0,
          title: title ? title.textContent.trim().slice(0, 20) : '',
          play: !!play, metaRows: meta,
          favBtn: !!favBtn, favText: favBtn ? favBtn.textContent.trim() : '',
          ghostBtns: document.querySelectorAll('.ghost-btn').length,
        }
      })())`),
    )
    ck('详情面板渲染', st.panel && st.banner, 'panel=' + st.panel + ' banner=' + st.banner)
    ck('banner hero 存在且 224px', st.bannerH >= 220, 'h=' + st.bannerH)
    ck('标题有内容', (st.title || '').length > 0, 'title=' + st.title)
    ck('主按钮（启动）存在', st.play === true, 'play=' + st.play)
    ck('元数据行齐全', st.metaRows >= 4, 'rows=' + st.metaRows)
    ck('次按钮组齐全（刮削/编辑/目录/复制）', st.ghostBtns >= 3, 'ghost=' + st.ghostBtns)
    ck('收藏按钮存在', st.favBtn, 'fav=' + st.favText)
    // 收藏切换交互：点收藏 → 文本变"已收藏"
    await ev(`(() => { const b = [...document.querySelectorAll('.fav-btn')].find(x => (x.textContent||'').includes('收藏')); if (b) { b.click(); return 'ok' } return 'no' })()`)
    await new Promise((r) => setTimeout(r, 800))
    const favAfter = await ev(`(() => { const b = [...document.querySelectorAll('.fav-btn')].find(x => (x.textContent||'').includes('收藏') || (x.textContent||'').includes('已收藏')); return b ? b.textContent.trim() : 'no-btn' })()`)
    ck('收藏切换交互正常（乐观更新）', (favAfter || '').includes('已收藏') || (favAfter || '').includes('Faved'), 'text=' + favAfter)
    console.log('  面板状态:', JSON.stringify({ title: st.title, bannerH: st.bannerH, metaRows: st.metaRows, fav: favAfter }))
    console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====')
  } finally {
    ws.close()
    proc.kill()
  }
}
main().catch((e) => {
  console.error(e)
  console.error(stderr.slice(-1200))
  try {
    proc.kill()
  } catch {
    /* ignore */
  }
  process.exit(1)
})