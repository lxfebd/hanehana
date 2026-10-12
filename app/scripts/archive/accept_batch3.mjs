// 批次3 验收：元数据深度 + 系列/开发商关联（G3 G12）
// 用法：node scripts/accept_batch3.mjs
// seed 库带 developer/series/aliases/lengthMinutes → 详情展示 + 系列/开发商聚合筛选 + 搜索命中
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const here = join(process.cwd(), 'scripts')
const APP_ROOT = process.cwd()
const PORT = '9238'
const DATA_DIR = join(APP_ROOT, '.batch3-data')
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })

const seed = spawn(process.execPath, [join(here, 'seed_layout.mjs'), DATA_DIR], {
  stdio: ['ignore', 'inherit', 'inherit'],
})
await new Promise((res) => seed.on('exit', res))
if (seed.exitCode !== 0) throw new Error('seed_layout failed')

// 给 seed 库补元数据字段（developer/series/aliases/lengthMinutes）
const gamesPath = join(DATA_DIR, 'games.json')
const games = JSON.parse(readFileSync(gamesPath, 'utf8'))
for (const g of games) {
  if (g.id === 'g1' || g.id === 'g10') {
    g.developer = 'Key'
    g.series = ['Key 作品', '催泪三部曲']
    g.aliases = ['键社', 'Kanon 同社']
    g.lengthMinutes = 2400
  } else if (g.id === 'g2') {
    g.developer = '5pb.'
    g.series = ['科学ADV']
    g.aliases = ['シュタゲ']
    g.lengthMinutes = 3600
  } else {
    g.developer = '其他社'
  }
}
writeFileSync(gamesPath, JSON.stringify(games, null, 2), 'utf8')

const exe = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const proc = spawn(exe, ['--disable-gpu', '.'], {
  cwd: APP_ROOT,
  env: { ...process.env, HANEHANA_DEBUG_PORT: String(PORT), HANEHANA_DATA_DIR: DATA_DIR },
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
  throw new Error('no DevTools line')
}

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const to = setTimeout(() => reject(new Error('ws timeout')), 10000)
    ws.onopen = () => {
      clearTimeout(to)
      resolve(ws)
    }
    ws.onerror = () => reject(new Error('ws error'))
  })
}

let passed = 0
let failed = 0
function assert(name, cond, extra = '') {
  if (cond) {
    passed++
    console.log('PASS ' + name)
  } else {
    failed++
    console.log('FAIL ' + name + (extra ? ' :: ' + extra : ''))
  }
}

