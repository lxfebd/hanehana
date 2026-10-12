// R8 批次验收：P2-2 DialogShell 统一弹层 + P2-4 main/index.ts 按域拆 ipc/*
// 用法：node scripts/accept_batch22.mjs   （须先 npm run build）
//  - 静态：渲染层 <Modal = 0；8 个弹层文件接 DialogShell；Modal.confirm 保留
//  - 静态：ipc/* 九域注册齐 + wireIpc 只组装；index.ts 死 helper 已清
//  - 运行时：Hello / GameList / SettingsGet 通；TasksAdd 非法 url 返 err 形
//  - 运行时：设置弹层 .ds-mask 可开可关（DialogShell Esc）
import { mkdirSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname, relative } from 'node:path'
import { spawn } from 'node:child_process'

const here = join(process.cwd(), 'scripts')
const APP_ROOT = process.cwd()
const PORT = '9278'
const DATA_DIR = join(APP_ROOT, '.batch22-data')
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })

const seed = spawn(process.execPath, [join(here, 'seed_layout.mjs'), DATA_DIR], {
  stdio: ['ignore', 'inherit', 'inherit'],
})
await new Promise((r) => seed.on('exit', r))
if (seed.exitCode !== 0) throw new Error('seed_layout failed')

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

function walkVue(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walkVue(p, out)
    else if (extname(p) === '.vue') out.push(p)
  }
  return out
}

