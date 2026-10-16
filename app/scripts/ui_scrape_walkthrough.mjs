// 真实 UI 走查：起真实构建的 App（开发版），像用户一样点封面→点「刮削」→
// 数对话框里真实渲染出的结果卡（.result-card DOM 节点），并截屏给我自己看。
// 数据隔离在 .uiwalk-data（配合 index.ts 的 userData 隔离，不会撞用户开着的安装版）。
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = join(here, '..')
const PORT = 9312
const DATA_DIR = join(APP_ROOT, '.uiwalk-data')
const SHOTS = join(APP_ROOT, '.shots')
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(SHOTS, { recursive: true })

const now = Math.floor(Date.now() / 1000)
const mk = (id, t) => ({
  id,
  dir: `X:\\games\\${t}`,
  exePath: `X:\\games\\${t}\\game.exe`,
  rawTitle: t,
  title: t,
  titleNative: '',
  description: '',
  coverPath: '',
  releaseDate: '',
  rating: 0,
  tags: [],
  categories: [],
  sources: [],
  playMs: 0,
  lastPlayed: now,
  addedAt: now,
  useLE: false,
  useMagpie: false,
})
// A：典型污染目录名（清洗梯应救回→出结果）；B：用户真实标题 夏ノ音（VNDB 真没收→如实"没找到"）
writeFileSync(
  join(DATA_DIR, 'games.json'),
  JSON.stringify([mk('gA', '【Key】Clannad [EX](完全版)'), mk('gB', '夏ノ音')], null, 2),
)

const exe = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const env = { ...process.env, HANEHANA_DEBUG_PORT: String(PORT), HANEHANA_DATA_DIR: DATA_DIR }
delete env.ELECTRON_RUN_AS_NODE
const proc = spawn(exe, ['.'], { cwd: APP_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let stderr = ''
proc.stderr.on('data', (d) => (stderr += d))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function pageWsUrl() {
  for (let i = 0; i < 120; i++) {
    try {
      const t = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const p = t.find((x) => x.type === 'page' && x.webSocketDebuggerUrl)
      if (p) return p.webSocketDebuggerUrl
    } catch {
      /* 等启动 */
    }
    await sleep(300)
  }
  throw new Error('no page target; stderr: ' + stderr.slice(-300))
}
const ws = new WebSocket(await pageWsUrl())
await new Promise((r, j) => {
  ws.addEventListener('open', r)
  ws.addEventListener('error', j)
})
let mid = 0
const pend = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m)
    pend.delete(m.id)
  }
})
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = ++mid
    pend.set(id, r)
    ws.send(JSON.stringify({ id, method, params }))
  })
async function ev(expression) {
  const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (m.error) throw new Error(JSON.stringify(m.error))
  return m.result?.result?.value
}
async function shot(name) {
  const m = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(m.result.data, 'base64'))
  console.log('[shot]', name)
}
await send('Page.enable')
for (let i = 0; i < 60; i++) {
  if (await ev('!!(window.hh && document.querySelector(".cover-card"))')) break
  await sleep(300)
}

async function openScrapeFor(title) {
  // 点封面卡 → 点详情页「刮削」按钮
  await ev(`(() => {
    const card = [...document.querySelectorAll('.cover-card')].find(c => (c.textContent||'').includes(${JSON.stringify(title)}))
    if (!card) throw new Error('cover-card not found: ${title}')
    card.click(); return 'clicked cover'
  })()`)
  await sleep(400)
  const btn = await ev(`(() => {
    const b = [...document.querySelectorAll('.actions-sub .ghost-btn')].find(x => (x.textContent||'').includes('刮削'))
    if (!b) return 'NOT FOUND'; b.click(); return 'clicked scrape'
  })()`)
  if (btn === 'NOT FOUND') throw new Error('scrape button not found')
}

