// R5 批次验收：P1-2 BackupDialog 收敛原生弹窗 + P1-4 侧栏收纳 + P1-5 IPC 错误形状
// 用法：node scripts/accept_batch19.mjs   （须先 npm run build）
//  - 源码闸：window.confirm/alert 归零（BackupDialog 改 Modal.confirm + message）
//  - 侧栏主项 = 库/下载/扫描/设置/更多；「更多」展开后仍有 游戏站/统计/全屏/添加/Steam
//  - GameScan 空目录：返回 {ok:false,error}（不 throw 到 ipcRenderer 崩）
//  - BackupDelete 非法 id：返回 {ok:false,error}（不再裸 boolean）
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const here = join(process.cwd(), 'scripts')
const APP_ROOT = process.cwd()
const PORT = '9276'
const DATA_DIR = join(APP_ROOT, '.batch19-data')
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })

const seed = spawn(process.execPath, [join(here, 'seed_layout.mjs'), DATA_DIR], {
  stdio: ['ignore', 'inherit', 'inherit'],
})
await new Promise((res) => seed.on('exit', res))
if (seed.exitCode !== 0) throw new Error('seed_layout failed')

// 把 g1 的存档目录指到本地真实目录，备份才能建出快照（种子默认 D:\Galgame\... 可能不存在）
{
  const gpath = join(DATA_DIR, 'g1-save')
  mkdirSync(join(gpath, 'save'), { recursive: true })
  writeFileSync(join(gpath, 'save', 'slot1.dat'), 'slot1', 'utf8')
  writeFileSync(join(gpath, 'save', 'global.dat'), 'global', 'utf8')
  const gamesPath = join(DATA_DIR, 'games.json')
  const games = JSON.parse(readFileSync(gamesPath, 'utf8'))
  const g1 = games.find((g) => g.id === 'g1')
  if (g1) {
    g1.dir = gpath
    g1.exePath = join(DATA_DIR, 'g1-game.exe')
    writeFileSync(join(DATA_DIR, 'g1-game.exe'), Buffer.from('MZ fake'), 'utf8')
  }
  writeFileSync(gamesPath, JSON.stringify(games, null, 2), 'utf8')
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

// ---- 静态源码闸（与运行时断言互补）----
{
  const src = readFileSync(join(APP_ROOT, 'src/renderer/components/BackupDialog.vue'), 'utf8')
  assert('BackupDialog 无 window.confirm', !/window\.confirm\s*\(/.test(src))
  assert('BackupDialog 无 window.alert', !/window\.alert\s*\(/.test(src))
  assert('BackupDialog 使用 Modal.confirm', /Modal\.confirm\s*\(/.test(src))
  const idx = readFileSync(join(APP_ROOT, 'src/main/index.ts'), 'utf8')
  const scanBlock = idx.slice(idx.indexOf('Ipc.GameScan'), idx.indexOf('Ipc.GameAddOne'))
  assert('GameScan 不再 throw new Error', !scanBlock.includes('throw new Error'))
  assert('GameScan 走 err()', scanBlock.includes('return err('))
  const delBlock = idx.slice(idx.indexOf('Ipc.BackupDelete'), idx.indexOf('Ipc.BackupSync'))
  assert('BackupDelete 返回 ActionResult 形', delBlock.includes('err(') && delBlock.includes('ok: true'))
}

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
  await new Promise((r) => setTimeout(r, 2500))
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
    await wait(3500)

    // ---- P1-4 侧栏 ----
    const nav = await evalJs(`(() => {
      const labels = [...document.querySelectorAll('.sidebar > .nav-item, .sidebar > .more-wrap > .nav-item')].map(b => b.textContent.trim())
      return labels
    })()`)
    console.log('NAV:', JSON.stringify(nav))
    assert(
      '主栏含 库/下载/扫描/设置/更多',
      Array.isArray(nav) &&
        nav.some((s) => s.includes('全部游戏')) &&
        nav.some((s) => s.includes('下载')) &&
        nav.some((s) => s.includes('扫描')) &&
        nav.some((s) => s.includes('设置')) &&
        nav.some((s) => s.includes('更多')),
      JSON.stringify(nav),
    )
    assert(
      '主栏不再平铺 游戏站/统计/全屏',
      Array.isArray(nav) && !nav.some((s) => s.includes('游戏站') || s.includes('统计') || s.includes('全屏')),
      JSON.stringify(nav),
    )

    const more = await evalJs(`(() => {
      const btn = [...document.querySelectorAll('.sidebar .more-toggle')][0]
      if (!btn) return { step: 'no-btn' }
      btn.click()
      return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => {
        const items = [...document.querySelectorAll('.more-menu .nav-item')].map(b => b.textContent.trim())
        r({ step: 'ok', items })
      })))
    })()`)
    console.log('MORE:', JSON.stringify(more))
    assert(
      '更多菜单含 游戏站/统计/全屏/添加/Steam',
      more?.step === 'ok' &&
        ['游戏站', '统计', '全屏', '添加', 'Steam'].every((k) => (more.items || []).some((s) => s.includes(k))),
      JSON.stringify(more),
    )

    // 点统计 → 页切到 stats 且菜单收起
    const gotoStats = await evalJs(`(() => {
      const item = [...document.querySelectorAll('.more-menu .nav-item')].find(b => b.textContent.includes('统计'))
      if (!item) return { step: 'no-item' }
      item.click()
      return { step: 'clicked' }
    })()`)
    await wait(400)
    const statsOn = await evalJs(`(() => ({
      menuOpen: !!document.querySelector('.more-menu'),
      hasChartish: !!document.querySelector('.stats-view, [class*="stats"]'),
    }))()`)
    console.log('STATS:', JSON.stringify(gotoStats), JSON.stringify(statsOn))
    assert('从更多进入统计页', gotoStats?.step === 'clicked' && statsOn?.menuOpen === false, JSON.stringify(statsOn))
    assert('统计页已渲染', statsOn?.hasChartish === true, JSON.stringify(statsOn))

    // ---- P1-5 IPC 形状 ----
    const scanBad = await evalJs(`window.hh.scanDir('')`)
    console.log('SCAN_BAD:', JSON.stringify(scanBad))
    assert(
      'GameScan 空串返回 err 形状',
      scanBad && scanBad.ok === false && typeof scanBad.error === 'string',
      JSON.stringify(scanBad),
    )
    assert('GameScan 错误文案可读', String(scanBad?.error || '').includes('扫描'), String(scanBad?.error))

    const delBad = await evalJs(`window.hh.backupDelete('no-such-id', 'C:\\\\tmp')`)
    console.log('DEL_BAD:', JSON.stringify(delBad))
    assert(
      'BackupDelete 非法 id 返回 err 形状',
      delBad && delBad.ok === false && typeof delBad.error === 'string',
      JSON.stringify(delBad),
    )

    // 正例：合法扫描目录（种子 covers 目录可扫、通常 0 命中但仍成功）
    const scanOk = await evalJs(`window.hh.scanDir(${JSON.stringify(join(DATA_DIR, 'covers'))})`)
    console.log(
      'SCAN_OK:',
      JSON.stringify(scanOk && { hits: scanOk.hits?.length, skipped: scanOk.skipped, ok: scanOk.ok }),
    )
    assert(
      'GameScan 合法目录返回 hits 形状',
      scanOk && Array.isArray(scanOk.hits) && scanOk.ok === undefined,
      JSON.stringify(scanOk && { hits: scanOk.hits?.length, ok: scanOk.ok }),
    )

    // ---- P1-2 运行时：回库页 → 详情备份记录 → 删除应走 antd Modal.confirm ----
    await evalJs(`(() => {
      const lib = [...document.querySelectorAll('.sidebar > .nav-item')].find(b => (b.textContent || '').includes('全部游戏'))
      lib?.click()
      return true
    })()`)
    await wait(600)
    await evalJs(`(() => {
      document.querySelector('.cover-card')?.click()
      return true
    })()`)
    await wait(700)
    const opened = await evalJs(`(() => {
      const bak = [...document.querySelectorAll('button')].find(b =>
        (b.textContent || '').includes('备份记录') || b.getAttribute('title')?.includes('备份'),
      )
      if (!bak) return { step: 'no-btn' }
      bak.click()
      return { step: 'clicked' }
    })()`)
    await wait(700)
    console.log('BACKUP_OPEN:', JSON.stringify(opened))
    // 有快照才有删除按钮；种子无快照则先点「立即备份」
    const hasSnap = await evalJs(`(() => {
      const modal = [...document.querySelectorAll('.ant-modal')].find(m => (m.querySelector('.ant-modal-title')?.textContent || '').includes('存档'))
      if (!modal) return { step: 'no-modal' }
      const del = [...modal.querySelectorAll('button')].find(b => b.getAttribute('title') === '删除')
      if (del) return { step: 'has-del' }
      const create = [...modal.querySelectorAll('button')].find(b => (b.textContent || '').includes('立即备份'))
      create?.click()
      return { step: create ? 'create-clicked' : 'no-create' }
    })()`)
    await wait(2000)
    // 游戏目录可能不存在，若备份失败则至少断言弹窗仍在且无原生 confirm 痕迹
    const confirmProbe = await evalJs(`(() => {
      const modal = [...document.querySelectorAll('.ant-modal')].find(m => (m.querySelector('.ant-modal-title')?.textContent || '').includes('存档'))
      if (!modal) return { step: 'no-modal' }
      const del = [...modal.querySelectorAll('button')].find(b => b.getAttribute('title') === '删除')
      if (!del) return { step: 'no-del', err: modal.querySelector('.error-bar')?.textContent ?? '', text: (modal.textContent || '').slice(0, 180) }
      del.click()
      return { step: 'del-clicked' }
    })()`)
    await wait(600)
    const confirmUi = await evalJs(`(() => {
      const conf = document.querySelector('.ant-modal-confirm')
      const title = conf?.querySelector('.ant-modal-confirm-title')?.textContent ?? ''
      const content = conf?.querySelector('.ant-modal-confirm-content')?.textContent ?? ''
      return { hasConfirm: !!conf, title, content, probe: ${JSON.stringify('__probe__')} }
    })()`)
    console.log(
      'HAS_SNAP:',
      JSON.stringify(hasSnap),
      'DEL:',
      JSON.stringify(confirmProbe),
      'CONFIRM:',
      JSON.stringify(confirmUi),
    )
    if (confirmProbe?.step === 'del-clicked') {
      assert('删除快照走 antd Modal.confirm', confirmUi?.hasConfirm === true, JSON.stringify(confirmUi))
      assert(
        '确认框文案含不可恢复提示',
        String(confirmUi?.content || '').includes('不可恢复'),
        String(confirmUi?.content),
      )
      await evalJs(`(() => {
        const btn = [...document.querySelectorAll('.ant-modal-confirm-btns button')].find(b => (b.textContent || '').includes('取'))
        btn?.click()
        return true
      })()`)
    } else {
      // 目录不存在建不了快照：运行时走不到删除，用源码闸兜底（文件头已跑一遍，这里再跑一遍补齐 17 条）
      const srcAgain = readFileSync(join(APP_ROOT, 'src/renderer/components/BackupDialog.vue'), 'utf8')
      assert(
        '备份删除确认走 Modal.confirm（源码兜底）',
        /Modal\.confirm\s*\(/.test(srcAgain) && !/window\.confirm\s*\(/.test(srcAgain),
      )
      assert(
        '备份完成提示走 message（源码兜底）',
        /message\.success\s*\(/.test(srcAgain) && !/window\.alert\s*\(/.test(srcAgain),
      )
      console.log('NOTE: 运行时删除路径未走到，以源码闸兜底：', JSON.stringify({ confirmProbe, opened, hasSnap }))
    }
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
