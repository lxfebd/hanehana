// 四屏验收截图（对标 ReinaManager 基准图）：
//   1 首页     —— PageHeader + KpiStrip + hero + 续读条 + 封面墙 + 右栏 ActivityFeed
//   2 详情     —— 选中一款 → 元数据行 / 标签全集 / 四分页 / 每游戏曲线
//   3 统计     —— 6 KPI + 周期切换 + 趋势线 + 时段分布
//   4 收藏夹   —— 按开发商 / 系列分组卡
// 用法：node scripts/ui_walkthrough_reina.mjs（须先 npm run build）
// 截图落盘：app/.shots/reina/（基准图在「不要上传…」夹，逐屏人比对）。
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'

const APP_ROOT = join(process.cwd())
const PORT = 9355
const DATA_DIR = join(APP_ROOT, '.reina-data')
const SHOTS = join(APP_ROOT, '.shots', 'reina')
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
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const to = setTimeout(() => reject(new Error('ws timeout')), 10000)
    ws.onopen = () => {
      clearTimeout(to)
      resolve(ws)
    }
    ws.onerror = reject
  })
}
async function main() {
  const wsUrl = await getWsUrl()
  await new Promise((r) => setTimeout(r, 3000))
  const port = (wsUrl.match(/:(\d+)\//) || [])[1]
  let pageJson = null
  for (let i = 0; i < 20 && !pageJson; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      pageJson = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
    } catch {
      /* retry */
    }
    if (!pageJson) await new Promise((r) => setTimeout(r, 500))
  }
  const ws = await connectWs(pageJson.webSocketDebuggerUrl)
  let msgId = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
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
        if (pending.has(m.id)) {
          pending.delete(mid)
          rej(new Error('timeout: ' + method))
        }
      }, 30000)
    })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.exception?.description ?? '') }
    return r.result?.result?.value
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  async function shot(name) {
    mkdirSync(SHOTS, { recursive: true })
    const m = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(SHOTS, name + '.png'), Buffer.from(m.result.data, 'base64'))
    console.log('  shot:' + name + '.png')
  }
  try {
    await send('Page.bringToFront').catch(() => {})
    await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    await wait(2500)
    // 首页：窗口是运行时确定的（1200x800 左右），不强制 resize
    const boot = await ev(
      `JSON.stringify({ cards: document.querySelectorAll('.cover-card').length, kpi: document.querySelectorAll('.kpi-card').length, ph: !!document.querySelector('.page-header'), feed: !!document.querySelector('.activity-feed') })`,
    )
    console.log('HOME:', boot)
    await shot('01-home')

    // 详情：JS click 不需要卡片在视口内——不要 scrollIntoView，
    // 那会把中栏滚下去，截图里页头/KPI 条消失（02 截图曾因此拍成半张脸）。
    await ev(`(() => { document.querySelector('.cover-card')?.click(); return true })()`)
    await wait(900)
    // 面板/中栏回顶部：沿卡片祖先链把所有真滚得动的容器归零
    // （不猜容器类名——谁的 overflow/height 结构以后都会变）。
    await ev(`(() => {
      let el = document.querySelector('.cover-card')
      while (el) { if (el.scrollHeight > el.clientHeight + 1) el.scrollTop = 0; el = el.parentElement }
      window.scrollTo(0, 0)
      const dp = document.querySelector('.detail-panel')
      if (dp) dp.scrollTop = 0
      return true
    })()`)
    await wait(400)
    const dp = await ev(
      `JSON.stringify({ meta: document.querySelectorAll('.dp-meta-cell').length, tags: document.querySelectorAll('.dp-tags-chips .tag-chip').length, tabs: document.querySelectorAll('.dp-tab').length, chart: !!document.querySelector('.play-chart svg') })`,
    )
    console.log('DETAIL:', dp)
    await shot('02-detail')

    // 统计页：经侧栏「更多」→ 统计
    await ev(`(() => {
      const t = [...document.querySelectorAll('.more-toggle')].find(b => (b.textContent||'').includes('更多'))
      t?.click()
      return !!t
    })()`)
    await wait(400)
    await ev(`(() => {
      const b = [...document.querySelectorAll('.more-menu .nav-item')].find(x => (x.textContent||'').includes('统计'))
      if (b) { b.click(); return 'ok' } return 'no'
    })()`)
    await wait(1200)
    const st = await ev(
      `JSON.stringify({ kpi: document.querySelectorAll('.kpi-card').length, chart: !!document.querySelector('.play-chart svg'), hours: document.querySelectorAll('.hour-col').length })`,
    )
    console.log('STATS:', st)
    await shot('03-stats')

    // 收藏夹：侧栏收藏夹入口
    await ev(`(() => {
      const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => (x.textContent||'').includes('收藏夹'))
      if (b) { b.click(); return 'ok' } return 'no'
    })()`)
    await wait(900)
    const coll = await ev(
      `JSON.stringify({ groups: document.querySelectorAll('.coll-card').length })`,
    )
    console.log('COLLECTION:', coll)
    await shot('04-collection')
  } finally {
    ws.close()
    proc.kill()
  }
  process.exit(0)
}
main().catch((e) => {
  console.error(e)
  console.error('--- stderr tail ---')
  console.error(stderr.slice(-2000))
  try {
    proc.kill()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
