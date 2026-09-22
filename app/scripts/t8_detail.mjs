// T8 验收：详情面板重建（§5.4）。
// 注入 1 条带 thumbPath/description 的假游戏 → 点击封面 → 断言：
//   .detail-panel 宽 360；.banner 高 180；.banner-blur filter 含 blur(32px)；
//   主按钮 backgroundImage 含 linear-gradient；cover 92x138；简介 6 行 clamp；
//   元数据两栏；未选中空态。
//
// 用法：node scripts/t8_detail.mjs
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = join(here, '..')
const DEBUG_PORT = 9226
const DATA_DIR = join(APP_ROOT, '.t8-data')

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { failed++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })
const longDesc = '这是一段很长的游戏简介。'.repeat(30) // ~330 字，超 6 行
writeFileSync(join(DATA_DIR, 'games.json'), JSON.stringify([{
  id: 't8-game',
  dir: 'D:\\Fake\\DetailGame',
  exePath: 'D:\\Fake\\DetailGame\\game.exe',
  rawTitle: '详情测试游戏',
  title: '详情测试游戏',
  titleNative: 'Detail Game (原版名)',
  tags: ['剧情', '治愈', '日常'], categories: ['AVG'], sources: [{ provider: 'VNDB', url: 'x' }],
  playMs: 3600000 * 5 + 60000 * 23, lastPlayed: Date.now() - 86400000 * 2,
  useLE: false, useMagpie: false, addedAt: Date.now(),
  thumbPath: 'C:\\fake\\thumbs\\t8.jpg', color: '#3b4a6b',
  rating: 8.7, description: longDesc,
}], null, 2), 'utf8')

const exe = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const proc = spawn(exe, ['.'], {
  cwd: APP_ROOT,
  env: { ...process.env, HANEHANA_DEBUG_PORT: String(DEBUG_PORT), HANEHANA_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
proc.stderr.on('data', (d) => console.log('[app]', d.toString().trim().slice(0, 160)))
for (let i = 0; i < 60; i++) {
  try { const p = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json(); if (p.some((x) => x.type === 'page')) break } catch {}
  await new Promise((r) => setTimeout(r, 500))
}
const pages = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()
const page = pages.find((p) => p.type === 'page' && !p.url.startsWith('devtools'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
let msgId = 0
const pending = new Map()
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
await new Promise((r) => (ws.onopen = r))
const send = (method, params = {}) => new Promise((resolve) => { const mid = ++msgId; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params })) })
const evalJs = async (expr) => {
  const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (res.result?.exceptionDetails) return { __err: String(res.result.exceptionDetails.exception?.description ?? 'eval failed') }
  return res.result?.result?.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  await wait(2000)
  // 未选中空态先验证
  const empty = await evalJs(`(() => {
    const panel = document.querySelector('.detail-panel')
    return { exists: !!panel, empty: !!panel?.querySelector('.empty-state'), w: panel?.clientWidth }
  })()`)
  check('详情面板存在且初始为空态', empty.exists === true && empty.empty === true, JSON.stringify(empty))
  check('面板宽 360', empty.w === 360, `w=${empty.w}`)

  // 点击第一张卡
  await evalJs(`document.querySelector('.cover-card')?.click()`)
  await wait(800)

  const detail = await evalJs(`(() => {
    const panel = document.querySelector('.detail-panel')
    const banner = panel.querySelector('.banner')
    const blur = panel.querySelector('.banner-blur')
    const cover = panel.querySelector('.banner-cover')
    const primary = panel.querySelector('.primary-btn')
    const desc = panel.querySelector('.desc')
    const toggle = panel.querySelector('.desc-toggle')
    const metaRows = panel.querySelectorAll('.meta-row').length
    return {
      w: panel.clientWidth,
      bannerH: banner?.clientHeight,
      blurFilter: blur ? getComputedStyle(blur).filter : '',
      coverRect: cover ? { w: cover.clientWidth, h: cover.clientHeight } : null,
      primaryBg: primary ? getComputedStyle(primary).backgroundImage : '',
      primaryH: primary?.clientHeight,
      descClamped: desc ? getComputedStyle(desc).WebkitLineClamp : '',
      hasToggle: !!toggle,
      toggleText: toggle?.textContent,
      metaRows,
      chips: [...panel.querySelectorAll('.banner-chips .chip')].map((c) => c.textContent.trim()).join('|'),
    }
  })()`)
  check('面板宽 360（选中态）', detail.w === 360, `w=${detail.w}`)
  check('横幅高 180', detail.bannerH === 180, `h=${detail.bannerH}`)
  check('banner-blur filter 含 blur(32px)', typeof detail.blurFilter === 'string' && detail.blurFilter.includes('blur(32px)'), detail.blurFilter)
  check('cover 92x138', detail.coverRect?.w === 92 && detail.coverRect?.h === 138, JSON.stringify(detail.coverRect))
  check('主按钮 backgroundImage 含 linear-gradient', typeof detail.primaryBg === 'string' && detail.primaryBg.includes('linear-gradient'), detail.primaryBg)
  check('主按钮高 40', detail.primaryH === 40, `h=${detail.primaryH}`)
  check('简介 6 行 clamp', detail.descClamped === '6', `clamp=${detail.descClamped}`)
  check('简介超长显示「展开」', detail.hasToggle === true && detail.toggleText === '展开', `toggle=${detail.toggleText}`)
  check('元数据 4 行', detail.metaRows === 4, `rows=${detail.metaRows}`)
  check('横幅 chips：发行年 + 评分', typeof detail.chips === 'string' && detail.chips.includes('8.7'), detail.chips)

  // 展开/收起
  await evalJs(`document.querySelector('.desc-toggle')?.click()`)
  await wait(300)
  const expanded = await evalJs(`(() => {
    const desc = document.querySelector('.desc')
    const toggle = document.querySelector('.desc-toggle')
    return { clamp: getComputedStyle(desc).WebkitLineClamp, text: toggle?.textContent }
  })()`)
  check('展开后取消 clamp、按钮变「收起」', expanded.clamp === 'none' && expanded.text === '收起', JSON.stringify(expanded))
} catch (e) {
  failed++
  console.log('FATAL', e instanceof Error ? e.message : String(e))
} finally {
  try { proc.kill() } catch {}
  ws.close()
  rmSync(DATA_DIR, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}
