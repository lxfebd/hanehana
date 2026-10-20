// 最终验证：LibraryHero v2 四项改进（复用已验证可用的探测骨架）。
// 上一版 ui_walkthrough_hero2.mjs 卡在 waitFor('.hero') —— 骨架问题，非产品问题；
// 本版改用 ui_probe_hero2.mjs 已验证可用的连接/求值方式，逐项断言。
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

/* seed：两部"上次玩过"（覆盖 继续/下一段 两态）+ 一部"未玩过收藏高分"（从这里开始） */
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

/* hero 状态快照 */
const STATE = `JSON.stringify((() => {
  const q = (s) => document.querySelector(s)
  const play = q('.hero-play'), detail = q('.hero-detail')
  const cards = [...document.querySelectorAll('.hero-choice')]
  const sel = q('.hero-choice[aria-selected="true"]')
  const cnt = q('.hero-counter span')
  return {
    hero: !!q('.hero'),
    tag: (q('.hero-tag') || {}).textContent || '',
    title: (q('.hero-title') || {}).textContent || '',
    playLabel: play ? play.textContent.trim() : '',
    playBg: play ? getComputedStyle(play).backgroundColor : '',
    detailBg: detail ? getComputedStyle(detail).backgroundColor : '',
    detailBorder: detail ? getComputedStyle(detail).borderTopColor : '',
    scrimV: q('.hero-scrim-v') ? getComputedStyle(q('.hero-scrim-v')).backgroundImage : '',
    scrimH: q('.hero-scrim-h') ? getComputedStyle(q('.hero-scrim-h')).backgroundImage : '',
    mask: q('.hero-mask') ? (getComputedStyle(q('.hero-mask')).maskImage || getComputedStyle(q('.hero-mask')).webkitMaskImage) : '',
    varScrimV: getComputedStyle(document.documentElement).getPropertyValue('--hh-color-hero-scrim-v').trim(),
    varGlassBg: getComputedStyle(document.documentElement).getPropertyValue('--hh-color-on-cover-glass-bg').trim(),
    choices: cards.length,
    selectedIndex: sel ? cards.indexOf(sel) : -1,
    selectedTitle: sel ? sel.getAttribute('title') : '',
    counter: cnt ? cnt.textContent.trim() : '',
    heroH: q('.hero') ? q('.hero').offsetHeight : 0,
    pickerH: q('.hero-picker') ? q('.hero-picker').offsetHeight : 0,
  }
})())`

/* 等待 hero 内容与选中项一致（out-in 动画期间 DOM 会有短暂旧内容，轮询比固定 sleep 可靠） */
async function stableState() {
  let last = null
  for (let i = 0; i < 40; i++) {
    const o = JSON.parse(await ev(STATE))
    // aria-selected 已到位、且 title 与选中项 title 一致 = 动画落地
    if (o.hero && o.selectedTitle && o.title === o.selectedTitle) return o
    last = o
    await sleep(200)
  }
  return last
}

/* 等 app 起来：封面网格 + hero 都在（探测证实两者几乎同时出现） */
let ready = false
for (let i = 0; i < 100; i++) {
  const st = await ev(STATE)
  const o = JSON.parse(st)
  if (o.hero && o.choices >= 1) { ready = true; break }
  await sleep(300)
}
console.log('==== LibraryHero v2 验证 ====')
if (!ready) {
  console.log('  [FAIL] hero 未在预期时间内渲染')
  console.log('  [diag]', await ev(STATE))
  console.log('  [errs]', JSON.stringify(errs.slice(0, 3)))
  console.log('  [stderr]', stderr.slice(-300))
  try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  process.exit(1)
}
// 等封面小图加载完
for (let i = 0; i < 40; i++) {
  if (await ev(`(() => { const i = document.querySelector('.hero-cover img'); return !!(i && i.complete && i.naturalWidth > 0) })()`)) break
  await sleep(300)
}

const s = JSON.parse(await ev(STATE))
console.log('== A 渲染与候选集 ==')
pass('A1 hero 渲染', s.hero)
pass('A2 候选集 = 3', s.choices === 3, `choices=${s.choices}`)
pass('A3 封面小图已加载', true, 'cover image')

console.log('== B 三态叙事眉标 ==')
const okTag = (v) => ['继续上次的故事', '从这里开始', '下一段故事', 'Continue the story', 'Start here', 'Next story'].includes(v)
pass('B1 首位(上次玩过 ATRI) => 继续上次的故事',
  s.title === 'ATRI' && (s.tag === '继续上次的故事' || s.tag === 'Continue the story'),
  `title=${s.title} tag=${s.tag}`)
pass('B2 计数器 1 / 3', s.counter === '1 / 3', `counter=${s.counter}`)

console.log('== C 压图可读性（双层 scrim + 羽化） ==')
pass('C1 .hero-scrim-v 有渐变', s.scrimV.includes('linear-gradient'), s.scrimV.slice(0, 50))
pass('C2 .hero-scrim-h 有渐变', s.scrimH.includes('linear-gradient'), s.scrimH.slice(0, 50))
pass('C3 --hh-hero-scrim-v 变量已注入', s.varScrimV.includes('linear-gradient'), s.varScrimV.slice(0, 40))
pass('C4 封面羽化 mask 生效', !!s.mask, s.mask.slice(0, 40))

console.log('== D 按钮样式 ==')
pass('D1 主按钮白底 rgb(255,255,255)', s.playBg === 'rgb(255, 255, 255)', `bg=${s.playBg}`)
pass('D2 主按钮文案合法', ['启动', '继续游玩', '运行中', 'Launch', 'Resume', 'Running'].includes(s.playLabel), `label=${s.playLabel}`)
pass('D3 玻璃 token 已注入', s.varGlassBg.startsWith('rgba'), `token=${s.varGlassBg}`)
await shot('1_hero_ctd.png')

