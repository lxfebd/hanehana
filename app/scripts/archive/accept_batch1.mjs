// 批次1 验收：收藏 / 多选批量 / 手动编辑 / 智能列表（G6 G7 G8 G9）
// 用法：node scripts/accept_batch1.mjs
// 断言走真实窗口 + CDP：seed 起应用 → 逐项点按 → 读 DOM/IPC 状态
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const here = join(process.cwd(), 'scripts')
const APP_ROOT = process.cwd()
const PORT = '9234'
const DATA_DIR = join(APP_ROOT, '.batch1-data')
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })

const seed = spawn(process.execPath, [join(here, 'seed_layout.mjs'), DATA_DIR], {
  stdio: ['ignore', 'inherit', 'inherit'],
})
await new Promise((res) => seed.on('exit', res))
if (seed.exitCode !== 0) throw new Error('seed_layout failed')

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
  throw new Error('no DevTools line: ' + stderr.slice(0, 800))
}

function connectWs(url, timeoutSec) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const to = setTimeout(() => reject(new Error('browser ws open timeout')), timeoutSec * 1000)
    ws.onopen = () => {
      clearTimeout(to)
      resolve(ws)
    }
    ws.onerror = () => {
      clearTimeout(to)
      reject(new Error('ws error'))
    }
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
  const ws = await connectWs(wsUrl, 10)
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

  // ---- 1. 智能列表下拉存在 + 切到「未评分」过滤生效
  const smartCount = await evalJs(`document.querySelectorAll('.smart-select option').length`)
  assert('智能列表 5 项（全部+4 预设）', smartCount === 5, 'got ' + smartCount)

  // ---- 2. 收藏按钮：点第一张卡片的收藏 → 卡片出现收藏角标
  const favBefore = await evalJs(`document.querySelectorAll('.cover-fav').length`)
  // 通过详情面板收藏（点第一张卡 → 详情里点收藏按钮）
  await evalJs(`document.querySelector('.cover-card')?.click()`)
  await wait(300)
  const favBtnText = await evalJs(`document.querySelector('.fav-btn')?.textContent?.trim()`)
  await evalJs(`document.querySelector('.fav-btn')?.click()`)
  await wait(400)
  const favAfter = await evalJs(`document.querySelectorAll('.cover-fav').length`)
  assert('详情收藏按钮存在', !!favBtnText, String(favBtnText))
  assert('收藏后出现角标', favAfter === 1, `before=${favBefore} after=${favAfter}`)

  // ---- 3. 多选模式：点工具按钮进多选 → 卡片点击变勾选
  await evalJs(`document.querySelector('.tool-btn[title="多选模式"]')?.click()`)
  await wait(200)
  const multiActive = await evalJs(`!!document.querySelector('.cover-card.multi')`)
  assert('多选模式激活（卡片带 multi 类）', multiActive === true)

  // 点第二、三张卡（第一张进多选时已被自动带入）→ 批量浮层出现，计数 3
  await evalJs(
    `document.querySelectorAll('.cover-card')[1]?.click(); document.querySelectorAll('.cover-card')[2]?.click()`,
  )
  await wait(300)
  const selCount = await evalJs(`document.querySelector('.batch-count')?.textContent?.trim()`)
  assert('批量浮层计数 3 款', /3 款/.test(selCount ?? ''), String(selCount))

  // 批量打评分 9 → 重新进入正常模式，读 store 确认两卡评分都变 9
  await evalJs(`[...document.querySelectorAll('.b-btn')].find(b => b.textContent.includes('9'))?.click()`)
  await wait(500)
  const rated9 = await evalJs(
    `window.__app ? 0 : (() => { const lib = document.querySelectorAll('.cover-card'); return lib.length })()`,
  )
  // 直接从 store 断言不可行（Vue setup 作用域），改从 DOM 检查：重新进列表视图看评分列
  await evalJs(`document.querySelector('.tool-btn[title="多选模式"]')?.click()`)
  await wait(200)
  await evalJs(`document.querySelector('.seg-btn:last-child')?.click()`)
  await wait(300)
  const listRows = await evalJs(`document.querySelectorAll('.list-row').length`)
  const ratedCols = await evalJs(`document.querySelectorAll('.list-cols .num').length`)
  // 评分 9 的卡应该有 9.0 文本
  const rated9txt = await evalJs(
    `[...document.querySelectorAll('.list-cols')].filter(c => c.textContent.includes('9.0')).length`,
  )
  assert('列表视图正常渲染', listRows > 0, 'rows=' + listRows)
  assert('批量评分后列表出现 9.0 列', rated9txt === 3, 'found ' + rated9txt)

  // ---- 4. 智能列表：切到「未评分」应只剩未打分的（seed 全有评分 → 0）
  await evalJs(`document.querySelector('.seg-btn:first-child')?.click()`)
  await wait(200)
  await evalJs(
    `(() => { const s = document.querySelector('.smart-select'); if (s) { s.value = 'unrated'; s.dispatchEvent(new Event('change', { bubbles: true })) } })()`,
  )
  await wait(400)
  const unratedCards = await evalJs(`document.querySelectorAll('.cover-card').length`)
  assert('智能列表「未评分」筛空（seed 全有评分）', unratedCards === 0, 'cards=' + unratedCards)
  // 恢复全部
  await evalJs(
    `(() => { const s = document.querySelector('.smart-select'); if (s) { s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })) } })()`,
  )
  await wait(300)

  // ---- 5. 手动编辑弹窗：选中游戏 → 详情「编辑」→ 弹窗打开 → 标题输入框存在
  await evalJs(`document.querySelector('.cover-card')?.click()`)
  await wait(300)
  await evalJs(`[...document.querySelectorAll('.ghost-btn')].find(b => b.textContent.includes('编辑'))?.click()`)
  await wait(400)
  const editOpen = await evalJs(
    `!!document.querySelector('.ant-modal') && document.body.textContent.includes('编辑游戏信息')`,
  )
  assert('手动编辑弹窗打开', editOpen === true)
  const editInputs = await evalJs(`document.querySelectorAll('.ant-modal input').length`)
  assert('编辑弹窗含输入框', editInputs >= 4, 'inputs=' + editInputs)
  // 改标题并保存
  await evalJs(
    `(() => { const inp = document.querySelector('.ant-modal input'); if (inp) { const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(inp, '编辑测试标题'); inp.dispatchEvent(new Event('input', { bubbles: true })) } })()`,
  )
  await wait(200)
  await evalJs(
    `[...document.querySelectorAll('.ant-modal button')].find(b => b.textContent.trim() === '保存')?.click()`,
  )
  await wait(500)
  const titleSaved = await evalJs(`document.body.textContent.includes('编辑测试标题')`)
  assert('手动编辑保存生效（详情显示新标题）', titleSaved === true)

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
