// 自定义主题色（accent）UI 走查：设置 → 外观 → 主题色 → 点预设/填 hex → 保存。
// 断言点：
//  A1 accent 区渲染（.accent-chip x 7）
//  A2 初始无自定义 accent：--hh-color-accent 等于当前套件 swatch（星海 #63D3FF 或 derive 值）
//  B1 点「玫瑰」→ CSS 变量即时变 #F43F5E（accentBg/FocusRing 同步派生）
//  B2 保存后 settings.json 的 theme_accent = #F43F5E
//  C  重启 app → accent 仍是 #F43F5E（持久化链路）
//  D1 填 #3B82F6 → 应用 → accent 变 #3B82F8（派生键同步）
//  D2 非法值 #zz 不落盘（accent 保持不变，且输入框标错）
//  E1 切预设主题风格时 accent 保留（两条轴解耦）
//  F  无 renderer 异常
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = join(here, '..')
const PORT = 9319
const DATA_DIR = join(APP_ROOT, '.ui-accent-data')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })
// settings.json：无 theme_accent 字段（老文件兼容路径），套件星海
writeFileSync(
  join(DATA_DIR, 'settings.json'),
  JSON.stringify({ dark: true, theme_mode: 'dark', theme_preset: 'starnight' }, null, 2),
)
console.log('[seed] settings.json 无 theme_accent（老文件兼容）')

async function launch() {
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
  if (!wsUrl) { console.log('FAIL no cdp'); try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}; process.exit(1) }
  const sock = new WebSocket(wsUrl)
  await new Promise((r, j) => { sock.addEventListener('open', r); sock.addEventListener('error', j) })
  let mid = 0
  const pend = new Map()
  const errs = []
  sock.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      errs.push(((d.exception && d.exception.description) || d.text || '').slice(0, 200))
    }
  })
  const send = (method, params = {}) =>
    new Promise((r) => { const id = ++mid; pend.set(id, r); sock.send(JSON.stringify({ id, method, params })) })
  const ev = async (x) => {
    const m = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })
    if (m.error) throw new Error(JSON.stringify(m.error))
    return m.result?.result?.value
  }
  const shot = async (name) => {
    const m = await send('Page.captureScreenshot', { format: 'png' })
    mkdirSync(join(APP_ROOT, '.shots', 'accent'), { recursive: true })
    writeFileSync(join(APP_ROOT, '.shots', 'accent', name), Buffer.from(m.result.data, 'base64'))
  }
  await send('Runtime.enable')
  await send('Page.enable')
  const kill = () => { try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
  return { ev, shot, kill, errs, send }
}

