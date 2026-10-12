// T18 验收：插件/工具集成系统（G2）
// 用法：node scripts/accept_batch7.mjs
//  - 种子：真实游戏目录（后台 pad 进程保持游戏"运行"）+ games.json
//  - 断言：
//    1. 设置页「工具」页签存在
//    2. preLaunchCmd 挂接：启动前命令执行（hook_marker 写 log）+ 占位符替换（{exe}/{dir}）
//    3. postLaunchCmd 挂接：启动后命令执行（hook_marker 写 log）
//    4. LE 找不到时报错（useLE 且未配置路径）
//    5. LE 路径配置后启动链正常（LEProc 用 hook_marker 顶替验证包装参数）
//    6. Magpie 路径配置后拉起（Magpie 用 hook_marker 顶替验证 --launch 参数）
//    7. 编辑对话框可以保存挂接命令
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const here = join(process.cwd(), 'scripts')
const APP_ROOT = process.cwd()
const PORT = '9263'
const DATA_DIR = join(APP_ROOT, '.batch7-data')
const GAME_DIR = join(APP_ROOT, '.batch7-game')
rmSync(DATA_DIR, { recursive: true, force: true })
rmSync(GAME_DIR, { recursive: true, force: true })
mkdirSync(join(DATA_DIR, 'covers'), { recursive: true })
mkdirSync(GAME_DIR, { recursive: true })

// 游戏本体：cmd 启动后挂约 5s（模拟游戏运行，短到不拖慢验收）
const padScript = join(GAME_DIR, 'pad.bat')
writeFileSync(padScript, '@echo off\r\nping -n 5 127.0.0.1 > nul\r\n', 'utf8')
const padExe = 'C:\\Windows\\System32\\cmd.exe'
// 挂接命令标记脚本（hook_marker.js）
const marker = join(here, 'hook_marker.js')
const nodeExe = process.execPath
const hookLogPre = join(DATA_DIR, 'hook-pre.json')
const hookLogPost = join(DATA_DIR, 'hook-post.json')

