// B8 重写：LibraryHero = 首页 Continue 大卡（基准 home.png 口径）验证。
// 旧封面轨（picker/计数器）与叙事眉标退役；新断言面：
//   A 渲染与结构（kicker/大标题左置/meta 本周·总计/recent chips/竖版封面）
//   B chips 切换候选 + 键盘左右/首尾
//   C 布局几何（左列文字与右列封面分区不重叠、在界内）
//   D hero 跟随过滤视图（库页搜索 → 首页候选收窄；全空 → .hero-empty）
//   E 无 renderer 异常
// 启动页是 home（B8），库页导航用侧栏「全部游戏」。
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = join(here, '..')
const PORT = 9318
const DATA_DIR = join(APP_ROOT, '.ui-hero2-data')
const SHOTS2 = join(APP_ROOT, '.shots', 'hero2')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32Safe(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = (CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const full = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32Safe(full), 0)
  return Buffer.concat([len, full, crc])
}
function grad(w, h, top, bottom) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc(h * (1 + w * 3))
  for (let y = 0; y < h; y++) {
    const t = h === 1 ? 0 : y / (h - 1)
    const row = y * (1 + w * 3); raw[row] = 0
    for (let x = 0; x < w; x++) {
      const o = row + 1 + x * 3
      raw[o] = Math.round(top[0] + (bottom[0] - top[0]) * t)
      raw[o + 1] = Math.round(top[1] + (bottom[1] - top[1]) * t)
      raw[o + 2] = Math.round(top[2] + (bottom[2] - top[2]) * t)
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
}

const now = Date.now()
const mk = (id, t, e = {}) => ({ id, dir: `X:\\g\\${t}`, exePath: `X:\\g\\${t}\\game.exe`, rawTitle: t, title: t, description: '', tags: [], categories: [], sources: [], playMs: 0, addedAt: now, useLE: false, useMagpie: false, favorite: false, ...e })

/* seed：两部「上次玩过」（chips/切换用）+ 一部「未玩过收藏」（候选集尾位，无 lastPlayed 不进 chips） */
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(join(DATA_DIR, 'covers'), { recursive: true })
mkdirSync(join(DATA_DIR, 'thumbs'), { recursive: true })
const c1 = join(DATA_DIR, 'covers', 'a.png').replace(/\\/g, '/')
const c2 = join(DATA_DIR, 'covers', 'b.png').replace(/\\/g, '/')
const c3 = join(DATA_DIR, 'covers', 'c.png').replace(/\\/g, '/')
writeFileSync(c1, grad(300, 420, [214, 136, 86], [120, 40, 46]))
writeFileSync(c2, grad(300, 420, [86, 136, 200], [40, 58, 110]))
writeFileSync(c3, grad(300, 420, [96, 96, 104], [30, 30, 38]))
writeFileSync(join(DATA_DIR, 'games.json'), JSON.stringify([
  mk('g1', 'ATRI', { lastPlayed: now - 3600e3, coverPath: c1, developer: 'ANIPLEX.EXE', rating: 9.4 }),
  mk('g2', 'GINKA', { lastPlayed: now - 7200e3, coverPath: c2, developer: 'Frontwing', rating: 8.9 }),
  mk('g3', 'SUMMER', { favorite: true, rating: 6.0, coverPath: c3, developer: 'condis' }),
], null, 2))
mkdirSync(SHOTS2, { recursive: true })
console.log('[seed] 3 games, covers written')

/* ---- 启动与 CDP（与已验证可用的探测脚本同一实现） ---- */
const exe = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const env = { ...process.env, HANEHANA_DEBUG_PORT: String(PORT), HANEHANA_DATA_DIR: DATA_DIR }
delete env.ELECTRON_RUN_AS_NODE
const proc = spawn(exe, ['.'], { cwd: APP_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let stderr = ''
proc.stderr.on('data', (d) => (stderr += d))
let wsUrl
for (let i = 0; i < 90; i++) {
  try {
    const t = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    const p = t.find((x) => x.type === 'page' && x.webSocketDebuggerUrl)
    if (p) { wsUrl = p.webSocketDebuggerUrl; break }
  } catch { /* wait */ }
  await sleep(500)
}
if (!wsUrl) { console.log('FAIL no cdp target'); try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}; process.exit(1) }
const sock = new WebSocket(wsUrl)
await new Promise((r, j) => { sock.addEventListener('open', r); sock.addEventListener('error', j) })
let mid = 0; const pend = new Map(); const errs = []
sock.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    errs.push(((d.exception && d.exception.description) || d.text || '').slice(0, 300))
  }
})
const send = (method, params = {}) => new Promise((r) => { const id = ++mid; pend.set(id, r); sock.send(JSON.stringify({ id, method, params })) })
const ev = async (x) => {
  const m = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })
  if (m.error) throw new Error(JSON.stringify(m.error))
  return m.result?.result?.value
}
const shot = async (name) => {
  const m = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS2, name), Buffer.from(m.result.data, 'base64'))
}
await send('Runtime.enable')
await send('Page.enable')

