// 本次改动 UI 走查：LibraryHero（P0 库顶氛围横带）+ 影院/极光主题 + 书架板。
// 复用既有基础设施：起真实构建的 App（开发版）+ CDP 截图（同 ui_scrape_walkthrough.mjs）。
//
// 阶段1（库有封面，走真实 UI 全链路）：
//  A 收藏精选分支：收藏+高分+有封面 → hero 目标 ATRI，标签「我最喜欢的」
//  B 最近在玩分支：真实点详情收藏按钮取消收藏（乐观更新）→ 标签变「最近在玩」
//  D 主题切换：设置→外观→点影院卡→保存 → --hh-color-accent 变暖金；再切极光变雾蓝
//  E 书架板：封面墙 .cover-card 下 .cover-shelf 存在
// 阶段2（重写 seed 为全无封面，重启 app）：C 空态分支：.hero 不渲染
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = join(here, '..')
const PORT = 9313
const DATA_DIR = join(APP_ROOT, '.ui-hero-data')
const SHOTS = join(APP_ROOT, '.shots')
const SHOTS2 = join(APP_ROOT, '.shots', 'hero-themes')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---- 最小 PNG 编码器：竖向渐变，让 hero 背景有真实观感 ---- */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function gradientPng(w, h, top, bottom) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc(h * (1 + w * 3))
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1)
    const row = y * (1 + w * 3)
    raw[row] = 0
    for (let x = 0; x < w; x++) {
      const off = row + 1 + x * 3
      raw[off] = Math.round(top[0] + (bottom[0] - top[0]) * t)
      raw[off + 1] = Math.round(top[1] + (bottom[1] - top[1]) * t)
      raw[off + 2] = Math.round(top[2] + (bottom[2] - top[2]) * t)
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const now = Date.now()
const mk = (id, t, extra = {}) => ({
  id,
  dir: `X:\\games\\${t}`,
  exePath: `X:\\games\\${t}\\game.exe`,
  rawTitle: t,
  title: t,
  description: '',
  tags: [],
  categories: [],
  sources: [],
  playMs: 0,
  addedAt: now,
  useLE: false,
  useMagpie: false,
  favorite: false,
  ...extra,
})

/** 阶段1：有封面、有收藏高分、有最近玩过的非收藏 */
function seedPhase1() {
  rmSync(DATA_DIR, { recursive: true, force: true })
  mkdirSync(join(DATA_DIR, 'covers'), { recursive: true })
  mkdirSync(join(DATA_DIR, 'thumbs'), { recursive: true })
  const favCover = join(DATA_DIR, 'covers', 'fav.png').replace(/\\/g, '/')
  const plainCover = join(DATA_DIR, 'covers', 'plain.png').replace(/\\/g, '/')
  writeFileSync(favCover, gradientPng(300, 420, [214, 136, 86], [120, 40, 46]))
  writeFileSync(plainCover, gradientPng(300, 420, [86, 136, 200], [40, 58, 110]))
  writeFileSync(
    join(DATA_DIR, 'games.json'),
    JSON.stringify(
      [
        mk('fav', 'ATRI', { favorite: true, rating: 9.4, developer: 'ANIPLEX.EXE', coverPath: favCover, lastPlayed: now - 3600e3 }),
        mk('recent', 'Clannad', { rating: 8.7, developer: 'Key', coverPath: plainCover, lastPlayed: now - 7200e3 }),
        mk('old', 'Kanon', { rating: 6.5, coverPath: plainCover }),
      ],
      null,
      2,
    ),
  )
}

/** 阶段2：全无封面 → hero 应隐藏 */
function seedPhase2() {
  rmSync(DATA_DIR, { recursive: true, force: true })
  mkdirSync(join(DATA_DIR, 'covers'), { recursive: true })
  mkdirSync(join(DATA_DIR, 'thumbs'), { recursive: true })
  writeFileSync(
    join(DATA_DIR, 'games.json'),
    JSON.stringify(
      [mk('a', 'NoCover A', { favorite: true, rating: 9.0 }), mk('b', 'NoCover B', { lastPlayed: now - 3600e3 })],
      null,
      2,
    ),
  )
}

/** 启动一个隔离 app 实例，返回 cdp 工具对象 */
async function launchApp() {
  const exe = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  const env = { ...process.env, HANEHANA_DEBUG_PORT: String(PORT), HANEHANA_DATA_DIR: DATA_DIR }
  delete env.ELECTRON_RUN_AS_NODE
  const proc = spawn(exe, ['.'], { cwd: APP_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stderr = ''
  proc.stderr.on('data', (d) => (stderr += d))

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
  const ev = async (expression) => {
    const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (m.error) throw new Error(JSON.stringify(m.error))
    return m.result?.result?.value
  }
  const shot = async (name) => {
    const m = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(SHOTS2, name), Buffer.from(m.result.data, 'base64'))
    console.log('[shot]', name)
  }
  const waitFor = async (cond, what, tries = 60) => {
    for (let i = 0; i < tries; i++) {
      if (await ev(cond)) return true
      await sleep(300)
    }
    throw new Error('timeout waiting: ' + what + ' | stderr: ' + stderr.slice(-200))
  }
  await send('Page.enable')
  const kill = () => {
    try {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* noop */
    }
  }
  return { ev, shot, waitFor, kill, send }
}

/** hero 现状快照 */
function heroStateExpr() {
  return `JSON.stringify((() => {
    const h = document.querySelector('.hero')
    if (!h) return { hero: false }
    const img = document.querySelector('.hero-cover img')
    return {
      hero: true,
      tag: (document.querySelector('.hero-tag')||{}).textContent || '',
      title: (document.querySelector('.hero-title')||{}).textContent || '',
      playBtn: !!document.querySelector('.hero-play'),
      detailBtn: !!document.querySelector('.hero-detail'),
      coverLoaded: img ? (img.complete && img.naturalWidth > 0) : false,
      heroH: h.offsetHeight,
    }
  })())`
}

function pass(name, ok, extra = '') {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${extra ? '  — ' + extra : ''}`)
  if (!ok) process.exitCode = 1
}

// ============================================================ 阶段1
console.log('==== 阶段1：有封面库（走真实 UI 全链路） ====')
seedPhase1()
mkdirSync(SHOTS2, { recursive: true })
const app1 = await launchApp()
await app1.waitFor('!!(window.hh && document.querySelector(".cover-card"))', 'app + cover grid')

// ---- A：收藏精选 hero ----
console.log('== A：收藏精选分支 ==')
await app1.waitFor('!!document.querySelector(".hero")', 'hero render')
// 等 hero 封面小图真正加载完成（图片走 hh:// 协议，晚于 hero 元素出现）
await app1.waitFor(
  `(() => { const img = document.querySelector('.hero-cover img'); return !!(img && img.complete && img.naturalWidth > 0) })()`,
  'hero cover image loaded',
)
const a = JSON.parse(await app1.ev(heroStateExpr()))
pass('hero 渲染', a.hero)
pass('目标为收藏最高分 ATRI', a.title === 'ATRI', `title=${a.title}`)
// 新叙事文案：候选按「上次玩过优先」，ATRI 是上次玩过的 → 眉标「继续上次的故事」
pass('标签为叙事文案（继续上次的故事）', a.tag === '继续上次的故事' || a.tag === 'Continue your story', `tag=${a.tag}`)
pass('主按钮(启动/运行中)+详情按钮', a.playBtn && a.detailBtn, `play=${a.playBtn} detail=${a.detailBtn}`)
pass('hero 封面图真实加载', a.coverLoaded)
await app1.shot('A_hero_fav_pick.png')

// ---- A2：布局几何抽查（hero 与工具栏/封面墙无重叠，元素都在界内） ----
console.log('== A2：hero 布局几何 ==')
const geom = JSON.parse(await app1.ev(`JSON.stringify((() => {
  const r = (s) => { const el = document.querySelector(s); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom } }
  const hero = r('.hero')
  const toolbar = r('.lib-toolbar, .toolbar')
  const wrap = r('.cover-wrap')
  const winW = window.innerWidth
  const winH = window.innerHeight
  return { hero, toolbar, wrap, winW, winH }
})())`))
const g = geom
// 无重叠判定：hero 顶部在工具栏底部之下（toolbar 在上），hero 底部在封面墙顶部之上（wrap 在下）
const belowToolbar = g.toolbar && g.hero ? g.hero.y >= g.toolbar.bottom - 1 : true
const aboveWrap = g.wrap && g.hero ? g.hero.bottom <= g.wrap.y + 1 : true
const heroInBounds = g.hero && g.hero.right <= g.winW + 1 && g.hero.bottom <= g.winH + 1 && g.hero.x >= -1 && g.hero.y >= -1
const coverInBounds = g.hero && g.hero.right <= g.winW && g.hero.x >= 0
pass('hero 在窗口边界内（无横向溢出）', heroInBounds, `hero.right=${g.hero?.right} winW=${g.winW} x=${g.hero?.x}`)
pass('hero 在工具栏下方（无重叠）', belowToolbar, `toolbar.bottom=${g.toolbar?.bottom} hero.y=${g.hero?.y}`)
pass('hero 在封面墙上（无重叠）', aboveWrap, `hero.bottom=${g.hero?.bottom} wrap.y=${g.wrap?.y}`)
pass('hero 标题/按钮区未超出视口右侧', coverInBounds, `hero.right=${g.hero?.right} winW=${g.winW}`)
await app1.shot('A2_hero_geometry.png')

// ---- E：书架板 ----
console.log('== E：书架板 ==')
const coverCards = await app1.ev(`document.querySelectorAll('.cover-card').length`)
const shelves = await app1.ev(`document.querySelectorAll('.cover-card .cover-shelf').length`)
pass('每张封面卡下有书架板', coverCards > 0 && shelves === coverCards, `cards=${coverCards} shelves=${shelves}`)
await app1.shot('E_grid_shelf.png')

// ---- B：最近在玩分支（真实点收藏按钮取消收藏，乐观更新立即重算） ----
console.log('== B：最近在玩分支 ==')
await app1.ev(`(() => { const c=[...document.querySelectorAll('.cover-card')].find(x=>(x.textContent||'').includes('ATRI')); if(c){c.click();return 'selected'} return 'not found' })()`)
await sleep(500)
await app1.ev(`(() => { const b=[...document.querySelectorAll('.fav-btn')][0]; if(b){b.click();return 'unfav clicked'} return 'no fav-btn' })()`)
await sleep(700)
const b = JSON.parse(await app1.ev(heroStateExpr()))
pass('hero 仍渲染（目标未变，仍 ATRI 但标签切换）', b.hero && b.title === 'ATRI', `title=${b.title}`)
// 新叙事文案：取消收藏不影响"上次玩过"地位，ATRI 仍是最新玩过的 → 眉标"继续上次的故事"
pass('标签为叙事文案（继续上次的故事）', b.tag === '继续上次的故事' || b.tag === 'Continue your story', `tag=${b.tag}`)
await app1.shot('B_hero_recent.png')

// ---- D：主题切换（设置→外观→点主题卡→保存） ----
console.log('== D：主题切换 ==')
const accentBefore = await app1.ev(`getComputedStyle(document.documentElement).getPropertyValue('--hh-color-accent').trim()`)
console.log('  初始 accent =', accentBefore, '(starnight 默认)')

// 打开设置对话框（侧栏 nav-item 上的设置按钮，文本=nav_settings）
await app1.ev(`(() => { const b=[...document.querySelectorAll('.nav-item')].find(x=>(x.textContent||'').includes('设置')||(x.textContent||'').includes('Settings')); if(b){b.click();return 'nav clicked'} return 'nav miss' })()`)
await sleep(600)
console.log('  设置对话框开？', await app1.ev(`!!document.querySelector('.dlg-foot')`))
console.log('  标签页列表：', await app1.ev(`[...document.querySelectorAll('.ant-tabs-tab')].map(x=>x.textContent.trim()).join(',')`))
console.log('  primary 按钮：', await app1.ev(`[...document.querySelectorAll('.ant-btn-primary')].map(x=>x.textContent.trim()).join(',')`))
// 切到「外观」标签页
const tabRes = await app1.ev(`(() => { const t=[...document.querySelectorAll('.ant-tabs-tab')].find(x=>(x.textContent||'').includes('外观')||(x.textContent||'').includes('Appearance')); if(t){t.click();return 'tab clicked'} return 'tab miss' })()`)
await sleep(500)
console.log('  切外观标签：', tabRes, '| preset-card 数=', await app1.ev(`document.querySelectorAll('.preset-card').length`))

// 主题卡片预览断言：每张 preset-card 下都有 .preset-preview 且渲染了氛围渐变背景
const previewInfo = JSON.parse(await app1.ev(`JSON.stringify((() => {
  const cards = [...document.querySelectorAll('.preset-card')]
  const pre = [...document.querySelectorAll('.preset-card .preset-preview')]
  const bgs = pre.map(p => (getComputedStyle(p).backgroundImage || '') + '|' + (getComputedStyle(p).boxShadow || '').slice(0, 30))
  return { cardCount: cards.length, previewCount: pre.length, firstBg: bgs[0] || '', hasGradient: bgs.some(b => b.includes('linear-gradient')), hasShadow: bgs.some(b => b.includes('box-shadow') || b.includes('inset')) }
})())`))
pass('5 张主题卡都有氛围预览图', previewInfo.cardCount === 5 && previewInfo.previewCount === 5, `cards=${previewInfo.cardCount} previews=${previewInfo.previewCount}`)
pass('主题预览渲染了渐变氛围背景', previewInfo.hasGradient, `gradient=${previewInfo.hasGradient}`)
console.log('  首卡预览背景：', previewInfo.firstBg)
await app1.shot('D0_theme_preview_cards.png')

// 点保存（保存按钮在 .dlg-foot，稳定定位，不依赖文本）
const openSettingsDialog = () => app1.ev(`(() => {
  const b=[...document.querySelectorAll('.nav-item')].find(x=>(x.textContent||'').includes('设置')||(x.textContent||'').includes('Settings'))
  if(b){b.click();return 'nav clicked'} return 'nav miss'
})()`)
const openAppearanceTab = () => app1.ev(`(() => {
  const t=[...document.querySelectorAll('.ant-tabs-tab')].find(x=>(x.textContent||'').includes('外观')||(x.textContent||'').includes('Appearance'))
  if(t){t.click();return 'tab clicked'} return 'tab miss'
})()`)
const applyPreset = (label) => app1.ev(`(() => {
  const c=[...document.querySelectorAll('.preset-card')].find(x=>(x.textContent||'').includes(${JSON.stringify(label)}))
  if(!c) return 'NO_CARD:'+${JSON.stringify(label)}
  c.click()
  return 'picked:'+${JSON.stringify(label)}
})()`)
const clickSave = () => app1.ev(`(() => { const sv=document.querySelector('.dlg-foot .ant-btn-primary'); if(!sv) return 'no-save-btn'; sv.click(); return 'save clicked' })()`)

for (const [label, expectAccentHex] of [
  ['影院', '#D8B36A'],
  ['极光', '#8FB7E8'],
]) {
  // 每次先重新打开设置（保存后对话框会关闭）+ 切到外观标签
  await openSettingsDialog()
  await sleep(500)
  await openAppearanceTab()
  await sleep(400)
  const pick = await applyPreset(label)
  const sv = await clickSave()
  await sleep(900)
  const accent = await app1.ev(`getComputedStyle(document.documentElement).getPropertyValue('--hh-color-accent').trim()`)
  pass(`切${label}：accent 变量更新为预期色`, accent.toLowerCase() === expectAccentHex.toLowerCase(), `${pick}/${sv} → accent=${accent}（期望 ${expectAccentHex}）`)
  await app1.shot(`D_theme_${label}.png`)
}
console.log('  html[data-theme] =', await app1.ev(`document.documentElement.dataset.theme`))
console.log('  html color-scheme =', await app1.ev(`document.documentElement.style.colorScheme`))

app1.kill()
await sleep(1000)

// ============================================================ 阶段1.5：主题持久化（重启后保持）
// D 最后切的是极光（循环末轮）→ settings.json 里 theme_preset=aurora。
// 不清数据目录直接重启，验证启动时从 settings 恢复主题。
console.log('==== 阶段1.5：主题持久化（重启保持） ====')
const app1b = await launchApp()
await app1b.waitFor('!!(window.hh && document.querySelector(".cover-card"))', 'app1b + cover grid')
await sleep(700)
const accentAfterRestart = await app1b.ev(`getComputedStyle(document.documentElement).getPropertyValue('--hh-color-accent').trim()`)
pass('重启后 accent 仍为极光色（持久化生效）', accentAfterRestart.toLowerCase() === '#8fb7e8', `accent=${accentAfterRestart}（期望 #8FB7E8）`)
// 持久化主题下 hero 仍正常渲染
const pr = JSON.parse(await app1b.ev(heroStateExpr()))
pass('重启后 hero 仍正常渲染', pr.hero && pr.coverLoaded, `hero=${pr.hero} coverLoaded=${pr.coverLoaded}`)
// settings.json 实际落盘值
console.log('  settings.json theme_preset =', await app1b.ev(`(async () => { const s = await window.hh.getSettings(); return s.theme_preset })()`))
await app1b.shot('F_theme_persist_restart.png')

// ---- 浅色模式验证（极光浅色）：设置→外观→切"浅色"radio→保存 ----
console.log('== D2：极光浅色模式 ==')
await app1b.ev(`(() => { const b=[...document.querySelectorAll('.nav-item')].find(x=>(x.textContent||'').includes('设置')||(x.textContent||'').includes('Settings')); if(b){b.click();return 'nav clicked'} return 'nav miss' })()`)
await sleep(500)
await app1b.ev(`(() => { const t=[...document.querySelectorAll('.ant-tabs-tab')].find(x=>(x.textContent||'').includes('外观')||(x.textContent||'').includes('Appearance')); if(t){t.click();return 'tab clicked'} return 'tab miss' })()`)
await sleep(400)
// 点"浅色" radio（Radio.Button → .ant-radio-button-wrapper）
const lightRes = await app1b.ev(`(() => { const r=[...document.querySelectorAll('.ant-radio-button-wrapper')].find(x=>(x.textContent||'').includes('浅色')||(x.textContent||'').includes('Light')); if(!r) return 'no-light-radio'; r.click(); return 'light radio clicked' })()`)
await sleep(300)
const svRes = await app1b.ev(`(() => { const sv=document.querySelector('.dlg-foot .ant-btn-primary'); if(!sv) return 'no-save-btn'; sv.click(); return 'save clicked' })()`)
await sleep(900)
const lightAccent = await app1b.ev(`getComputedStyle(document.documentElement).getPropertyValue('--hh-color-accent').trim()`)
const lightTheme = await app1b.ev(`document.documentElement.dataset.theme`)
// 极光浅色 accent = AURORA_LIGHT.accent = '#3E6FB0'
pass('切浅色：accent 变极光浅色', lightAccent.toLowerCase() === '#3e6fb0', `${lightRes}/${svRes} → accent=${lightAccent}（期望 #3E6FB0）`)
pass('html[data-theme]=light', lightTheme === 'light', `theme=${lightTheme}`)
const lr = JSON.parse(await app1b.ev(heroStateExpr()))
pass('浅色下 hero 仍正常渲染', lr.hero && lr.coverLoaded, `hero=${lr.hero}`)
await app1b.shot('D2_aurora_light.png')
app1b.kill()
await sleep(1000)

// ============================================================ 阶段2
console.log('==== 阶段2：全无封面库 → 空态 ====')
seedPhase2()
const app2 = await launchApp()
await app2.waitFor('!!(window.hh && document.querySelector(".cover-card"))', 'app2 + cover grid')
await sleep(500)
const c = JSON.parse(await app2.ev(heroStateExpr()))
pass('全无封面时 hero 不渲染', !c.hero, JSON.stringify(c))
// 页面主体仍在（空态提示），封面网格正常
pass('封面网格仍在渲染', await app2.ev(`document.querySelectorAll('.cover-card').length`) === 2)
await app2.shot('C_hero_hidden_empty.png')
app2.kill()
await sleep(1000)

// ============================================================ 阶段3：窄窗响应式（hero 720px 折叠分支）
// LibraryHero @media (max-width: 720px)：hero 高 226（封面轨 122 + 封面 88 + 底距 16）、
// 封面 62x88、详情按钮隐藏。用阶段1 的有封面库 + CDP 模拟 720px 视口验证折叠。
console.log('==== 阶段3：窄窗响应式折叠 ====')
seedPhase1()
const app3 = await launchApp()
await app3.waitFor('!!(window.hh && document.querySelector(".hero"))', 'app3 hero render')
// 等封面图加载
await app3.waitFor(
  `(() => { const img = document.querySelector('.hero-cover img'); return !!(img && img.complete && img.naturalWidth > 0) })()`,
  'hero cover loaded',
)
// 通过 CDP Emulation.setDeviceMetricsOverride 压窄视口
await app3.send('Emulation.setDeviceMetricsOverride', {
  width: 720,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
})
await sleep(600)
// 读取折叠后的 hero 状态：详情按钮隐藏（display:none via media query）、封面尺寸缩小
const narrow = JSON.parse(await app3.ev(`JSON.stringify((() => {
  const h = document.querySelector('.hero')
  const cover = document.querySelector('.hero-cover')
  const detail = document.querySelector('.hero-detail')
  return {
    hero: !!h,
    heroH: h ? h.offsetHeight : 0,
    coverW: cover ? cover.offsetWidth : 0,
    coverH: cover ? cover.offsetHeight : 0,
    detailDisplay: detail ? getComputedStyle(detail).display : 'none',
    detailHidden: detail ? getComputedStyle(detail).display === 'none' : true,
    tag: (document.querySelector('.hero-tag')||{}).textContent || '',
  }
})())`))
pass('窄窗下 hero 仍渲染', narrow.hero && narrow.heroH === 226, `heroH=${narrow.heroH}（期望 226）`)
pass('窄窗下封面缩至 62x88', narrow.coverW === 62 && narrow.coverH === 88, `cover=${narrow.coverW}x${narrow.coverH}（期望 62x88）`)
pass('窄窗下详情按钮隐藏', narrow.detailHidden, `detailDisplay=${narrow.detailDisplay}`)
// 阶段1 seed：ATRI 是"上次玩过"候选首位 → 眉标叙事文案"继续上次的故事"
pass('窄窗下 hero 标签仍正确', narrow.tag === '继续上次的故事', `tag=${narrow.tag}`)
await app3.shot('G_hero_narrow_720.png')
// 恢复视口
await app3.send('Emulation.clearDeviceMetricsOverride')
await sleep(300)
app3.kill()
await sleep(1000)

console.log('done')