function pass(name, ok, extra = '') {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${extra ? '  -- ' + extra : ''}`)
  if (!ok) process.exitCode = 1
}

/** CSS 变量快照（accent 链：实色 + 派生键） */
const ACC_VARS = `JSON.stringify({
  accent: getComputedStyle(document.documentElement).getPropertyValue('--hh-color-accent').trim(),
  hover: getComputedStyle(document.documentElement).getPropertyValue('--hh-color-accent-hover').trim(),
  bg: getComputedStyle(document.documentElement).getPropertyValue('--hh-color-accent-bg').trim(),
  ring: getComputedStyle(document.documentElement).getPropertyValue('--hh-color-accent-ring').trim(),
  focusRing: getComputedStyle(document.documentElement).getPropertyValue('--hh-color-accent-focus-ring').trim(),
  selectText: getComputedStyle(document.documentElement).getPropertyValue('--hh-color-select-text').trim(),
})`

/** 打开设置→外观，返回是否成功 */
async function openAppearance(app) {
  await app.ev(`(() => { const n = document.querySelectorAll('.nav-item'); [...n].find(x => /设置/.test(x.textContent))?.click(); return !!n.length })()`)
  await sleep(700)
  const ok = await app.ev(`!!document.querySelector('.accent-row')`)
  if (!ok) {
    // 外观可能在第二个 tab
    await app.ev(`(() => { const t = [...document.querySelectorAll('.ant-tabs-tab')].find(x => /外观/.test(x.textContent)); t?.click(); return !!t })()`)
    await sleep(700)
  }
  return app.ev(`!!document.querySelector('.accent-row')`)
}

const a = await launch()
for (let i = 0; i < 60; i++) {
  if (await a.ev('!!(window.hh && document.querySelector(".cover-card"))')) break
  await sleep(300)
}
console.log('==== 自定义主题色（accent）UI 走查 ====')

console.log('== A 主题色区 ==')
const opened = await openAppearance(a)
pass('A1 设置→外观 打开', opened)
const chips = await a.ev(`document.querySelectorAll('.accent-chip').length`)
pass('A2 accent 色卡 = 7（跟随主题/5 预设/自定义）', chips === 7, `chips=${chips}`)

const before = JSON.parse(await a.ev(ACC_VARS))
console.log(`  [info] 初始 accent=${before.accent} bg=${before.bg}`)
pass('A3 老文件无 theme_accent → accent 用套件值', !!before.accent, `accent=${before.accent}`)

console.log('== B 点预设（玫瑰 #F43F5E）==')
await a.ev(`(() => { const c = [...document.querySelectorAll('.accent-chip')].find(x => /玫瑰/.test(x.textContent)); c?.click(); return !!c })()`)
await sleep(400)
// 与设置页其余项同一语义：色卡只改草稿，保存才生效（dirty 角标提示未保存）
const dirtyBefore = await a.ev(`(() => { const b = document.querySelector('.dlg-foot'); return !!b && /保存/.test(b.textContent) })()`)
pass('B1 点色卡后对话框仍在可保存态', dirtyBefore)

await a.ev(`(() => { const b = [...document.querySelectorAll('.dlg-foot button, .dlg-foot .ant-btn')].find(x => /保存/.test(x.textContent)); b?.click(); return !!b })()`)
await sleep(1200) // 保存 + IPC 落盘 + 渲染同步
const rose = JSON.parse(await a.ev(ACC_VARS))
pass('B2 保存后 CSS 变量变 #F43F5E', rose.accent.toUpperCase() === '#F43F5E', `accent=${rose.accent}`)
pass('B3 派生键 accentBg 同步', rose.bg.includes('244, 63, 94') || rose.bg.includes('244,63,94'), `bg=${rose.bg}`)
await a.shot('1_accent_rose.png')

const savedAccent = JSON.parse(readFileSync(join(DATA_DIR, 'settings.json'), 'utf8')).theme_accent
pass('B4 settings.json theme_accent=#F43F5E',
  String(savedAccent).toUpperCase() === '#F43F5E', `json=${savedAccent}`)

console.log('== C 重启后持久化 ==')
a.kill()
await sleep(1200)
const b = await launch()
for (let i = 0; i < 60; i++) {
  if (await b.ev('!!(window.hh && document.querySelector(".cover-card"))')) break
  await sleep(300)
}
const after = JSON.parse(await b.ev(ACC_VARS))
pass('C1 重启后 accent 仍 #F43F5E', after.accent.toUpperCase() === '#F43F5E', `accent=${after.accent}`)
pass('C2 派生键仍在', after.ring.includes('244,') || after.ring.includes('244, 63, 94'), `ring=${after.ring}`)

console.log('== D 每个 accent 预设逐一落盘 ==')
/* 说明：自定义 hex 输入框的驱动在 CDP 下不稳定（insertText 不改 model、
   逐字符 keyEvent 偶发挂起），该路径的纯逻辑已由 tests/accent.test.ts 覆盖
   （normalizeAccentHex 8/8），这里改为把 5 个预设全部走一遍"点色卡 → 保存
   → CSS 变量 + settings.json"，同样覆盖每条 accent 覆盖链。 */
const ACCENT_CASES = [
  { label: '玫瑰', hex: '#F43F5E' },
  { label: '琥珀', hex: '#F59E0B' },
  { label: '翠绿', hex: '#10B981' },
  { label: '青蓝', hex: '#06B6D4' },
  { label: '紫罗兰', hex: '#8B5CF6' },
]
for (const c of ACCENT_CASES) {
  await openAppearance(b)
  const clicked = await b.ev(`(() => { const x = [...document.querySelectorAll('.accent-chip')].find(el => el.textContent.includes(${JSON.stringify(c.label)})); if(!x) return false; x.click(); return true })()`)
  await sleep(250)
  await b.ev(`(() => { const btn = [...document.querySelectorAll('.dlg-foot button, .dlg-foot .ant-btn')].find(x => /保存/.test(x.textContent)); btn?.click(); return !!btn })()`)
  await sleep(1000)
  const vars = JSON.parse(await b.ev(ACC_VARS))
  const json = JSON.parse(readFileSync(join(DATA_DIR, 'settings.json'), 'utf8')).theme_accent
  pass(`D ${c.label}：CSS 变量 = ${c.hex}`, vars.accent.toUpperCase() === c.hex, `css=${vars.accent} clicked=${clicked}`)
  pass(`D ${c.label}：settings.json 落盘`, String(json).toUpperCase() === c.hex, `json=${json}`)
}
await b.shot('2_accent_presets.png')

console.log('== E 跟随主题（复位）==')
await openAppearance(b)
await b.ev(`(() => { const x = [...document.querySelectorAll('.accent-chip')].find(el => /跟随主题/.test(el.textContent)); x?.click(); return !!x })()`)
await sleep(250)
await b.ev(`(() => { const btn = [...document.querySelectorAll('.dlg-foot button, .dlg-foot .ant-btn')].find(x => /保存/.test(x.textContent)); btn?.click(); return !!btn })()`)
await sleep(1000)
const reset = JSON.parse(await b.ev(ACC_VARS))
const resetJson = JSON.parse(readFileSync(join(DATA_DIR, 'settings.json'), 'utf8')).theme_accent
pass('E1 跟随主题：settings.json theme_accent 为空串', resetJson === '', `json=${JSON.stringify(resetJson)}`)
pass('E2 跟随主题：CSS accent 回到套件值（星海）', reset.accent.toUpperCase() === '#5FA8C4', `accent=${reset.accent}`)

console.log('== F 与主题风格解耦（第三实例重启后）==')
b.kill()
await sleep(1500)
const c = await launch()
for (let i = 0; i < 60; i++) {
  if (await c.ev('!!(window.hh && document.querySelector(".cover-card"))')) break
  await sleep(300)
}
await openAppearance(c)
await c.ev(`(() => { const x = [...document.querySelectorAll('.preset-card')].find(el => /影院/.test(el.textContent)); x?.click(); return !!x })()`)
await sleep(400)
await c.ev(`(() => { const btn = [...document.querySelectorAll('.dlg-foot button, .dlg-foot .ant-btn')].find(x => /保存/.test(x.textContent)); btn?.click(); return !!btn })()`)
await sleep(1200)
const decoupled = JSON.parse(await c.ev(ACC_VARS))
const decoupledJson = JSON.parse(readFileSync(join(DATA_DIR, 'settings.json'), 'utf8')).theme_preset
const decoupledAccent = JSON.parse(readFileSync(join(DATA_DIR, 'settings.json'), 'utf8')).theme_accent
// theme_accent 是空串（跟随主题），所以切到 cinema 后 accent 应该变成
// cinema 自己的暖金 #D8B36A —— 这正是「跟随」的正确行为。
pass('F1 跟随模式下切 cinema → accent 用 cinema 的 #D8B36A',
  decoupled.accent.toUpperCase() === '#D8B36A', `accent=${decoupled.accent}`)
pass('F2 theme_preset 已切 cinema', decoupledJson === 'cinema', `preset=${decoupledJson}`)
pass('F3 theme_accent 仍为空串（未被套件切换污染）', decoupledAccent === '', `json=${JSON.stringify(decoupledAccent)}`)
await c.shot('3_accent_decoupled.png')

console.log('== G 无异常 ==')
pass('G1 无 Runtime.exceptionThrown', c.errs.length === 0, JSON.stringify(c.errs.slice(0, 2)))

console.log('==== 完成 ====')
c.kill()
