// T24 验收：统计海报导出
// 用法：node scripts/accept_batch13.mjs
//  - seed 库 + 预设 play-sessions.json → 统计页 → 断言「导出海报」按钮存在
//  - 点击按钮 → 经 HANEHANA_EXPORT_DEST 测试缝跳过保存对话框 → PNG 落盘
//  - 校验文件头（PNG 魔数）与尺寸（800×1100）
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const here = join(process.cwd(), 'scripts')
const APP_ROOT = process.cwd()
const PORT = '9270'
const DATA_DIR = join(APP_ROOT, '.batch13-data')
const EXPORT_DEST = join(APP_ROOT, '.batch13-poster.png')
rmSync(DATA_DIR, { recursive: true, force: true })
rmSync(EXPORT_DEST, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })

const seed = spawn(process.execPath, [join(here, 'seed_layout.mjs'), DATA_DIR], {
  stdio: ['ignore', 'inherit', 'inherit'],
})
await new Promise((res) => seed.on('exit', res))
if (seed.exitCode !== 0) throw new Error('seed_layout failed')

// 预设游玩会话：今日 2h / 近 7 天 5h / 近 30 天 12h
const now = Date.now()
const DAY = 86400000
const sessions = []
const mk = (gameId, title, daysAgo, ms) => {
  const start = now - daysAgo * DAY - ms
  const end = now - daysAgo * DAY
  sessions.push({ gameId, title, start, end, ms })
}
mk('g1', '美少女万华镜', 0, 2 * 3600000)
mk('g2', '命运石之门', 1, 3 * 3600000)
mk('g3', 'White Album 2', 20, 7 * 3600000)
writeFileSync(join(DATA_DIR, 'play-sessions.json'), JSON.stringify(sessions, null, 2), 'utf8')

const exe = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const proc = spawn(exe, ['--disable-gpu', '.'], {
  cwd: APP_ROOT,
  env: {
    ...process.env,
    HANEHANA_DEBUG_PORT: String(PORT),
    HANEHANA_DATA_DIR: DATA_DIR,
    HANEHANA_EXPORT_DEST: EXPORT_DEST,
  },
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

  // 切到统计页
  await evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('统计'))?.click()`)
  await wait(800)

  const btnExists = await evalJs(`!!document.querySelector('.poster-btn')`)
  assert('统计页有「导出海报」按钮', btnExists === true)

  const btnText = await evalJs(`document.querySelector('.poster-btn')?.textContent?.trim()`)
  assert('按钮文案为「导出海报」', typeof btnText === 'string' && btnText.includes('导出海报'), String(btnText))

  // 点击导出：Canvas 直绘→PNG data URL→主进程写盘（经测试缝直写 EXPORT_DEST）
  await evalJs(`document.querySelector('.poster-btn')?.click()`)
  await wait(3000)

  assert('PNG 文件已落盘', existsSync(EXPORT_DEST), EXPORT_DEST)
  if (existsSync(EXPORT_DEST)) {
    const buf = readFileSync(EXPORT_DEST)
    assert(
      '文件头是 PNG 魔数',
      buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47,
      'len=' + buf.length,
    )
    assert('文件非空且 > 10KB', buf.length > 10240, 'len=' + buf.length)
    // IHDR 宽高在偏移 16..24（大端）
    const w = buf.readUInt32BE(16)
    const h = buf.readUInt32BE(20)
    assert('海报尺寸 800×1100', w === 800 && h === 1100, `${w}x${h}`)
  }

  // 像素级校验：标题/KPI/区块标题有文字，中部空白区无文字平铺（防碎裂回归）
  const py = process.env.MIMO_PYTHON || 'python'
  const pxOk = spawnSync(py, [join(here, 'assert_poster_pixels.py'), EXPORT_DEST], { encoding: 'utf8' })
  assert(
    '海报像素结构正常',
    pxOk.status === 0,
    String(pxOk.stdout || pxOk.stderr)
      .trim()
      .split('\n')
      .pop(),
  )

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
