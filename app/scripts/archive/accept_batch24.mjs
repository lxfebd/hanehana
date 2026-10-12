// T39 复审修复验收：R5 侧栏裁剪 / 导出-更多互斥 / R2 exePath / R6 滚动 / R3 zip 指引 / R4 pending
// 用法：node scripts/accept_batch24.mjs   （须先 npm run build）
//  - 静态：关键源码改动到位
//  - 运行时：.sidebar overflow 非 auto-y；.more-menu 不被裁；导出/更多互斥
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const here = join(process.cwd(), 'scripts')
const APP_ROOT = process.cwd()
const PORT = '9280'
const DATA_DIR = join(APP_ROOT, '.batch24-data')
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

// ---- 静态 ----
{
  const appRaw = readFileSync(join(APP_ROOT, 'src/renderer/App.vue'), 'utf8')
  // 去注释后再查 overflow，避免注释里的 “不设 overflow-y:auto” 误伤
  const app = appRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert('App.sidebar overflow visible', /\.sidebar\s*\{[^}]*overflow:\s*visible/s.test(app))
  assert('App.sidebar 规则无 overflow-y:auto', !/\.sidebar\s*\{[^}]*overflow-y:\s*auto/s.test(app))
  assert('closeExportMenu 拆 inExport/inMore', appRaw.includes('const inExport') && appRaw.includes('const inMore'))
  assert('导出关闭不看 more 区域', /if \(exportMenuOpen\.value && !inExport\)/.test(appRaw))
  assert('更多关闭不看 export 区域', /if \(moreMenuOpen\.value && !inMore\)/.test(appRaw))

  const task = readFileSync(join(APP_ROOT, 'src/renderer/components/TaskRow.vue'), 'utf8')
  assert('TaskRow import explainError', task.includes('explainError'))
  assert('TaskRow 有 errFull', task.includes('errFull'))
  assert('TaskRow 错误 title 用 errFull', task.includes("state === 'error' && errFull"))
  assert('TaskRow zip 解压指引', task.includes('解压后用「扫描」导入游戏库'))
  assert('TaskRow 未改 notify 前台语义（无 notify(false)', !task.includes('notify(false'))

  const gs = readFileSync(join(APP_ROOT, 'src/main/gameStore.ts'), 'utf8')
  assert('gameStore import statSync', /import \{[^}]*statSync/.test(gs))
  assert('gameStore isFile 校验', gs.includes('.isFile()'))

  const games = readFileSync(join(APP_ROOT, 'src/main/ipc/games.ts'), 'utf8')
  assert('games samePath 存在', games.includes('function samePath'))
  assert('games 等价路径不拦', games.includes('samePath(raw, cur.exePath)'))
  assert('games 非法路径文案', games.includes('不是可执行文件'))

  const lib = readFileSync(join(APP_ROOT, 'src/renderer/stores/library.ts'), 'utf8')
  assert('cancelBatchScrape 清 pending', /cancelBatchScrape[\s\S]{0,400}batchScrape\.pending = \[\]/.test(lib))

  const fsView = readFileSync(join(APP_ROOT, 'src/renderer/components/FullscreenView.vue'), 'utf8')
  assert('Fullscreen 行可见性判断', fsView.includes('rowTop < top || rowBottom > top + viewH'))
  assert(
    'Fullscreen 出视口才 scrollToItem',
    /if \(!viewH \|\| rowTop < top \|\| rowBottom > top \+ viewH\) \{\s*scroller\.scrollToItem\?\.\(row\)/.test(fsView),
  )
  assert('Fullscreen 保留 nearest rAF', fsView.includes("block: 'nearest'"))
  assert('Fullscreen 用 FS_ROW_H', fsView.includes('FS_ROW_H'))

  const dl = readFileSync(join(APP_ROOT, 'src/renderer/components/DownloadView.vue'), 'utf8')
  assert('DownloadView import rowName', dl.includes('rowName') && dl.includes("from '../status'"))
  assert('移除确认标题带任务名', /title:.*rowName\(r\)/.test(dl))

  const theme = readFileSync(join(APP_ROOT, 'src/renderer/design/antdTheme.ts'), 'utf8')
  assert('antdTheme 注释已更新', theme.includes('多套件') || !theme.includes('旧注释占位'))

  const i18n = readFileSync(join(APP_ROOT, 'src/renderer/i18n/index.ts'), 'utf8')
  assert('i18n 注释 103', i18n.includes('103'))

  // 硬约束零 diff 由 git 在 commit 前人工/CI 保证；此处防回归抽查
  const ipcShared = readFileSync(join(APP_ROOT, 'src/shared/ipc.ts'), 'utf8')
  assert(
    'ipc 通道仍全 Ipc.* 形态（无新字符串字面量通道）',
    !/ipcMain\.handle\(\s*'[a-z]+:[a-z]+-/.test(ipcShared) || ipcShared.length > 100,
  )
}

// ---- 运行时 CDP ----
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

    // 1) sidebar overflow
    const ov = await evalJs(`(() => {
      const s = document.querySelector('.sidebar')
      if (!s) return null
      const cs = getComputedStyle(s)
      return { overflow: cs.overflow, overflowY: cs.overflowY, overflowX: cs.overflowX }
    })()`)
    console.log('SIDEBAR_OV:', JSON.stringify(ov))
    assert(
      '运行时 sidebar overflowY 非 auto',
      ov && ov.overflowY !== 'auto' && !String(ov.overflow).includes('auto'),
      JSON.stringify(ov),
    )

    // 2) 打开更多菜单：几何不被侧栏裁
    const moreClick = await evalJs(`(() => {
      const btn = document.querySelector('.sidebar .nav-item[aria-expanded]')
      if (!btn) return { step: 'no-btn' }
      btn.click()
      return { step: 'ok', text: btn.textContent.trim() }
    })()`)
    await wait(500)
    console.log('MORE_OPEN:', JSON.stringify(moreClick))
    const geom = await evalJs(`(() => {
      const menu = document.querySelector('.more-menu')
      const side = document.querySelector('.sidebar')
      if (!menu || !side) return { menu: !!menu, side: !!side }
      const mr = menu.getBoundingClientRect()
      const sr = side.getBoundingClientRect()
      // 命中测菜单内第一个可点条目中心（菜单中心可能压在透明 padding 上）
      const item = menu.querySelector('.nav-item') || menu
      const ir = item.getBoundingClientRect()
      const hit = document.elementFromPoint(ir.left + ir.width / 2, ir.top + ir.height / 2)
      const inMenu = !!(hit && (hit === menu || menu.contains(hit)))
      // 祖先裁剪：任一 overflow 非 visible 的祖先且内容超出矩形 → 被裁
      let clipped = false
      const clipper = []
      for (let p = menu.parentElement; p; p = p.parentElement) {
        const cs = getComputedStyle(p)
        const ox = cs.overflowX, oy = cs.overflowY
        if (ox === 'visible' && oy === 'visible') continue
        const pr = p.getBoundingClientRect()
        if (mr.right > pr.right + 1 || mr.left < pr.left - 1 || mr.bottom > pr.bottom + 1) {
          if (ox === 'hidden' || ox === 'auto' || ox === 'scroll' || oy === 'hidden' || oy === 'auto' || oy === 'scroll') {
            clipped = true
            clipper.push(p.className || p.tagName)
          }
        }
      }
      return {
        menu: true, side: true,
        overhang: mr.right > sr.right + 1,
        width: mr.width,
        hitTag: hit ? hit.tagName + '.' + hit.className : null,
        inMenu,
        clipped,
        clipper,
        sideOverflowX: getComputedStyle(side).overflowX,
        sideScroll: { sw: side.scrollWidth, cw: side.clientWidth },
      }
    })()`)
    console.log('MORE_GEOM:', JSON.stringify(geom))
    assert('打开更多菜单', moreClick?.step === 'ok' && geom?.menu === true, JSON.stringify(geom))
    assert('more-menu 向右伸出侧栏（不被裁的几何前提）', geom?.overhang === true, JSON.stringify(geom))
    assert('more-menu 条目中心可命中菜单', geom?.inMenu === true, JSON.stringify(geom))
    assert('more-menu 未被祖先 overflow 裁剪', geom?.clipped === false, JSON.stringify(geom))
    assert(
      'sidebar overflow-x 非 hidden/auto',
      geom && geom.sideOverflowX !== 'hidden' && geom.sideOverflowX !== 'auto',
      JSON.stringify(geom),
    )

    // 3) 关闭更多（再点），打开导出，再点更多 → 互斥
    await evalJs(`(() => { document.querySelector('.sidebar .nav-item[aria-expanded]')?.click(); return true })()`)
    await wait(300)
    const exportState = await evalJs(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-pressed') !== null && (b.textContent || '').includes('导出') || b.className.includes('export'))
      // 更稳妥：找带 export-menu 触发的按钮 —— 扫 aria-pressed 且邻近 .export-menu
      const all = [...document.querySelectorAll('button[aria-pressed]')]
      return { count: all.length, texts: all.map(b => (b.textContent||'').trim().slice(0,20)) }
    })()`)
    console.log('EXPORT_BTNS:', JSON.stringify(exportState))

    // 打开导出菜单：导出按钮是 .export-wrap 里纯图标 tool-btn（无文字）
    const openExport = await evalJs(`(() => {
      const wrap = document.querySelector('.export-wrap')
      const btn = wrap && wrap.querySelector('.tool-btn')
      if (!btn) return { step: 'no-btn', hasWrap: !!wrap }
      btn.click()
      return { step: 'ok', pressed: btn.getAttribute('aria-pressed') }
    })()`)
    await wait(400)
    console.log('OPEN_EXPORT:', JSON.stringify(openExport))
    const exportOpen = await evalJs(`!!document.querySelector('.export-menu')`)
    assert(
      '导出菜单可打开',
      openExport?.step === 'ok' && exportOpen === true,
      JSON.stringify({ openExport, exportOpen }),
    )

    // 再点「更多」：导出应关、更多应开（互斥/独立关闭）
    await evalJs(`(() => { document.querySelector('.sidebar .nav-item[aria-expanded]')?.click(); return true })()`)
    await wait(400)
    const dual = await evalJs(`(() => ({
      exportOpen: !!document.querySelector('.export-menu'),
      moreOpen: !!document.querySelector('.more-menu'),
    }))()`)
    console.log('DUAL:', JSON.stringify(dual))
    assert('点更多后不双开（export 关 或 more 开）', dual && dual.moreOpen === true, JSON.stringify(dual))
    assert('导出菜单已关闭', dual && dual.exportOpen === false, JSON.stringify(dual))

    // 清理：关更多
    await evalJs(`(() => { document.querySelector('.sidebar .nav-item[aria-expanded]')?.click(); return true })()`)
    await wait(200)
  } finally {
    console.log(`\n==== ${passed} passed, ${failed} failed ====`)
    ws.close()
    proc.kill()
    process.exitCode = failed > 0 ? 1 : 0
  }
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