function pass(name, ok, extra = '') {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${extra ? '  -- ' + extra : ''}`)
  if (!ok) process.exitCode = 1
}

/** 侧栏导航（B8：启动页 home，封面墙在库页） */
async function navTo(label) {
  return ev(`(() => { const b=[...document.querySelectorAll('.sidebar .nav-item')].find(x=>(x.textContent||'').includes(${JSON.stringify(label)})); if(b){b.click();return 'ok'} return 'no' })()`)
}

/* hero 状态快照（新 Continue 卡结构） */
const STATE = `JSON.stringify((() => {
  const q = (s) => document.querySelector(s)
  const main = q('.hero-main'), cover = q('.hero-cover'), play = q('.hero-play')
  const chips = [...document.querySelectorAll('.hero-recent-chip')]
  return {
    hero: !!q('.hero'),
    emptyCard: !!q('.hero-empty'),
    kicker: (q('.hero-kicker') || {}).textContent || '',
    title: (q('.hero-title') || {}).textContent || '',
    meta: (q('.hero-meta') || {}).textContent || '',
    playLabel: play ? play.textContent.trim() : '',
    chips: chips.length,
    chipTitles: chips.map(c => (c.querySelector('.hero-recent-title')||{}).textContent?.trim() || ''),
    currentChip: chips.findIndex(c => c.classList.contains('current')),
    mainRect: main ? (() => { const r = main.getBoundingClientRect(); return { left: r.left, right: r.right, w: r.width } })() : null,
    coverRect: cover ? (() => { const r = cover.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height } })() : null,
    heroRect: q('.hero') ? (() => { const r = q('.hero').getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: r.width, h: r.height } })() : null,
    winW: window.innerWidth, winH: window.innerHeight,
  }
})())`

async function stableState() {
  let last = null
  for (let i = 0; i < 40; i++) {
    const o = JSON.parse(await ev(STATE))
    if (o.hero && o.title) return o
    last = o
    await sleep(200)
  }
  return last
}

console.log('==== LibraryHero (Continue 卡) 验证 ====')
/* 等 hero 渲染（启动页 home） */
let ready = false
for (let i = 0; i < 100; i++) {
  const o = JSON.parse(await ev(STATE))
  if (o.hero && o.chips >= 1) { ready = true; break }
  await sleep(300)
}
if (!ready) {
  pass('hero 未在预期时间内渲染', false)
  console.log('  [diag]', await ev(STATE))
  console.log('  [errs]', JSON.stringify(errs.slice(0, 3)))
  console.log('  [stderr]', stderr.slice(-300))
  try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  process.exit(1)
}
// 等封面图加载
for (let i = 0; i < 40; i++) {
  if (await ev(`(() => { const i = document.querySelector('.hero-cover img'); return !!(i && i.complete && i.naturalWidth > 0) })()`)) break
  await sleep(300)
}

const s = await stableState()
console.log('== A 渲染与结构 ==')
pass('A1 hero 渲染', s.hero)
pass('A2 kicker 文案（继续游玩）', ['继续游玩', 'Continue playing', 'Continue'].some((x) => (s.kicker || '').includes(x)), `kicker=${s.kicker}`)
pass('A3 主角 = 最近玩过的 ATRI', s.title === 'ATRI', `title=${s.title}`)
pass('A4 meta 含「本周/总计」口径（home_hero_meta）', /本周|总计|week|total/i.test(s.meta), `meta=${s.meta}`)
pass('A5 recent chips = 2（玩过两款进 chips，未玩过不进）', s.chips === 2, `chips=${s.chips} titles=${JSON.stringify(s.chipTitles)}`)
pass('A6 首个 chip 即当前主角（current 标记）', s.currentChip === 0, `currentChip=${s.currentChip}`)
pass('A7 主按钮文案合法', ['启动', '继续游玩', '运行中', 'Launch', 'Resume', 'Running'].some((x) => (s.playLabel || '').includes(x)), `label=${s.playLabel}`)
pass('A8 竖版封面在界内且比例竖版', s.coverRect && s.coverRect.h > s.coverRect.w && s.coverRect.right <= s.winW + 1, JSON.stringify(s.coverRect))
await shot('1_hero_continue.png')

console.log('== B chips 切换候选 + 键盘 ==')
const chipOrder = s.chipTitles
await ev(`(() => { const chips=[...document.querySelectorAll('.hero-recent-chip')]; const c=chips[chips.length-1]; if(c){c.click();return 'ok'} return 'no' })()`)
const s2 = await stableState()
pass('B1 点击末位 chip => 主角切换', s2.title === chipOrder[chipOrder.length - 1], `title=${s2.title} want=${chipOrder[chipOrder.length - 1]}`)

await ev(`(() => { if (document.activeElement) document.activeElement.blur(); return 'ok' })()`)
await send('Runtime.evaluate', { expression: `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))` })
const s3 = await stableState()
pass('B2 ArrowLeft => 切回上一个候选（ATRI）', s3.title === chipOrder[0], `title=${s3.title}`)
await send('Runtime.evaluate', { expression: `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))` })
const s4 = await stableState()
pass('B3 ArrowRight => 循环切换', s4.title === chipOrder[1], `title=${s4.title}`)
await send('Runtime.evaluate', { expression: `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))` })
const s5 = await stableState()
pass('B4 Home => 首位候选', s5.title === chipOrder[0], `title=${s5.title}`)
await send('Runtime.evaluate', { expression: `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))` })
const s6 = await stableState()
pass('B5 End => 末位候选（含未玩过款）', s6.title === 'SUMMER', `title=${s6.title}`)
await shot('2_hero_switch.png')

console.log('== C 布局几何：左列文字与右列封面分区不重叠 ==')
const g = JSON.parse(await ev(STATE))
pass('C1 封面列在文字列之右（分区不重叠）', g.mainRect && g.coverRect && g.coverRect.left >= g.mainRect.right - 1, `main.right=${g.mainRect?.right} cover.left=${g.coverRect?.left}`)
pass('C2 hero 整卡在视口内', g.heroRect && g.heroRect.x >= -1 && g.heroRect.right <= g.winW + 1 && g.heroRect.y >= -1 && g.heroRect.bottom <= g.winH + 1, JSON.stringify(g.heroRect))
pass('C3 封面列未超出 hero 卡', g.heroRect && g.coverRect && g.coverRect.right <= g.heroRect.right + 1 && g.coverRect.bottom <= g.heroRect.bottom + 1, JSON.stringify({ cover: g.coverRect, hero: g.heroRect }))
pass('C4 旧封面轨/计数器已退役', (await ev(`document.querySelectorAll('.hero-picker, .hero-thumb, .hero-counter, .hero-stats').length`)) === 0, 'picker/counter/stats 残留')

console.log('== D hero 跟随过滤视图 ==')
// 库页搜索 → 首页候选收窄（hero 与封面墙说同一件事）
await navTo('全部游戏')
await sleep(700)
const searchBox = async (text) => {
  await ev(`(() => { const i = document.querySelector('.search-box input, .toolbar input'); if(!i) return false; i.focus(); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
}
await searchBox('GINKA')
await sleep(900)
await navTo('首页')
await sleep(700)
const fs1 = JSON.parse(await ev(STATE))
pass('D1 过滤后 hero 主角 = 命中项', fs1.hero && fs1.title === 'GINKA', `title=${fs1.title}`)
pass('D2 过滤后 chips 收窄', fs1.chips === 1, `chips=${fs1.chips}`)

await navTo('全部游戏')
await sleep(500)
await searchBox('zzzz-not-exist')
await sleep(900)
await navTo('首页')
await sleep(700)
const fs2 = JSON.parse(await ev(STATE))
pass('D3 视图全空时 hero 不渲染（.hero 缺席）', fs2.hero === false, `hero=${fs2.hero}`)
pass('D4 视图全空时渲染 .hero-empty 文案', fs2.emptyCard === true, `empty=${fs2.emptyCard}`)
await shot('3_hero_empty.png')

await navTo('全部游戏')
await sleep(500)
await searchBox('')
await sleep(900)
await navTo('首页')
await sleep(700)
const fs3 = JSON.parse(await ev(STATE))
pass('D5 清空搜索后候选恢复', fs3.hero && fs3.chips >= 2, `chips=${fs3.chips}`)

console.log('== E 无 renderer 异常 ==')
pass('E1 无 Runtime.exceptionThrown', errs.length === 0, JSON.stringify(errs.slice(0, 2)))
await shot('4_hero_final.png')

console.log('==== 完成 ====')
try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