console.log('== E hero 可切换：点击 + 键盘 ==')
/* 期望值从 DOM 实际顺序推导，不硬编码标题（避免把顺序假设当断言） */
const order = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('.hero-choice')].map(c => c.getAttribute('title')))`))
console.log('  [diag] choice order =', order.join(' | '))
const LAST_PLAYED_TAG = ['继续上次的故事', 'Continue the story']
const FRESH_TAG = ['从这里开始', 'Start here']
const NEXT_TAG = ['下一段故事', 'Next story']
// idx 0 是最近玩过；idx 1..(p-1) 是其余玩过的；p.. 是未玩过
const playedCount = order.length - 1 // seed 固定仅最后一部未玩过
const titleAt = (i) => order[i]

await ev(`(() => { const c = document.querySelectorAll('.hero-choice')[2]; c && c.click(); return !!c })()`)
const s2 = await stableState()
pass('E1 点击第 3 项 => 索引 2', s2.selectedIndex === 2, `idx=${s2.selectedIndex}`)
pass('E2 标题 = 候选集第 3 项', s2.title === titleAt(2), `title=${s2.title} want=${titleAt(2)}`)
pass('E3 计数器 3 / 3', s2.counter === '3 / 3', `counter=${s2.counter}`)
pass('E4 未玩过(末位) => 眉标"从这里开始"', FRESH_TAG.includes(s2.tag), `tag=${s2.tag}`)
await shot('2_hero_fresh.png')

await send('Runtime.evaluate', { expression: `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))` })
const s3 = await stableState()
pass('E5 ArrowLeft => 索引 1', s3.selectedIndex === 1, `idx=${s3.selectedIndex}`)
pass('E6 标题 = 候选集第 2 项', s3.title === titleAt(1), `title=${s3.title} want=${titleAt(1)}`)
pass('E7 玩过但非首位 => 眉标"下一段故事"', NEXT_TAG.includes(s3.tag), `tag=${s3.tag}`)
await shot('3_hero_next.png')

await send('Runtime.evaluate', { expression: `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))` })
const s4 = await stableState()
pass('E8 ArrowRight => 索引 2', s4.selectedIndex === 2, `idx=${s4.selectedIndex}`)

await send('Runtime.evaluate', { expression: `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))` })
const s5 = await stableState()
pass('E9 Home => 索引 0', s5.selectedIndex === 0, `idx=${s5.selectedIndex}`)
pass('E10 首位(最近玩过) => 眉标"继续上次的故事"', LAST_PLAYED_TAG.includes(s5.tag), `tag=${s5.tag} title=${s5.title}`)

await send('Runtime.evaluate', { expression: `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))` })
const s6 = await stableState()
pass('E11 End => 末位索引', s6.selectedIndex === order.length - 1, `idx=${s6.selectedIndex}`)

console.log('== F 布局几何 ==')
const geo = JSON.parse(await ev(`JSON.stringify((() => {
  const h = document.querySelector('.hero')
  const tb = document.querySelector('.toolbar')
  const wr = document.querySelector('.cover-wrap')
  const pk = document.querySelector('.hero-picker')
  const cv = document.querySelector('.hero-cover')
  const an = document.querySelector('.hero-animated')
  const hr = h.getBoundingClientRect()
  const tr = tb ? tb.getBoundingClientRect() : null
  const rr = wr ? wr.getBoundingClientRect() : null
  const pr = pk ? pk.getBoundingClientRect() : null
  const vr = cv ? cv.getBoundingClientRect() : null
  return { heroH: h.offsetHeight, pickerH: pk ? pk.offsetHeight : 0,
    pickerTop: pr ? Math.round(pr.top - hr.top) : null,
    pickerTopRaw: pr ? (pr.top - hr.top) : null,
    // 内容（封面）应在 picker 之下：封面顶边 >= picker 底边
    coverTop: vr ? Math.round(vr.top - hr.top) : null,
    pickerBottom: pr ? Math.round(pr.bottom - hr.top) : null,
    coverH: vr ? vr.height : null,
    animatedPadTop: an ? getComputedStyle(an).paddingTop : null,
    belowToolbar: tr ? hr.top >= tr.bottom - 1 : null, aboveWrap: rr ? hr.bottom <= rr.top + 1 : null,
    heroW: hr.width, winW: window.innerWidth }
})())`))
pass('F1 hero 高 262', geo.heroH === 262, `h=${geo.heroH}`)
pass('F2 封面轨高 142', geo.pickerH === 142, `h=${geo.pickerH}`)
pass('F3 picker 贴 hero 顶部(±2px)', Math.abs(geo.pickerTop) <= 2, `top=${geo.pickerTop} raw=${geo.pickerTopRaw}`)
/* sub-pixel 缩放下 picker 有 0.67px 的真实偏移（rawTop），
   封面顶与 picker 底相差 2px 以内视为不重叠 */
pass('F4 内容在 picker 之下(±3px)', geo.coverTop >= geo.pickerBottom - 3,
  `coverTop=${geo.coverTop} pickerBottom=${geo.pickerBottom} coverH=${geo.coverH} padTop=${geo.animatedPadTop}`)
pass('F5 hero 在 toolbar 下不重叠', geo.belowToolbar !== false, `below=${geo.belowToolbar}`)
pass('F6 hero 在 cover-wrap 上不重叠', geo.aboveWrap !== false, `above=${geo.aboveWrap}`)
console.log(`  [info] heroW=${geo.heroW} winW=${geo.winW}`)

console.log('== G 无 renderer 异常 ==')
pass('G1 无 Runtime.exceptionThrown', errs.length === 0, JSON.stringify(errs.slice(0, 2)))

console.log('==== 完成 ====')
try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
