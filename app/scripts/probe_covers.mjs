// 封面链路实证探针：起应用（真实数据目录）→ CDP 读渲染层实际状态。
// 判定 (A) hh:// 协议运行时失败 还是 (B) 协议通但图片本身是废图。
// 用法：node scripts/probe_covers.mjs
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const APP_ROOT = process.cwd()
const PORT = '9341'

const exe = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
// Electron 44 不再接受 --disable-gpu 作为命令行开关（bad option 会直接拒启动）
const env = { ...process.env, HANEHANA_DEBUG_PORT: PORT }
// 上层若导出 ELECTRON_RUN_AS_NODE，electron.exe 会退化成纯 Node 跑主进程，
// 一启动就因拿不到 BrowserWindow 而崩。显式清掉，保证以 Electron 模式起。
delete env.ELECTRON_RUN_AS_NODE
const proc = spawn(exe, ['.'], {
  cwd: APP_ROOT,
  // 不设 HANEHANA_DATA_DIR：用真实数据目录，才能看到用户实际看到的封面
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
let stderr = ''
proc.stderr.on('data', (d) => {
  stderr += d.toString()
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getWsUrl() {
  for (let i = 0; i < 80; i++) {
    const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)
    if (m) return m[1]
    await sleep(500)
  }
  throw new Error('no DevTools line: ' + stderr.slice(0, 1200))
}

try {
  const wsUrl = await getWsUrl()
  await sleep(3000)
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('ws open timeout')), 10000)
    ws.onopen = () => {
      clearTimeout(to)
      res()
    }
    ws.onerror = (e) => {
      clearTimeout(to)
      rej(new Error('ws error ' + (e?.message || '')))
    }
  })

  let msgId = 0
  const pending = new Map()
  const consoleErrs = []
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
    // 收集渲染层控制台错误与未捕获异常
    if (m.method === 'Runtime.consoleAPICalled' && (m.params?.type === 'error' || m.params?.type === 'warning')) {
      consoleErrs.push(
        `[${m.params.type}] ` +
          (m.params.args || [])
            .map((a) => a.value ?? a.description ?? '')
            .join(' ')
            .slice(0, 300),
      )
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrs.push('[exception] ' + String(m.params?.exceptionDetails?.exception?.description ?? '').slice(0, 300))
    }
    if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') {
      consoleErrs.push('[log] ' + String(m.params.entry.text).slice(0, 300))
    }
  }

  let sessionId = null
  const sendRaw = (method, params = {}) =>
    new Promise((res, rej) => {
      const mid = ++msgId
      pending.set(mid, res)
      if (sessionId) {
        ws.send(JSON.stringify({ id: mid, method, params, sessionId }))
      } else {
        ws.send(JSON.stringify({ id: mid, method, params }))
      }
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
  const send = (m, p = {}) => sendRaw(m, p)

  await send('Runtime.enable').catch(() => {})
  await send('Log.enable').catch(() => {})
  await send('Page.enable').catch(() => {})

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails)
      return { __err: String(r.result?.exceptionDetails.exception?.description ?? 'eval failed') }
    return r.result?.result?.value
  }

  // 回到库页（封面卡所在）
  await evalJs(`(() => {
    const lib = [...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('全部游戏'))
    if (lib) lib.click()
  })()`)
  for (let i = 0; i < 40; i++) {
    const n = await evalJs(`document.querySelectorAll('.cover-card').length`)
    if (typeof n === 'number' && n > 0) break
    await sleep(250)
  }

  // 1) 渲染层看到的游戏数据
  const games = await evalJs(`(async () => {
    try {
      const g = await window.hh.listGames()
      return g.map(x => ({ id: x.id, title: x.title, coverPath: x.coverPath || '', thumbPath: x.thumbPath || '', color: x.color || '' }))
    } catch (e) { return { __err: String(e) } }
  })()`)

  // 2) 逐个测 hh:// 协议：直接 fetch 状态码
  const fetchProbe = await evalJs(`(async () => {
    const g = await window.hh.listGames()
    const out = []
    for (const x of g) {
      const row = { id: x.id.slice(0,8), hasThumbPath: !!x.thumbPath, hasCoverPath: !!x.coverPath }
      for (const kind of ['thumb','cover']) {
        const u = 'hh://' + kind + '/' + x.id
        try {
          const r = await fetch(u)
          row[kind + 'Status'] = r.status
          row[kind + 'Ct'] = (r.headers.get('content-type') || '')
          row[kind + 'Len'] = Number(r.headers.get('content-length') || 0)
        } catch (e) { row[kind + 'Err'] = String(e).slice(0,200) }
      }
      out.push(row)
    }
    // 不存在的 id 应当 404
    try { const r = await fetch('hh://thumb/does-not-exist'); out.push({ missing404: r.status }) }
    catch (e) { out.push({ missing404Err: String(e) }) }
    return out
  })()`)

  // 3) 真实 <img> 元素的加载结果（naturalWidth=0 → 破图）
  const domImgs = await evalJs(`(async () => {
    const imgs = [...document.querySelectorAll('.cover-card img')]
    const out = []
    for (const img of imgs.slice(0, 12)) {
      out.push({
        src: (img.getAttribute('src')||'').slice(0,60),
        complete: img.complete,
        naturalW: img.naturalWidth,
        naturalH: img.naturalHeight,
        display: getComputedStyle(img).display,
      })
    }
    return { total: imgs.length, sample: out }
  })()`)

  // 4) 用干净 Image 再测一次（排除 DOM 缓存/时序影响）
  const imageProbe = await evalJs(`(async () => {
    const g = await window.hh.listGames()
    const out = []
    for (const x of g) {
      const r = await new Promise((res) => {
        const im = new Image()
        const to = setTimeout(() => res({ id: x.id.slice(0,8), timeout: true }), 5000)
        im.onload = () => { clearTimeout(to); res({ id: x.id.slice(0,8), ok: true, w: im.naturalWidth, h: im.naturalHeight }) }
        im.onerror = () => { clearTimeout(to); res({ id: x.id.slice(0,8), ok: false, w: 0 }) }
        im.src = 'hh://thumb/' + x.id
      })
      out.push(r)
    }
    return out
  })()`)

  await sleep(800)

  // 5) 截图为证：封面墙肉眼验收（黑条 bug 一眼可辨）
  let shotPath = ''
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    if (shot.result?.data) {
      const { writeFileSync } = await import('node:fs')
      shotPath = join(APP_ROOT, 'scripts', 'out', 'cover_probe.png')
      const { mkdirSync } = await import('node:fs')
      mkdirSync(join(APP_ROOT, 'scripts', 'out'), { recursive: true })
      writeFileSync(shotPath, Buffer.from(shot.result.data, 'base64'))
    }
  } catch (e) {
    console.log('[screenshot failed]', String(e).slice(0, 200))
  }

  console.log('=== 渲染层游戏数据 ===')
  console.log(JSON.stringify(games, null, 1))
  console.log('=== hh:// 协议 fetch 状态 ===')
  console.log(JSON.stringify(fetchProbe, null, 1))
  console.log('=== DOM 中真实 img ===')
  console.log(JSON.stringify(domImgs, null, 1))
  console.log('=== 干净 Image 加载测试 ===')
  console.log(JSON.stringify(imageProbe, null, 1))
  console.log('=== 截图 ===', shotPath || '(未取得)')
  console.log('=== 控制台错误 ===')
  console.log(consoleErrs.length ? consoleErrs.join('\n') : '(无)')

  ws.close()
} catch (e) {
  console.error('PROBE FAIL:', e.message)
  console.error('stderr tail:', stderr.slice(-800))
  process.exitCode = 1
} finally {
  proc.kill()
}
