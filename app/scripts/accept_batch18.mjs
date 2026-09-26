// R4 批次验收：P1-1 批量刮削（后台队列 + 冲突待确认）
// 用法：node scripts/accept_batch18.mjs   （须先 npm run build）
//  - HANEHANA_SCRAPE_MOCK_FILE 离线固定搜索结果（不依赖 VNDB/Bangumi 外网）
//  - 多选 ≥5 款 → 批量刮削 → 进度/完成计数正确
//  - 高置信唯一命中 → 自动 apply（sources/developer 落库）
//  - 同分多候选 → 进「N 款待确认」列表，可点开单刮对话框
//  - 空结果 → 计入失败，不静默
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const here = join(process.cwd(), 'scripts')
const APP_ROOT = process.cwd()
const PORT = '9275'
const DATA_DIR = join(APP_ROOT, '.batch18-data')
const MOCK_FILE = join(APP_ROOT, '.batch18-scrape-mock.json')
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })

const seed = spawn(process.execPath, [join(here, 'seed_layout.mjs'), DATA_DIR], { stdio: ['ignore', 'inherit', 'inherit'] })
await new Promise((res) => seed.on('exit', res))
if (seed.exitCode !== 0) throw new Error('seed_layout failed')

// 种子 rawTitle（query = rawTitle || title，种子里 rawTitle === title）
const T1 = '美少女万华镜 -理与迷宫的少女们-' // 唯一精确 → 自动应用
const T2 = '命运石之门 STEINS;GATE' // 双源同名同分 → 冲突待确认
const T3 = 'White Album 2 白色相簿2' // 空结果 → 失败
const T4 = 'Summer Pockets REFLECTION BLUE' // 低置信单条 → 待确认
const T5 = 'ATRI -My Dear Moments-' // 唯一精确 → 自动应用

writeFileSync(
  MOCK_FILE,
  JSON.stringify({
    [T1]: [
      { provider: 'vndb', id: 'v1001', title: T1, developer: '零円社', releaseDate: '2021-05-28' },
    ],
    [T2]: [
      { provider: 'vndb', id: 'v1002', title: T2, developer: 'MAGES.', releaseDate: '2009-10-15' },
      { provider: 'bangumi', id: '2002', title: T2, developer: 'MAGES.', releaseDate: '2009-10-15' },
    ],
    [T3]: [],
    [T4]: [
      { provider: 'vndb', id: 'v9999', title: 'Completely Unrelated VN', developer: 'Nobody' },
    ],
    [T5]: [
      { provider: 'vndb', id: 'v1005', title: T5, developer: 'ANIPLEX.EXE', releaseDate: '2020-06-19' },
    ],
  }),
  'utf8',
)

const exe = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const proc = spawn(exe, ['--disable-gpu', '.'], {
  cwd: APP_ROOT,
  env: {
    ...process.env,
    HANEHANA_DEBUG_PORT: String(PORT),
    HANEHANA_DATA_DIR: DATA_DIR,
    HANEHANA_SCRAPE_MOCK_FILE: MOCK_FILE,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
let stderr = ''
proc.stderr.on('data', (d) => { stderr += d.toString() })

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)
    if (m) return m[1]
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('no DevTools line')
}

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const to = setTimeout(() => reject(new Error('ws timeout')), 10000)
    ws.onopen = () => { clearTimeout(to); resolve(ws) }
    ws.onerror = () => reject(new Error('ws error'))
  })
}

