// T16 截图：全屏模式视觉效果（dpr=1 强制，验收工具链口径）
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const here = join(process.cwd(), 'scripts')
const APP_ROOT = process.cwd()
const PORT = '9261'
const DATA_DIR = join(APP_ROOT, '.batch5-shot-data')
const OUT = join(APP_ROOT, '.shots')
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(OUT, { recursive: true })

const seed = spawn(process.execPath, [join(here, 'seed_layout.mjs'), DATA_DIR], { stdio: ['ignore', 'inherit', 'inherit'] })
await new Promise((res) => seed.on('exit', res))

const exe = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const proc = spawn(exe, ['--disable-gpu', '.'], {
  cwd: APP_ROOT,
  env: { ...process.env, HANEHANA_DEBUG_PORT: String(PORT), HANEHANA_DATA_DIR: DATA_DIR, HANEHANA_NO_OS_FULLSCREEN: '1' },
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

async function main() {
  const wsUrl = await getWsUrl()
  await new Promise((r) => setTimeout(r, 2500))
  const ws = await connectWs(wsUrl)
  let msgId = 0
  const pending = new Map()
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  let sessionId = null
  const sendRaw = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++msgId
    pending.set(mid, res)
    const msg = { id: mid, method, params }
    if (sessionId) msg.sessionId = sessionId
    ws.send(JSON.stringify(msg))
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('cdp timeout: ' + method)) } }, 12000)
  })
  const targets = await sendRaw('Target.getTargets')
  const page = (targets.result?.targetInfos || []).find((t) => t.type === 'page')
  const att = await sendRaw('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  sessionId = att.result?.sessionId
  const send = (method, params = {}) => sendRaw(method, params)
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.exception?.description ?? 'eval failed') }
    return r.result?.result?.value
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  // dpr=1 强制：进入全屏前不要锁视口尺寸（会与全屏真实尺寸冲突导致重影）。
  // 截图前按真实尺寸重设（见 shot()）。
  await send('Page.bringToFront').catch(() => {})
  await wait(800)

  // 进入全屏
  await evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('全屏模式'))?.click()`)
  await wait(1000)
  const fsRoot = await evalJs(`!!document.querySelector('.fs-root')`)
  if (!fsRoot) throw new Error('fs-root not found')
  // 点亮操作条
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640, y: 400 })
  await wait(300)

  const shot = async (name) => {
    // CDP captureScreenshot 在 --disable-gpu + dpr 1.5 下对 position:fixed 全屏覆盖层
    // 产出错位重影（probe 已证 DOM/命中/层级正确）——换系统级截屏拿真实合成帧。
    await wait(400)
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
      '$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
      '$bmp = [System.Drawing.Bitmap]::new($b.Width, $b.Height)',
      '$gfx = [System.Drawing.Graphics]::FromImage($bmp)',
      '$gfx.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)',
      `$bmp.Save('${join(OUT, name).replace(/\\/g, '/')}', [System.Drawing.Imaging.ImageFormat]::Png)`,
      '$gfx.Dispose(); $bmp.Dispose()',
      'Write-Output ("ok " + $b.Width + "x" + $b.Height)',
    ].join('\n')
    await new Promise((resolve, reject) => {
      const p = spawn('powershell', ['-NoProfile', '-Command', ps], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      p.stdout.on('data', (d) => { out += d })
      p.stderr.on('data', (d) => { out += 'ERR:' + d })
      p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error('ps exit ' + code + ' ' + out.slice(0, 300)))))
    }).then((msg) => console.log('shot', name, msg), (e) => { throw e })
  }
  await shot('fullscreen-dark.png')
  console.log('done')
  proc.kill()
  process.exit(0)
}
main().catch((e) => { console.error('ERROR', e); proc.kill(); process.exit(1) })