// ---- 静态：P2-2 DialogShell ----
{
  const renderRoot = join(APP_ROOT, 'src/renderer')
  const files = walkVue(renderRoot)
  const modalOpenHits = []
  for (const file of files) {
    const rel = relative(APP_ROOT, file).replace(/\\/g, '/')
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, i) => {
      if (/<Modal\b/.test(line)) modalOpenHits.push(`${rel}:${i + 1}`)
    })
  }
  assert('渲染层模板 <Modal = 0', modalOpenHits.length === 0, modalOpenHits.join(', '))

  const dialogFiles = [
    'src/renderer/components/ScanDialog.vue',
    'src/renderer/components/AddGameDialog.vue',
    'src/renderer/components/EditDialog.vue',
    'src/renderer/components/ScrapeDialog.vue',
    'src/renderer/components/BackupDialog.vue',
    'src/renderer/components/SteamImportDialog.vue',
    'src/renderer/App.vue',
  ]
  const missing = []
  for (const rel of dialogFiles) {
    const src = readFileSync(join(APP_ROOT, rel), 'utf8')
    if (!src.includes('DialogShell')) missing.push(rel)
  }
  assert('8 处弹层均接 DialogShell', missing.length === 0, missing.join(', '))

  // App.vue 内应有两处 DialogShell（Settings + NewDownload）
  const appSrc = readFileSync(join(APP_ROOT, 'src/renderer/App.vue'), 'utf8')
  const shellOpens = (appSrc.match(/<DialogShell\b/g) || []).length
  assert('App.vue 两处 DialogShell', shellOpens === 2, String(shellOpens))

  // Modal.confirm 是确认流，不是裸壳——必须保留
  const bak = readFileSync(join(APP_ROOT, 'src/renderer/components/BackupDialog.vue'), 'utf8')
  const dl = readFileSync(join(APP_ROOT, 'src/renderer/components/DownloadView.vue'), 'utf8')
  assert('BackupDialog 保留 Modal.confirm', /Modal\.confirm\s*\(/.test(bak))
  assert('DownloadView 保留 Modal.confirm', /Modal\.confirm\s*\(/.test(dl))

  const shell = readFileSync(join(APP_ROOT, 'src/renderer/components/DialogShell.vue'), 'utf8')
  assert('DialogShell 存在 role=dialog', shell.includes('role="dialog"'))
  assert('DialogShell 无裸 hex', !/#[0-9a-fA-F]{3,8}\b/.test(shell))
}

// ---- 静态：P2-4 IPC 拆分 ----
{
  const ipcDir = join(APP_ROOT, 'src/main/ipc')
  const domains = ['shared', 'games', 'tasks', 'backup', 'scan', 'steam', 'scrape', 'stats', 'win', 'settings']
  const missingFiles = domains.filter((d) => !statSync(join(ipcDir, `${d}.ts`), { throwIfNoEntry: false }))
  assert('ipc/* 十文件齐（含 shared）', missingFiles.length === 0, missingFiles.join(', '))

  const indexSrc = readFileSync(join(APP_ROOT, 'src/main/index.ts'), 'utf8')
  const registers = [
    'registerSettingsHandlers',
    'registerWinHandlers',
    'registerScanHandlers',
    'registerSteamHandlers',
    'registerBackupHandlers',
    'registerGamesHandlers',
    'registerScrapeHandlers',
    'registerTasksHandlers',
    'registerStatsHandlers',
  ]
  const missingReg = registers.filter((r) => !indexSrc.includes(r))
  assert('wireIpc 组装九域 register*', missingReg.length === 0, missingReg.join(', '))

  // 死 helper 已随迁移清出 index.ts
  for (const dead of ['DOWNLOAD_URL_RE', 'TASK_ACTIONS', 'gamesToCsv', 'isDestAllowed', 'function isId(']) {
    assert(`index.ts 无 ${dead}`, !indexSrc.includes(dead))
  }
  assert('index.ts 不再直接 ipcMain.handle', !/ipcMain\.handle\s*\(/.test(indexSrc))
  assert('index.ts 仍导出 wireIpc 组装注释', indexSrc.includes('function wireIpc'))

  // 通道名仍走 Ipc 枚举，禁止 ipc/*.ts 里出现字符串字面量通道
  const ipcFiles = readdirSync(ipcDir).filter((f) => f.endsWith('.ts'))
  const literalHits = []
  for (const f of ipcFiles) {
    const src = readFileSync(join(ipcDir, f), 'utf8')
    // 形如 ipcMain.handle('xxx'  —— 必须走 Ipc.X
    if (/ipcMain\.handle\(\s*['"`]/.test(src)) literalHits.push(f)
    if (!src.includes('Ipc.') && f !== 'shared.ts') literalHits.push(f + ':no-Ipc')
  }
  assert('ipc/* 通道全走 Ipc 枚举', literalHits.length === 0, literalHits.join(', '))

  // 通道名未改：shared/ipc.ts 的键集合未被本批修改 —— 抽查关键键仍在
  const sharedIpc = readFileSync(join(APP_ROOT, 'src/shared/ipc.ts'), 'utf8')
  for (const key of ['Hello', 'GameList', 'TasksAdd', 'SettingsGet', 'BackupDelete', 'FullscreenSet']) {
    assert(
      `Ipc.${key} 通道名仍在`,
      new RegExp(`\\b${key}\\s*:`).test(sharedIpc) || sharedIpc.includes(`${key} =`) || sharedIpc.includes(`${key}:`),
    )
  }
}

// ---- 运行时 CDP ----
const exe = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
// Electron 44 不接受 --disable-gpu；ELECTRON_RUN_AS_NODE 继承会让 electron 走 node 模式
const env = { ...process.env, HANEHANA_DEBUG_PORT: String(PORT), HANEHANA_DATA_DIR: DATA_DIR }
delete env.ELECTRON_RUN_AS_NODE
const proc = spawn(exe, ['.'], {
  cwd: APP_ROOT,
  env,
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

async function main() {
  const wsUrl = await getWsUrl()
  await new Promise((r) => setTimeout(r, 3000))
  const port = (wsUrl.match(/:(\d+)\//) || [])[1]
  let pageJson = null
  let lastJson = ''
  for (let i = 0; i < 20 && !pageJson; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      lastJson = JSON.stringify(list.map((t) => ({ type: t.type, url: t.url })))
      pageJson = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
    } catch (e) {
      lastJson = 'fetch fail: ' + e
    }
    if (!pageJson) await new Promise((r) => setTimeout(r, 500))
  }
  if (!pageJson) throw new Error('no page target via /json | ' + lastJson)
  const ws = await connectWs(pageJson.webSocketDebuggerUrl)
  let msgId = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const sendRaw = (method, params = {}) =>
    new Promise((res, rej) => {
      const mid = ++msgId
      pending.set(mid, res)
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }))
      setTimeout(() => {
        if (pending.has(mid)) {
          pending.delete(mid)
          rej(new Error('cdp timeout: ' + method))
        }
      }, 15000)
    })
  const send = (method, params = {}) => sendRaw(method, params)
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails)
      return { __err: String(r.result.exceptionDetails.exception?.description ?? 'eval failed') }
    return r.result?.result?.value
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  try {
    await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    await send('Page.bringToFront').catch(() => {})
    await send('Page.reload', { ignoreCache: true })
    await wait(5000)

    const boot = await evalJs(`(() => ({
      hasHh: !!window.hh,
      coverCards: document.querySelectorAll('.cover-card').length,
      libCount: document.querySelector('.nav-item .count')?.textContent ?? '',
      tag: document.querySelector('.tag')?.textContent ?? '',
    }))()`)
    console.log('BOOT:', JSON.stringify(boot))
    assert(
      '渲染层已挂载',
      boot?.hasHh === true && (boot?.tag || boot?.libCount || boot?.coverCards !== undefined),
      JSON.stringify(boot),
    )

    // P2-4 抽测：跨域 IPC 在拆分后仍通
    const hello = await evalJs(`window.hh.hello()`)
    console.log(
      'HELLO:',
      JSON.stringify(
        hello && { ok: hello.ok, keys: hello && typeof hello === 'object' ? Object.keys(hello).slice(0, 8) : hello },
      ),
    )
    assert('Hello 通道可用', hello && !hello.__err && hello.ok !== false, JSON.stringify(hello))

    const games = await evalJs(`window.hh.listGames()`)
    console.log('GAMES:', Array.isArray(games) ? `len=${games.length}` : JSON.stringify(games))
    assert(
      'GameList 返回数组',
      Array.isArray(games) && games.length >= 1,
      JSON.stringify(Array.isArray(games) ? games.length : games),
    )

    const settings = await evalJs(`window.hh.getSettings()`)
    console.log('SETTINGS:', settings && typeof settings === 'object' ? Object.keys(settings).slice(0, 6) : settings)
    assert(
      'SettingsGet 返回对象',
      settings && typeof settings === 'object' && !settings.__err && typeof settings.download_dir === 'string',
      JSON.stringify(
        settings && typeof settings === 'object'
          ? { download_dir: settings.download_dir, dark: settings.dark }
          : settings,
      ),
    )

    // 非法 dest/url：err 形状（TasksAdd 在 ipc/tasks）
    const addBad = await evalJs(`window.hh.addTask({ url: 'not-a-url', dest: '', threads: 2 })`)
    console.log('ADD_BAD:', JSON.stringify(addBad))
    assert(
      'TasksAdd 非法 url 返 {ok:false,error}',
      addBad && addBad.ok === false && typeof addBad.error === 'string',
      JSON.stringify(addBad),
    )

    // GameScan 非法 root：err 形状（在 ipc/scan）
    const scanBad = await evalJs(`window.hh.scanDir('')`)
    console.log('SCAN_BAD:', JSON.stringify(scanBad))
    assert(
      'GameScan 空串返 {ok:false,error}',
      scanBad && scanBad.ok === false && typeof scanBad.error === 'string',
      JSON.stringify(scanBad),
    )

    // DialogShell：打开设置 → .ds-mask → Esc 关
    await evalJs(`(() => {
      const btn = [...document.querySelectorAll('.sidebar .nav-item')].find(b => (b.textContent || '').includes('设置'))
      btn?.click()
      return !!btn
    })()`)
    await wait(600)
    const maskOpen = await evalJs(`(() => ({
      hasMask: !!document.querySelector('.ds-mask'),
      hasPanel: !!document.querySelector('.ds-panel[role="dialog"]'),
      title: document.querySelector('.ds-title')?.textContent?.trim() ?? '',
    }))()`)
    console.log('DS_OPEN:', JSON.stringify(maskOpen))
    assert(
      '设置弹层走 DialogShell(.ds-mask)',
      maskOpen?.hasMask === true && maskOpen?.hasPanel === true,
      JSON.stringify(maskOpen),
    )
    assert(
      'DialogShell 标题为偏好设置',
      String(maskOpen?.title || '').includes('偏好设置') || String(maskOpen?.title || '').includes('设置'),
      JSON.stringify(maskOpen),
    )

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
    await wait(400)
    const maskClosed = await evalJs(`(() => ({ hasMask: !!document.querySelector('.ds-mask') }))()`)
    console.log('DS_ESC:', JSON.stringify(maskClosed))
    assert('Esc 关闭 DialogShell', maskClosed?.hasMask === false, JSON.stringify(maskClosed))
  } finally {
    console.log(`\n==== ${passed} passed, ${failed} failed ====`)
    ws.close()
    proc.kill()
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  console.error('--- stderr tail ---')
  console.error(stderr.slice(-2000))
  try {
    proc.kill()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