let passed = 0
let failed = 0
function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log('PASS ' + name) }
  else { failed++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

async function main() {
  const wsUrl = await getWsUrl()
  await new Promise((r) => setTimeout(r, 2500))
  const port = (wsUrl.match(/:(\d+)\//) || [])[1]
  let pageJson = null
  let lastJson = ''
  for (let i = 0; i < 20 && !pageJson; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      lastJson = JSON.stringify(list.map((t) => ({ type: t.type, url: t.url })))
      pageJson = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
    } catch (e) { lastJson = 'fetch fail: ' + e }
    if (!pageJson) await new Promise((r) => setTimeout(r, 500))
  }
  if (!pageJson) throw new Error('no page target via /json | ' + lastJson)
  const ws = await connectWs(pageJson.webSocketDebuggerUrl)
  let msgId = 0
  const pending = new Map()
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const sendRaw = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++msgId
    pending.set(mid, res)
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }))
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('cdp timeout: ' + method)) } }, 20000)
  })
  const send = (method, params = {}) => sendRaw(method, params)
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.exception?.description ?? 'eval failed') }
    return r.result?.result?.value
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  try {
    await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    await send('Page.bringToFront').catch(() => {})
    await send('Page.reload', { ignoreCache: true })
    await wait(3500)

    // 进多选模式 + 点选前 5 款（Vue 异步渲染，点完先等一帧再数勾选）
    const selected = await evalJs(`(async () => {
      const btn = document.querySelector('button[title="多选模式"]')
      if (!btn) return { step: 'no-btn' }
      btn.click()
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
      const cards = [...document.querySelectorAll('.cover-card')].slice(0, 5)
      if (cards.length < 5) return { step: 'few-cards', n: cards.length }
      for (const c of cards) c.click()
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
      return { step: 'ok', n: cards.length, checked: document.querySelectorAll('.cover-check').length }
    })()`)
    console.log('SELECT:', JSON.stringify(selected))
    assert('进入多选并点选 5 款', selected?.step === 'ok' && selected?.checked >= 5, JSON.stringify(selected))

    const overlay = await evalJs(`(() => {
      const b = document.querySelector('[data-testid="batch-scrape"]')
      return { hasBtn: !!b, countText: document.querySelector('.batch-count')?.textContent ?? '' }
    })()`)
    console.log('OVERLAY:', JSON.stringify(overlay))
    assert('批量浮层出现且含「批量刮削」', overlay?.hasBtn === true && /5 款/.test(overlay?.countText || ''), JSON.stringify(overlay))

    // 触发批量刮削；先抓进度态再等完成
    await evalJs(`document.querySelector('[data-testid="batch-scrape"]').click(); true`)
    await wait(120)
    const mid = await evalJs(`(() => {
      const st = document.querySelector('[data-testid="batch-scrape-status"]')
      return { running: !!st, text: st?.textContent ?? '', hasCancel: !!document.querySelector('[data-testid="batch-scrape-cancel"]') }
    })()`)
    console.log('MID:', JSON.stringify(mid))
    assert('运行中显示进度与取消', mid?.running === true && mid?.hasCancel === true, JSON.stringify(mid))

    // 等完成：进度条消失 + 消息/pending 出现
    let doneInfo = null
    for (let i = 0; i < 40; i++) {
      await wait(300)
      doneInfo = await evalJs(`(() => {
        const st = document.querySelector('[data-testid="batch-scrape-status"]')
        const msg = [...document.querySelectorAll('.ant-message-notice')].map(n => n.textContent).join(' | ')
        const pend = document.querySelector('[data-testid="batch-scrape-pending"]')
        const items = pend ? [...pend.querySelectorAll('.pending-item')].map(b => b.textContent.trim()) : []
        return { stillRunning: !!st, msg, pendCount: items.length, items, hasBtn: !!document.querySelector('[data-testid="batch-scrape"]') }
      })()`)
      if (!doneInfo?.stillRunning && (doneInfo?.msg || doneInfo?.pendCount)) break
    }
    console.log('DONE:', JSON.stringify(doneInfo))
    assert('批量刮削结束（进度条消失）', doneInfo?.stillRunning === false, JSON.stringify(doneInfo))
    assert('完成消息含「已刮削」', String(doneInfo?.msg || '').includes('已刮削'), String(doneInfo?.msg))
    assert('消息报出 2 款待确认', String(doneInfo?.msg || '').includes('2 款待确认'), String(doneInfo?.msg))
    assert('消息报出 1 款失败', String(doneInfo?.msg || '').includes('1 款失败'), String(doneInfo?.msg))
    assert('待确认面板 2 项', doneInfo?.pendCount === 2, JSON.stringify(doneInfo?.items))

    // 落库断言：g1/g5 自动应用；g2/g4 未自动写 sources 新 id；g3 保持原样
    const games = await evalJs(`window.hh.listGames()`)
    const byTitle = (t) => (Array.isArray(games) ? games.find((g) => g.title === t || g.rawTitle === t) : null)
    const g1 = byTitle(T1)
    const g2 = byTitle(T2)
    const g3 = byTitle(T3)
    const g4 = byTitle(T4)
    const g5 = byTitle(T5)
    console.log('G1_DEV:', g1?.developer, 'G5_DEV:', g5?.developer, 'G2_SRC:', JSON.stringify(g2?.sources), 'G3_DEV:', g3?.developer, 'G4_DEV:', g4?.developer)
    assert('g1 高置信自动应用（developer 落库）', g1?.developer === '零円社', String(g1?.developer))
    assert('g1 sources 含 vndb/v1001', Array.isArray(g1?.sources) && g1.sources.some((s) => s.id === 'v1001'), JSON.stringify(g1?.sources))
    assert('g5 高置信自动应用（developer 落库）', g5?.developer === 'ANIPLEX.EXE', String(g5?.developer))
    assert('g2 冲突未自动应用', g2?.developer !== 'MAGES.', String(g2?.developer))
    assert('g3 空结果失败未改写', !g3?.developer, String(g3?.developer))
    assert('g4 低置信未自动应用', g4?.developer !== 'Nobody', String(g4?.developer))

    // 冲突列表可二次确认：点待确认项 → ScrapeDialog 打开且有候选
    const confirm = await evalJs(`(() => {
      const pend = document.querySelector('[data-testid="batch-scrape-pending"]')
      const item = pend && pend.querySelector('.pending-item')
      if (!item) return { step: 'no-item' }
      const label = item.textContent.trim()
      item.click()
      return { step: 'clicked', label }
    })()`)
    await wait(800)
    const dialog = await evalJs(`(() => {
      const modals = [...document.querySelectorAll('.ant-modal')]
      const open = modals.find(m => m.style.display !== 'none' && !m.classList.contains('ant-modal-hidden'))
      const titles = [...document.querySelectorAll('.ant-modal-title')].map(t => t.textContent)
      const cards = document.querySelectorAll('.result-card').length
      return { openTitles: titles, cards, hasScrape: titles.some(t => String(t).includes('元数据刮削')) }
    })()`)
    console.log('CONFIRM:', JSON.stringify(confirm), 'DIALOG:', JSON.stringify(dialog))
    assert('点击待确认项打开刮削对话框', dialog?.hasScrape === true, JSON.stringify(dialog))
    assert('冲突项搜索出 2 个候选', dialog?.cards === 2, String(dialog?.cards))
  } finally {
    console.log(`\n==== ${passed} passed, ${failed} failed ====`)
    ws.close()
    proc.kill()
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  console.error('--- stderr tail ---')
  console.error(stderr.slice(-2000))
  try { proc.kill() } catch { /* ignore */ }
  process.exit(1)
})