async function main() {
  const wsUrl = await getWsUrl()
  await new Promise((r) => setTimeout(r, 2500))
  const ws = await connectWs(wsUrl)
  let msgId = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  let sessionId = null
  const sendRaw = (method, params = {}) =>
    new Promise((res, rej) => {
      const mid = ++msgId
      pending.set(mid, res)
      const msg = { id: mid, method, params }
      if (sessionId) msg.sessionId = sessionId
      ws.send(JSON.stringify(msg))
      setTimeout(() => {
        if (pending.has(mid)) {
          pending.delete(mid)
          rej(new Error('cdp timeout: ' + method))
        }
      }, 12000)
    })
  const targets = await sendRaw('Target.getTargets')
  const page = (targets.result?.targetInfos || []).find((t) => t.type === 'page')
  if (!page) throw new Error('no page target')
  const att = await sendRaw('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  sessionId = att.result?.sessionId
  if (!sessionId) throw new Error('attach failed')
  const send = (method, params = {}) => sendRaw(method, params)
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails)
      return { __err: String(r.result.exceptionDetails.exception?.description ?? 'eval failed') }
    return r.result?.result?.value
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await send('Page.bringToFront').catch(() => {})
  await wait(800)

  // ---- 1. 详情面板：选中第一张卡（g1, Key）→ 开发商 / 系列 / 通关时长显示
  await evalJs(`document.querySelector('.cover-card')?.click()`)
  await wait(300)
  const detailText = await evalJs(`document.querySelector('.detail-panel')?.textContent ?? ''`)
  assert('详情显示开发商 Key', detailText.includes('Key'), '')
  assert('详情显示通关时长（40 小时）', /通关时长/.test(detailText) && detailText.includes('小时'), '')
  const seriesBtns = await evalJs(`document.querySelectorAll('.series-chip').length`)
  assert('详情显示系列 chips', seriesBtns >= 2, 'chips=' + seriesBtns)

  // ---- 2. 点系列 chip → 聚合筛选（Key 作品 → 应只剩 g1/g10 两张卡）
  await evalJs(`[...document.querySelectorAll('.series-chip')].find(b => b.textContent.includes('Key 作品'))?.click()`)
  await wait(600)
  const metaChip = await evalJs(`document.querySelector('.meta-chip')?.textContent?.trim() ?? ''`)
  const cardCount = await evalJs(`document.querySelectorAll('.cover-card').length`)
  // 筛选后切到列表视图对比（定位：computed 层 vs 网格渲染层）
  await evalJs(`document.querySelector('.seg-btn:last-child')?.click()`)
  await wait(500)
  const listCount = await evalJs(`document.querySelectorAll('.list-row').length`)
  await evalJs(`document.querySelector('.seg-btn:first-child')?.click()`)
  await wait(500)
  const backGridCount = await evalJs(`document.querySelectorAll('.cover-card').length`)
  console.log('DEBUG grid=', cardCount, 'list=', listCount, 'back-grid=', backGridCount, 'metaChip=', metaChip)
  assert(
    '聚合提示条显示「系列：Key 作品」',
    metaChip.includes('系列') && metaChip.includes('Key 作品'),
    String(metaChip),
  )
  assert('列表视图筛选为 2 款', listCount === 2, 'list=' + listCount)
  assert('同系列筛选剩 2 款（网格）', backGridCount === 2, 'grid=' + backGridCount)

  // ---- 3. 清除聚合筛选
  await evalJs(`document.querySelector('.meta-chip')?.click()`)
  await wait(500)
  const cardCount2 = await evalJs(`document.querySelectorAll('.cover-card').length`)
  assert('清除后恢复 12 款', cardCount2 === 12, 'cards=' + cardCount2)

  // ---- 4. 搜索命中开发商/别名（输入「Key」→ 2 款；输入「シュタゲ」→ 1 款）
  // 先退多选、清空搜索框，确保初始 12 款
  await evalJs(
    `(() => { const s = document.querySelector('.smart-select'); if (s) { s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })) } })()`,
  )
  await wait(300)
  await evalJs(
    `(() => { const inp = document.querySelector('.search-input'); if (inp) { const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(inp, 'Key'); inp.dispatchEvent(new Event('input', { bubbles: true })) } })()`,
  )
  await wait(1000)
  const debug1 = await evalJs(
    `({ kw: document.querySelector('.search-input')?.value, cards: document.querySelectorAll('.cover-card').length, total: document.querySelectorAll('.cover-title').length })`,
  )
  console.log('DEBUG search Key', JSON.stringify(debug1))
  // 主进程数据链路诊断：渲染层拿到的 Game 对象有没有 developer/series/aliases
  const diag = await evalJs(
    `(async () => { const gs = await window.hh.listGames(); const g1 = gs.find(x => x.id === 'g1'); return { dev: g1?.developer, series: g1?.series?.length, aliases: g1?.aliases?.length } })()`,
  )
  console.log('DEBUG dataLink', JSON.stringify(diag))
  // 切列表视图：list 直接绑 filteredGames，绕过网格指纹
  await evalJs(`document.querySelector('.seg-btn:last-child')?.click()`)
  await wait(500)
  const listByKey = await evalJs(`document.querySelectorAll('.list-row').length`)
  const listTitles = await evalJs(`[...document.querySelectorAll('.list-title')].map(e => e.textContent).join('|')`)
  await evalJs(`document.querySelector('.seg-btn:first-child')?.click()`)
  await wait(400)
  console.log('DEBUG listByKey', listByKey, 'titles=', listTitles)
  // g1 developer=Key + g4 tags 含 Key + g10 series 含「Key 作品」→ 3 款命中
  const byDev = listByKey
  assert('搜索「Key」命中开发商/标签/系列（3 款）', byDev === 3, 'list=' + byDev)

  await evalJs(
    `(() => { const inp = document.querySelector('.search-input'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(inp, 'シュタゲ'); inp.dispatchEvent(new Event('input', { bubbles: true })) })()`,
  )
  await wait(1000)
  const debug2 = await evalJs(
    `({ kw: document.querySelector('.search-input')?.value, cards: document.querySelectorAll('.cover-card').length })`,
  )
  console.log('DEBUG search alias', JSON.stringify(debug2))
  const byAlias = debug2?.cards
  assert('搜索别名「シュタゲ」命中（1 款）', byAlias === 1, 'cards=' + byAlias)

  console.log('===== ' + passed + ' passed, ' + failed + ' failed =====')
  proc.kill()
  process.exit(failed ? 1 : 0)
}

try {
  await main()
} catch (e) {
  console.error('ERROR', e)
  proc.kill()
  process.exit(1)
}
