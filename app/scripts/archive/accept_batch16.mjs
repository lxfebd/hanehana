// R2 批次验收：P0-3 错误 advice 上任务行 + P0-4 编辑框可改主 exePath
// 用法：node scripts/accept_batch16.mjs   （须先 npm run build）
//  - P0-4 正例：详情→编辑→改启动路径→保存 → listGames 里 exePath/dir 跟着变
//  - P0-4 负例：改成不存在的路径 → 保存 → 弹窗不关、error-banner 报「启动路径无效」、库不变
//  - P0-3：新增一条连不上的下载任务 → error 态任务行副标题含「 · 」（title · advice）
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const here = join(process.cwd(), 'scripts')
const APP_ROOT = process.cwd()
const PORT = '9273'
const DATA_DIR = join(APP_ROOT, '.batch16-data')
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })

const seed = spawn(process.execPath, [join(here, 'seed_layout.mjs'), DATA_DIR], {
  stdio: ['ignore', 'inherit', 'inherit'],
})
await new Promise((res) => seed.on('exit', res))
if (seed.exitCode !== 0) throw new Error('seed_layout failed')

// 第二个假 exe：模拟「游戏被移动后的新位置」
const FAKE2 = join(DATA_DIR, 'movedgame', 'Moved Game.exe')
mkdirSync(join(DATA_DIR, 'movedgame'), { recursive: true })
const { writeFileSync } = await import('node:fs')
writeFileSync(FAKE2, Buffer.from('MZ moved exe'), 'utf8')

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
  const setInput = async (selector, value) =>
    evalJs(`(() => {
    const inp = document.querySelector(${JSON.stringify(selector)})
    if (!inp) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(inp, ${JSON.stringify(value)})
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  const clickBtnByText = (scopeSel, text) =>
    evalJs(`(() => {
    const scope = document.querySelector(${JSON.stringify(scopeSel)}) ?? document
    const b = [...scope.querySelectorAll('button')].find(x => x.textContent.replace(/\\s/g, '') === ${JSON.stringify(text)} && !x.disabled)
    if (b) { b.click(); return true }
    return false
  })()`)

  try {
    await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    await send('Page.bringToFront').catch(() => {})
    await send('Page.reload', { ignoreCache: true })
    await wait(3500)
    const boot = await evalJs(`document.querySelector('.tag')?.textContent ?? ''`)
    console.log('BOOT:', boot)

    const games = await evalJs(`window.hh.listGames()`)
    assert(
      'seed 游戏列表非空',
      Array.isArray(games) && games.length > 0 && !games.__err,
      JSON.stringify(games?.slice?.(0, 1)),
    )
    const g0 = Array.isArray(games) ? games[0] : null
    const origExe = g0?.exePath

    // ---------- P0-4 正例：UI 改启动路径 ----------
    await evalJs(`document.querySelector('.cover-card, .list-row')?.click()`)
    await wait(700)
    const openedEdit = await evalJs(`(() => {
      const b = [...document.querySelectorAll('.ant-drawer button, .detail-panel button, .panel button, button')]
        .find(x => x.textContent.replace(/\\s/g, '') === '编辑' && !x.disabled)
      if (b) { b.click(); return true }
      return false
    })()`)
    console.log('EDIT_OPENED:', openedEdit)
    assert('详情「编辑」已点开', openedEdit === true, String(openedEdit))
    await wait(800)
    const hasField = await evalJs(`!!document.querySelector('.exe-main')`)
    assert('编辑框含「启动路径」输入', hasField === true, String(hasField))
    const setOk = await setInput('.exe-main input, input.exe-main', FAKE2)
    await wait(300)
    const saved1 = await clickBtnByText('.ant-modal-wrap', '保存')
    console.log('SAVE1:', saved1, 'SET:', setOk)
    await wait(1500)
    const modalClosed = await evalJs(
      `!document.querySelector('.ant-modal-wrap:not([style*="display: none"]) .ant-modal')`,
    )
    const gamesAfter = await evalJs(`window.hh.listGames()`)
    const gAfter = Array.isArray(gamesAfter) ? gamesAfter.find((x) => x.id === g0?.id) : null
    console.log('EXE_AFTER:', gAfter?.exePath, 'DIR:', gAfter?.dir)
    assert('正例：保存后弹窗关闭', modalClosed === true, String(modalClosed))
    assert(
      '正例：exePath 已更新',
      !!gAfter && gAfter.exePath.toLowerCase() === FAKE2.toLowerCase(),
      String(gAfter?.exePath) + ' vs ' + FAKE2,
    )
    const expectDir = FAKE2.slice(0, FAKE2.lastIndexOf('\\'))
    assert(
      '正例：dir 随 exe 重推导',
      !!gAfter && gAfter.dir.toLowerCase() === expectDir.toLowerCase(),
      String(gAfter?.dir),
    )

    // ---------- P0-4 负例：不存在路径被拒 ----------
    await evalJs(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.replace(/\\s/g, '') === '编辑' && !x.disabled)
      if (b) { b.click(); return true }
      return false
    })()`)
    await wait(800)
    await setInput('.exe-main input, input.exe-main', 'Z:\\definitely\\missing\\game.exe')
    await wait(300)
    await clickBtnByText('.ant-modal-wrap', '保存')
    await wait(1500)
    const modalStillOpen = await evalJs(
      `!!document.querySelector('.exe-main') && !!document.querySelector('.ant-modal-wrap:not([style*="display: none"]) .ant-modal')`,
    )
    const banner = await evalJs(`document.querySelector('.error-banner')?.textContent ?? ''`)
    const gamesNeg = await evalJs(`window.hh.listGames()`)
    const gNeg = Array.isArray(gamesNeg) ? gamesNeg.find((x) => x.id === g0?.id) : null
    console.log('NEG_MODAL:', modalStillOpen, 'BANNER:', banner, 'EXE:', gNeg?.exePath)
    assert('负例：保存失败弹窗不关', modalStillOpen === true, String(modalStillOpen))
    assert('负例：error-banner 点名路径无效', String(banner).includes('启动路径无效'), String(banner))
    assert(
      '负例：库中 exePath 未被改坏',
      !!gNeg && gNeg.exePath.toLowerCase() === FAKE2.toLowerCase(),
      String(gNeg?.exePath),
    )
    // 收起弹窗（取消）
    await clickBtnByText('.ant-modal-wrap', '取消')
    await wait(600)

    // ---------- P0-3：错误任务行带 advice ----------
    mkdirSync(join(DATA_DIR, 'downloads'), { recursive: true })
    const add = await evalJs(`window.hh.addTask({
      url: 'http://127.0.0.1:9/dead.bin',
      dest: ${JSON.stringify(join(DATA_DIR, 'downloads'))},
      threads: 1,
      note: 'batch16-error-row',
    })`)
    console.log('ADD_TASK:', JSON.stringify(add))
    await evalJs(`[...document.querySelectorAll('.nav-item')].find(e => e.textContent.includes('下载'))?.click()`)
    await wait(800)
    let sub = ''
    for (let i = 0; i < 40; i++) {
      sub = await evalJs(`(() => {
        const rows = [...document.querySelectorAll('.task-row.error .sub')].map(e => e.textContent || '')
        return rows.find(t => t.includes('batch16-error-row') || t.includes(' · ')) ?? rows[rows.length - 1] ?? ''
      })()`)
      if (String(sub).includes(' · ')) break
      await wait(500)
    }
    console.log('ERROR_SUB:', sub)
    assert('error 任务行副标题含 title · advice', String(sub).includes(' · '), String(sub))
    assert('error 任务行 advice 非空（· 后有内容）', String(sub).split(' · ')[1]?.trim().length > 0, String(sub))
  } finally {
    console.log(`\n==== ${passed} passed, ${failed} failed ====`)
    ws.close()
    proc.kill()
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  try {
    proc.kill()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