const now = Date.now()
const games = [
  {
    id: 'g1',
    dir: GAME_DIR,
    exePath: padExe,
    rawTitle: 'Hook Game',
    title: '挂接测试游戏',
    coverPath: '',
    releaseDate: '2020-01-01',
    rating: 8.0,
    tags: ['测试'],
    categories: [],
    sources: [],
    playMs: 0,
    useLE: false,
    useMagpie: false,
    addedAt: now,
    favorite: false,
    preLaunchCmd: `"${nodeExe}" "${marker}" "${hookLogPre}" {exe} {dir}`,
    postLaunchCmd: `"${nodeExe}" "${marker}" "${hookLogPost}" after`,
  },
]
writeFileSync(join(DATA_DIR, 'games.json'), JSON.stringify(games, null, 2), 'utf8')

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
function readJsonSafe(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
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

  // ---- 1. 设置页「工具」页签存在
  await evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('设置'))?.click()`)
  await wait(500)
  const toolsTab = await evalJs(
    `[...document.querySelectorAll('.ant-tabs-tab')].some(t => t.textContent.includes('工具'))`,
  )
  assert('设置页有「工具」页签', toolsTab === true)

  // ---- 2. 启动 g1：preLaunchCmd 应执行并在 {exe} 占位符处填入 cmd.exe
  const launchR = await evalJs(
    `(async () => { const r = await window.hh.launchGame('g1'); return { ok: r?.ok, err: r?.error } })()`,
  )
  assert('启动 g1 返回 ok', launchR.ok === true, JSON.stringify(launchR))
  await wait(1500)
  const preLog = readJsonSafe(hookLogPre)
  console.log('DEBUG preLog', JSON.stringify(preLog))
  assert('preLaunchCmd 已执行', !!preLog, 'log=' + JSON.stringify(preLog))
  assert(
    'preLaunchCmd 占位符 {exe} 替换正确',
    !!preLog && preLog.args.includes(padExe),
    'args=' + JSON.stringify(preLog?.args),
  )
  assert(
    'preLaunchCmd 占位符 {dir} 替换正确',
    !!preLog && preLog.args.includes(GAME_DIR),
    'args=' + JSON.stringify(preLog?.args),
  )
  // hook_marker 收到的 args = process.argv.slice(3)，即从 {exe} {dir} 开始的剩余参数
  assert(
    'preLaunchCmd 参数顺序：{exe} 在前 {dir} 在后',
    !!preLog && preLog.args[0] === padExe && preLog.args[1] === GAME_DIR,
    'args=' + JSON.stringify(preLog?.args),
  )
  const postLog = readJsonSafe(hookLogPost)
  console.log('DEBUG postLog', JSON.stringify(postLog))
  assert('postLaunchCmd 已执行', !!postLog, 'log=' + JSON.stringify(postLog))
  assert('postLaunchCmd 参数传入', !!postLog && postLog.args.includes('after'), 'args=' + JSON.stringify(postLog?.args))

  // ---- 3. LE 未配置时报错（useLE 但路径找不到）
  const updLe = await evalJs(
    `(async () => { const g = await window.hh.updateGame('g1', { useLE: true }); return { ok: !!g, le: g?.useLE } })()`,
  )
  assert('更新 useLE=true', updLe.ok === true && updLe.le === true)
  const launchLeErr = await evalJs(
    `(async () => { const r = await window.hh.launchGame('g1'); return { ok: r?.ok, err: r?.error } })()`,
  )
  console.log('DEBUG LE err', JSON.stringify(launchLeErr))
  assert(
    'LE 未配置时报错（不静默降级）',
    launchLeErr.ok === false && /Locale Emulator|LEProc/.test(launchLeErr.err ?? ''),
    JSON.stringify(launchLeErr),
  )

  // ---- 4. LE 配置为可执行文件后启动链正常（LEProc 由 whoami 顶替：立即退出但 spawn 成功）
  const leProc = 'C:\\Windows\\System32\\whoami.exe'
  const saveLe = await evalJs(`(async () => {
    const s = await window.hh.getSettings()
    s.le_path = ${JSON.stringify(leProc)}
    const r = await window.hh.saveSettings(s)
    return { ok: r?.ok, le: r?.settings?.le_path }
  })()`)
  assert('保存 le_path', saveLe.ok === true && saveLe.le === leProc, JSON.stringify(saveLe))
  const launchLeOk = await evalJs(
    `(async () => { const r = await window.hh.launchGame('g1'); return { ok: r?.ok, err: r?.error } })()`,
  )
  assert('LE 配置后启动返回 ok', launchLeOk.ok === true, JSON.stringify(launchLeOk))
  await wait(1200)

  // ---- 5. Magpie 配置后启动：启动链 ok 且游戏仍在运行（Magpie 拉起不阻塞本体）
  // 先关 LE（避免干扰）、开 useMagpie；magpie_path 沿用设置里保存的 le_path（cmd.exe 顶替，
  // 验证「配置了路径 → 启动后自动拉起且不阻塞」）
  await evalJs(`(async () => {
    const s = await window.hh.getSettings()
    s.magpie_path = ${JSON.stringify(leProc)}
    const r = await window.hh.saveSettings(s)
    return { ok: r?.ok }
  })()`)
  await evalJs(
    `(async () => { const g = await window.hh.updateGame('g1', { useLE: false, useMagpie: true }); return { ok: !!g } })()`,
  )
  const launchMg = await evalJs(
    `(async () => { const r = await window.hh.launchGame('g1'); return { ok: r?.ok, err: r?.error } })()`,
  )
  assert('Magpie 配置后启动返回 ok（拉起不阻塞本体启动链）', launchMg.ok === true, JSON.stringify(launchMg))
  await wait(1600)
  // Magpie 断言：同步代码路径（setTimeout spawn）不产生启动失败日志——查主进程 stderr
  const mgErrShown = /Magpie/.test(stderr) && /启动失败/.test(stderr)
  assert('Magpie 拉起无启动失败日志', mgErrShown === false, 'stderr=' + stderr.slice(-300))

  // ---- 6. 编辑对话框字段能保存
  const editSave = await evalJs(`(async () => {
    const g = await window.hh.updateGame('g1', { preLaunchCmd: ${JSON.stringify(`"${nodeExe}" x {exe}`)}, postLaunchCmd: ${JSON.stringify('y')} })
    return { pre: g?.preLaunchCmd, post: g?.postLaunchCmd }
  })()`)
  assert(
    '编辑对话框字段（preLaunchCmd/postLaunchCmd）可保存',
    editSave.pre === `"${nodeExe}" x {exe}` && editSave.post === 'y',
    JSON.stringify(editSave),
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