async function dialogState() {
  return ev(`JSON.stringify({
    dialog: !!document.querySelector('.scrape-body'),
    loading: !!document.querySelector('.scrape-body .center .spin-text'),
    loadingLine: !!document.querySelector('.center-loading-line'),
    cards: document.querySelectorAll('.result-card').length,
    cardTitles: [...document.querySelectorAll('.result-card .r-title')].slice(0,4).map(e=>e.textContent.trim().replace(/\\s+/g,' ').slice(0,60)),
    covers: [...document.querySelectorAll('.result-card .r-cover img')].filter(i=>i.complete&&i.naturalWidth>0).length,
    warnings: [...document.querySelectorAll('.warning')].map(e=>e.textContent.trim().slice(0,60)),
    emptyHint: !!document.querySelector('.center.hint'),
  })`)
}

console.log('== 场景1：污染目录名【Key】Clannad [EX](完全版) ==')
await openScrapeFor('Clannad')
await sleep(3000)
console.log(' 3s 状态(流式)：', await dialogState())
await shot('ui_streaming.png')
await sleep(11000)
console.log('14s 状态(两源落定)：', await dialogState())
await shot('ui_settled.png')
// 选第一张卡 → 应用按钮可用 → 真点「应用选中」→ 验证游戏元数据真的落库
console.log(' 选卡前 games.json：', (await ev('window.hh && 0')) !== null ? '' : '')
const before = JSON.parse(await ev(`(async () => JSON.stringify(await window.hh.listGames()))()`))
const gA0 = before.find((g) => g.id === 'gA')
console.log('  gA 应用前：title=' + JSON.stringify(gA0.title) + ' cover=' + JSON.stringify(gA0.coverPath) + ' rating=' + gA0.rating)
console.log(' 选卡+应用可用性：', await ev(`(() => {
  const c = document.querySelector('.result-card'); if (!c) return 'no card'
  c.click();
  return new Promise(res => requestAnimationFrame(() => {
    const apply = [...document.querySelectorAll('.foot .apply-btn')][0]
    res(JSON.stringify({ picked: !!document.querySelector('.result-card.picked'), applyEnabled: apply && !apply.disabled }))
  }))
})()`))
// 真点「应用选中」
const clicked = await ev(`(() => { const a=[...document.querySelectorAll('.foot .apply-btn')][0]; if(!a||a.disabled) return 'apply disabled'; a.click(); return 'apply clicked' })()`)
console.log(' 点击应用：', clicked)
// applyScrape 内部要先下载封面（TIMEOUT 最长 15s+），期间 updateGame 还没跑。
// 一次性 sleep 后采样会把「进行中」误读成「没落库」——这里轮询到落库或超时。
let gA1 = gA0
for (let i = 0; i < 30; i++) {
  await sleep(1000)
  const list = JSON.parse(await ev(`(async () => JSON.stringify(await window.hh.listGames()))()`))
  gA1 = list.find((g) => g.id === 'gA')
  const dlgOpen = await ev(`!!document.querySelector('.scrape-body')`)
  const errBanner = await ev(`(document.querySelector('.error-banner')||{}).textContent || ''`)
  if (errBanner) console.log('  ⚠ error banner:', errBanner.slice(0, 160))
  if (gA1.title !== gA0.title || gA1.coverPath) break
  if (i % 5 === 4) console.log(`  +${i + 1}s 等待落库… 对话框开着=${dlgOpen}`)
}
console.log('  gA 应用后：title=' + JSON.stringify(gA1.title) + ' native=' + JSON.stringify(gA1.titleNative) + ' cover=' + JSON.stringify(gA1.coverPath) + ' rating=' + gA1.rating + ' desc=' + (gA1.description || '').slice(0, 30))
await shot('ui_after_apply.png')

// 关掉对话框，换 夏ノ音
await ev(`(() => { const x=[...document.querySelectorAll('.scrape-dialog button, .dialog-shell button, .close, [aria-label=close]')]; const b=x.find(e=>(e.className||'').includes('close')); if(b){b.click();return 'closed'} document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); return 'esc' })()`)
await sleep(600)
await ev('window.hh && 1')
console.log('== 场景2：用户真实标题 夏ノ音（VNDB 真没收）==')
await openScrapeFor('夏ノ音')
await sleep(14000)
console.log('14s 状态：', await dialogState())
await shot('ui_notfound.png')

ws.close()
try {
  spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
} catch {
  /* noop */
}
console.log('done')
