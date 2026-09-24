// Phase 5 视觉验收入口：起 seed app → 跑 cdp_visual.mjs 8 断言 → 抓 docs/shots/ 基准图。
// 用法：node scripts/phase5_visual.mjs
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = join(here, '..')
const PORT = 9228
const DATA_DIR = join(APP_ROOT, '.p5-data')
const OUT = join(APP_ROOT, '..', 'docs', 'shots')
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(OUT, { recursive: true })

const games = []
const titles = ['素晴らしき日々', '白色相簿2', 'Fate/stay night', 'CLANNAD', 'Rewrite', 'AIR', 'Kanon', '沙耶之歌', 'Ever17', 'Steins;Gate']
for (let i = 0; i < 24; i++) {
  games.push({
    id: 'g' + i, dir: 'D:\\Fake\\Game' + i, exePath: 'D:\\Fake\\Game' + i + '\\game.exe',
    rawTitle: titles[i % titles.length] + (i >= titles.length ? ' ' + Math.floor(i / titles.length) : ''),
    title: titles[i % titles.length] + (i >= titles.length ? ' ' + Math.floor(i / titles.length) : ''),
    titleNative: '日本語タイトル ' + i,
    tags: ['剧情', '治愈'], categories: [['AVG', 'RPG', 'SLG'][i % 3]],
    sources: [{ provider: 'VNDB', url: 'x' }],
    playMs: 3600000 * (i + 1), lastPlayed: Date.now() - 86400000 * i,
    useLE: false, useMagpie: false, addedAt: Date.now(),
    thumbPath: '', color: ['#3b4a6b', '#6b4a5a', '#4a6b52', '#5a5a7a'][i % 4],
    rating: 7 + (i % 30) / 10, releaseDate: '20' + (5 + i % 15) + '-0' + (1 + i % 9) + '-15',
    description: '这是一个测试游戏的简介文本。'.repeat(4),
  })
}
writeFileSync(join(DATA_DIR, 'games.json'), JSON.stringify(games, null, 2), 'utf8')
writeFileSync(join(DATA_DIR, 'settings.json'), JSON.stringify({
  threads: 8, max_concurrent: 3, download_dir: 'D:\\Downloads', proxy: '', user_agent: '',
  confirm_delete: true, dark: true, notify_on_finish: true, notify_on_error: true,
  close_to_tray: true, keep_awake: false, rate_limit_kbps: 0, auto_update_check: true,
}, null, 2), 'utf8')

const exe = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const proc = spawn(exe, ['.'], {
  cwd: APP_ROOT,
  env: { ...process.env, HANEHANA_DEBUG_PORT: String(PORT), HANEHANA_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
})
proc.stderr.on('data', (d) => console.log('[app]', d.toString().trim().slice(0, 160)))

async function waitPort() {
  for (let i = 0; i < 60; i++) {
    try {
      const p = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      if (p.some((x) => x.type === 'page')) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('app did not come up on port ' + PORT)
}

async function main() {
  await waitPort()
  await new Promise((r) => setTimeout(r, 2500))
  const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = pages.find((p) => p.type === 'page' && !p.url.startsWith('devtools'))
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let msgId = 0
  const pending = new Map()
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  await new Promise((r) => (ws.onopen = r))
  const send = (method, params = {}) => new Promise((res) => { const mid = ++msgId; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })) })
  const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.result?.value }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await send('Page.bringToFront').catch(() => {})

  async function shot(name) {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    const buf = Buffer.from(r.result.data, 'base64')
    writeFileSync(join(OUT, name + '.png'), buf)
    console.log('SHOT', name, buf.length)
  }

  // 4 张基准图：库网格 / 详情 / 下载页 / 设置
  await wait(500)
  await shot('01-library-grid')
  await evalJs(`document.querySelector('.cover-card')?.click()`); await wait(700)
  await shot('02-detail')
  await evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('下载任务'))?.click()`); await wait(600)
  await shot('03-downloads')
  await evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('设置'))?.click()`); await wait(700)
  await shot('04-settings')
  ws.close()
}

try {
  await main()
  // 跑 cdp_visual 8 断言（同一端口）
  const p = await new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [join(here, 'cdp_visual.mjs')], {
      env: { ...process.env, HANEHANA_DEBUG_PORT: String(PORT) },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('cdp_visual exit ' + code))))
  })
  console.log('cdp_visual: 8/8 PASS')
  if (process.env.DEBUG_SLEEP) {
    console.log('DEBUG_SLEEP ' + process.env.DEBUG_SLEEP + 's…')
    await new Promise((r) => setTimeout(r, Number(process.env.DEBUG_SLEEP) * 1000))
  }
  process.exitCode = 0
} catch (e) {
  console.error('FAIL', e.message)
  if (process.env.DEBUG_SLEEP) {
    console.log('DEBUG_SLEEP ' + process.env.DEBUG_SLEEP + 's…')
    await new Promise((r) => setTimeout(r, Number(process.env.DEBUG_SLEEP) * 1000))
  }
  process.exitCode = 1
} finally {
  try { proc.kill() } catch {}
  rmSync(DATA_DIR, { recursive: true, force: true })
  console.log('shots in docs/shots/')
}