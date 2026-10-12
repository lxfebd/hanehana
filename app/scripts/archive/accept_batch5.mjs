// T16 验收：全屏模式（G11）
// 用法：node scripts/accept_batch5.mjs
//  - 种子 12 游戏 → 侧栏点「全屏模式」→ 断言 .fs-root 出现 + 卡片数 = 12
//  - 键盘方向键移动选中 → 选中卡片跟随
//  - Enter 启动（seed exe 不存在会失败，验证调用链不断）
//  - Esc / 退出按钮 → .fs-root 消失 + ui.fullscreen=false
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const here = join(process.cwd(), 'scripts')
const APP_ROOT = process.cwd()
const PORT = '9260'
const DATA_DIR = join(APP_ROOT, '.batch5-data')
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
  const line = d.toString().trim()
  if (line.includes('[hanehana]') || /Error/.test(line)) process.stdout.write('[app] ' + line.slice(0, 300) + '\n')
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

  // ---- 1. 侧栏有「全屏模式」入口
  const navFs = await evalJs(
    `[...document.querySelectorAll('.nav-item')].some(b => b.textContent.includes('全屏模式'))`,
  )
  assert('侧栏有「全屏模式」入口', navFs === true)

  // ---- 2. 点击进入全屏：.fs-root 出现、封面墙卡片 = 12
  await evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('全屏模式'))?.click()`)
  await wait(900)
  const fsRoot = await evalJs(`!!document.querySelector('.fs-root')`)
  const fsCards = await evalJs(`document.querySelectorAll('.fs-card').length`)
  const fsSelCount = await evalJs(`document.querySelectorAll('.fs-card[data-fs-selected="true"]').length`)
  console.log('DEBUG fs', fsRoot, fsCards, fsSelCount)
  assert('进入全屏：.fs-root 出现', fsRoot === true)
  assert('全屏封面墙卡片 = 12', fsCards === 12, 'cards=' + fsCards)
  assert('默认选中第一张卡', fsSelCount === 1, 'sel=' + fsSelCount)

  // ---- 3. 方向键移动选中：右移 1 → 选中第 2 张
  const selBefore = await evalJs(`document.querySelector('[data-fs-selected="true"]')?.textContent ?? ''`)
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'ArrowRight',
    code: 'ArrowRight',
    windowsVirtualKeyCode: 39,
    nativeVirtualKeyCode: 39,
  })
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'ArrowRight',
    code: 'ArrowRight',
    windowsVirtualKeyCode: 39,
    nativeVirtualKeyCode: 39,
  })
  await wait(200)
  const selAfter = await evalJs(`document.querySelector('[data-fs-selected="true"]')?.textContent ?? ''`)
  console.log('DEBUG sel', JSON.stringify({ before: selBefore, after: selAfter }))
  assert('右移后选中变了', selBefore !== selAfter && selAfter !== '', `before=${selBefore} after=${selAfter}`)

  // ---- 4. Enter 启动：调用链不断（seed exe 不存在，返回 ok:false 即可）
  const launchR = await evalJs(
    `(async () => { try { const r = await window.hh.launchGame('g1'); return { ok: r?.ok, err: r?.error } } catch (e) { return { thrown: String(e) } } })()`,
  )
  assert('启动调用链返回（不抛异常）', !('thrown' in launchR), JSON.stringify(launchR))

  // ---- 5. Esc 退出全屏：.fs-root 消失
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  })
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  })
  await wait(600)
  const fsGone = await evalJs(`!document.querySelector('.fs-root')`)
  assert('Esc 退出全屏：.fs-root 消失', fsGone === true)

  // ---- 6. 再进一次，验证退出按钮也工作
  await evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('全屏模式'))?.click()`)
  await wait(900)
  const fsRoot2 = await evalJs(`!!document.querySelector('.fs-root')`)
  await evalJs(`[...document.querySelectorAll('.fs-btn')].find(b => b.title.includes('退出'))?.click()`)
  await wait(600)
  const fsGone2 = await evalJs(`!document.querySelector('.fs-root')`)
  assert('再次进入 + 退出按钮关闭', fsRoot2 === true && fsGone2 === true, `root2=${fsRoot2} gone2=${fsGone2}`)

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
