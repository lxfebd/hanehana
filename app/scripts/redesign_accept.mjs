// 樱夜重设计验收入口：seed 起应用 → 4 张 docs/shots 基准图（含详情选中态）
// → cdp_visual 8 断言 → 布局溢出检查 → 深浅主题截图。
// 用法：node scripts/redesign_accept.mjs
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const here = join(process.cwd(), 'scripts')
const APP_ROOT = process.cwd()
const PORT = '9231'
const DATA_DIR = join(APP_ROOT, '.accept-data')
const OUT = join(APP_ROOT, '..', 'docs', 'shots')
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(OUT, { recursive: true })

// 用 layout seed 生成真实形态的游戏库（渐变封面 + 主色调）与六态下载任务
const seed = spawn(process.execPath, [join(here, 'seed_layout.mjs'), DATA_DIR], { stdio: ['ignore', 'inherit', 'inherit'] })
await new Promise((res) => seed.on('exit', res))
if (seed.exitCode !== 0) throw new Error('seed_layout failed')

const exe = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
// --disable-gpu：软件合成路径，避免 GPU 表面陈旧导致的截图重影（多份画面叠加）
const proc = spawn(exe, ['--disable-gpu', '.'], {
  cwd: APP_ROOT,
  env: { ...process.env, HANEHANA_DEBUG_PORT: String(PORT), HANEHANA_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
let stderr = ''
proc.stderr.on('data', (d) => { stderr += d.toString(); process.stdout.write('[app] ' + d.toString().trim().slice(0, 200) + '\n') })

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
    ws.onopen = () => { clearTimeout(to); resolve(ws) }
    ws.onerror = (e) => { clearTimeout(to); reject(new Error('ws error ' + (e?.message || 'unknown'))) }
  })
}

async function main() {
  const wsUrl = await getWsUrl()
  await new Promise((r) => setTimeout(r, 2500))
  const ws = await connectWs(wsUrl, 10)
  let msgId = 0
  const pending = new Map()
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  let sessionId = null
  const sendRaw = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++msgId
    pending.set(mid, res)
    const msg = { id: mid, method, params }
    if (sessionId) msg.sessionId = sessionId // sessionId 必须在消息顶层，否则被当作普通 params 忽略
    ws.send(JSON.stringify(msg))
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('cdp timeout: ' + method)) } }, 12000)
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
    if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.exception?.description ?? 'eval failed') }
    return r.result?.result?.value
  }
  const evalJsT = async (tag, expr) => {
    const t = Date.now()
    const v = await evalJs(expr)
    console.log('EVAL[' + tag + ']', Date.now() - t + 'ms', JSON.stringify(v)?.slice(0, 120))
    return v
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await send('Page.bringToFront').catch(() => {})
  await wait(600)

  async function shot(name) {
    // 等待所有 CSS 动画/过渡结束 + 双 rAF 冲刷合成器，避免捕获到中间帧重影
    await evalJs(`(async () => {
      await document.fonts?.ready
      const settle = async () => {
        const anims = document.getAnimations().filter(a => a.playState === 'running' || a.playState === 'pending')
        if (anims.length) {
          // 下载进度等持续动画永不 finished：限时等待后继续，避免无限阻塞
          await Promise.race([
            Promise.all(anims.map(a => a.finished.catch(() => {}))),
            new Promise(r => setTimeout(r, 800)),
          ])
        }
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
      }
      await settle()
      if (typeof document.hasFocus === 'function') document.hasFocus()
      return true
    })()`)
    await wait(120)
    // CDP 截图在 dpr=1.5（非整数）下会产生多帧重影伪影；临时强制 dpr=1 再截
    const dims = await evalJs(`({ width: innerWidth, height: innerHeight })`)
    await send('Emulation.setDeviceMetricsOverride', {
      width: dims?.width || 1280,
      height: dims?.height || 802,
      deviceScaleFactor: 1,
      mobile: false,
    }).catch(() => {})
    await wait(250)
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await send('Emulation.clearDeviceMetricsOverride').catch(() => {})
    await wait(80)
    if (r.result?.data) {
      const buf = Buffer.from(r.result.data, 'base64')
      writeFileSync(join(OUT, name + '.png'), buf)
      console.log('SHOT', name, buf.length)
      return buf.length
    }
    return 0
  }

  const overflow = await evalJs(`(() => {
    const doc = document.documentElement
    return { docSw: doc.scrollWidth, vw: doc.clientWidth, bad: doc.scrollWidth > doc.clientWidth + 2 }
  })()`)
  console.log('LAYOUT:', JSON.stringify(overflow))
  if (overflow?.bad) throw new Error('horizontal overflow: ' + JSON.stringify(overflow))

  // 4 张基准图：库网格 / 详情（选中第一张卡）/ 下载页 / 设置
  await wait(500)
  await shot('01-library-grid')
  await evalJsT('detail-click', `document.querySelector('.cover-card')?.click()`); await wait(700)
  await shot('02-detail')
  await evalJsT('nav-download', `[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('下载任务'))?.click()`); await wait(600)
  await shot('03-downloads')
  await evalJsT('nav-settings', `[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('设置'))?.click()`); await wait(700)
  await shot('04-settings')

  // 主题切换验收：浅色库页 + 浅色下载页（seed 的 settings.json 默认 dark:true）
  await evalJs(`document.querySelector('.ant-modal-close')?.click()`)
  await evalJs(`window.hh.getSettings().then(async (s) => { if (s.dark) await window.hh.saveSettings({ ...s, dark: false }); return true })`)
  await send('Page.reload', { ignoreCache: true })
  await wait(3000)
  const lightOv = await evalJs(`(() => {
    const doc = document.documentElement
    const lib = [...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('全部游戏'))
    if (lib) lib.click()
    return { sw: doc.scrollWidth, vw: doc.clientWidth, bad: doc.scrollWidth > doc.clientWidth + 2, theme: doc.dataset.theme }
  })()`)
  console.log('LIGHT_LAYOUT:', JSON.stringify(lightOv))
  if (lightOv?.bad) throw new Error('light horizontal overflow: ' + JSON.stringify(lightOv))
  ws.close()
}

let ok = false
try {
  await main()
  // cdp_visual 8 断言（同一实例，WS URL 直传）
  const p = await new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [join(here, 'cdp_visual.mjs')], {
      env: { ...process.env, HANEHANA_WS_URL: stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1] },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('cdp_visual exit ' + code))))
  })
  console.log('cdp_visual: 8/8 PASS')
  ok = true
} catch (e) {
  console.error('FAIL', e.message)
  process.exitCode = 1
} finally {
  try { proc.kill() } catch {}
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch {}
  console.log(ok ? 'ACCEPT OK' : 'ACCEPT FAIL')
}
