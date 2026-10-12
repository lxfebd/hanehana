// T18 视觉验收：设置页「工具」页签截图
// 用法：node scripts/shot_tools.mjs
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const APP_ROOT = process.cwd()
const PORT = '9264'
const DATA_DIR = join(APP_ROOT, '.shot-tools-data')
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })
writeFileSync(join(DATA_DIR, 'games.json'), JSON.stringify([], null, 2), 'utf8')

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
  await wait(600)

  // 打开设置 → 切「工具」页签
  await evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('设置'))?.click()`)
  await wait(500)
  await evalJs(`[...document.querySelectorAll('.ant-tabs-tab')].find(t => t.textContent.includes('工具'))?.click()`)
  await wait(500)
  const toolsText = await evalJs(`[...document.querySelectorAll('.ant-tabs-tabpane-active')][0]?.textContent ?? ''`)
  console.log('tools pane:', JSON.stringify(toolsText.slice(0, 120)))

  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
  if (shot.result?.data) {
    await import('node:fs').then(({ writeFileSync, mkdirSync }) => {
      mkdirSync(join(APP_ROOT, 'scripts', 'wide_shots'), { recursive: true })
      writeFileSync(
        join(APP_ROOT, 'scripts', 'wide_shots', 't18-tools-tab.png'),
        Buffer.from(shot.result.data, 'base64'),
      )
    })
    console.log('shot saved t18-tools-tab.png')
  }

  proc.kill()
  process.exit(0)
}
try {
  await main()
} catch (e) {
  console.error('ERROR', e)
  proc.kill()
  process.exit(1)
}
