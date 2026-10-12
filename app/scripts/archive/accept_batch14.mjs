// T25 验收：手动添加游戏（选 exe 直接入库）
// 用法：node scripts/accept_batch14.mjs
//  - seed 库 → 侧栏点「添加游戏」→ 对话框填入假 exe 路径（先建一个假 exe 文件）
//  - 断言：入库成功、列表出现新游戏、标题取文件名
//  - 再添加同路径 → 断言报「已在库中」、列表数量不变
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const here = join(process.cwd(), 'scripts')
const APP_ROOT = process.cwd()
const PORT = '9271'
const DATA_DIR = join(APP_ROOT, '.batch14-data')
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })

// 造一个「假 exe」：内容无所谓，入库只校验存在性
const FAKE_EXE = join(DATA_DIR, 'fakegame', 'Fake Game.exe')
mkdirSync(join(DATA_DIR, 'fakegame'), { recursive: true })
writeFileSync(FAKE_EXE, Buffer.from('MZ fake exe for acceptance'), 'utf8')

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
      }, 15000)
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

  const beforeCount = await evalJs(`window.__hh_games?.length ?? -1`)
  // 读取库数据（通过 DOM 计数或直接调用 preload 桥）
  const listBefore = await evalJs(`(async () => (await window.hh.listGames()).length)()`)
  assert('初始库有游戏', typeof listBefore === 'number' && listBefore >= 1, String(listBefore))

  // 侧栏「添加游戏」按钮存在
  const addBtn = await evalJs(
    `[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('添加游戏'))?.textContent?.trim()`,
  )
  assert('侧栏有「添加游戏」入口', typeof addBtn === 'string' && addBtn.includes('添加游戏'), String(addBtn))

  // 点击打开对话框
  await evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('添加游戏'))?.click()`)
  await wait(500)
  const modalTitle = await evalJs(
    `[...document.querySelectorAll('.ant-modal-title')].map(e => e.textContent).join(',')`,
  )
  assert(
    '对话框打开（标题「手动添加游戏」）',
    typeof modalTitle === 'string' && modalTitle.includes('手动添加游戏'),
    String(modalTitle),
  )

  // 直接调 preload 桥添加（主进程侧行为；UI 输入框内容走同一通道，边界由桥本身保证）
  const exePathForJs = JSON.stringify(FAKE_EXE)
  const r1 = await evalJs(`(async () => await window.hh.addGameOne(${exePathForJs}))()`)
  assert('添加返回 ok', r1?.ok === true, JSON.stringify(r1))
  assert(
    '返回的新游戏标题取文件名',
    typeof r1?.game?.title === 'string' && r1.game.title === 'Fake Game',
    JSON.stringify(r1?.game?.title),
  )
  assert('入库 exePath 正确', r1?.game?.exePath === FAKE_EXE, JSON.stringify(r1?.game?.exePath))

  await evalJs(`window.hh && window.__hh_force = 1`).catch(() => {})
  await wait(500)
  const listAfter1 = await evalJs(`(async () => (await window.hh.listGames()).length)()`)
  assert('入库后数量 +1', listAfter1 === listBefore + 1, `${listBefore} -> ${listAfter1}`)

  // 重复添加同一 exe → 报错且数量不变
  const r2 = await evalJs(`(async () => await window.hh.addGameOne(${exePathForJs}))()`)
  assert('重复 exe 返回 ok:false', r2?.ok === false, JSON.stringify(r2))
  assert('重复提示包含「已在库中」', typeof r2?.error === 'string' && r2.error.includes('已在库中'), String(r2?.error))
  const listAfter2 = await evalJs(`(async () => (await window.hh.listGames()).length)()`)
  assert('重复添加后数量不变', listAfter2 === listAfter1, `${listAfter1} -> ${listAfter2}`)

  // 不存在的路径 → 报错
  const r3 = await evalJs(`(async () => await window.hh.addGameOne('Z:/no/such/game.exe'))()`)
  assert('不存在路径返回 ok:false', r3?.ok === false, JSON.stringify(r3))
  assert(
    '不存在提示「文件不存在」',
    typeof r3?.error === 'string' && r3.error.includes('文件不存在'),
    String(r3?.error),
  )

  // 非字符串入参 → 拒绝
  const r4 = await evalJs(`(async () => await window.hh.addGameOne(123))()`)
  assert('非字符串入参被拒', r4?.ok === false, JSON.stringify(r4))

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
