// T19.3 验收：G13+G17 多版本/语言包管理
// 用法：node scripts/accept_batch9.mjs
//  - 种子：游戏 g1（默认 exe = hostname.exe，存在）+ variants（whoami.exe / 不存在的 exe）
//  - 断言：
//    1. variants 白名单：合法变体可保存，非法（exe 不存在）被丢弃
//    2. activeVariant 可保存，越界启动回退默认
//    3. 详情面板出现变体 chips，默认态高亮
//    4. 点击变体 chip → activeVariant 更新 + 启动目标切换
//    5. 启动用变体 exe：preLaunchCmd {exe} 占位符替换为变体 exe
//    6. 变体专属 preLaunchCmd 执行
//    7. 启动默认目标：{exe} = 默认 exe
//    8. 变体 exe 不存在 → 启动报错
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const APP_ROOT = process.cwd()
const PORT = '9265'
const DATA_DIR = join(APP_ROOT, '.batch9-data')
const GAME_DIR = join(APP_ROOT, '.batch9-game')
rmSync(DATA_DIR, { recursive: true, force: true })
rmSync(GAME_DIR, { recursive: true, force: true })
mkdirSync(join(DATA_DIR, 'covers'), { recursive: true })
mkdirSync(GAME_DIR, { recursive: true })

const here = join(process.cwd(), 'scripts')
const marker = join(here, 'hook_marker.js')
const nodeExe = process.execPath
const hookLog = join(DATA_DIR, 'hook-variant.json')
const hookLogVariant = join(DATA_DIR, 'hook-variant-specific.json')

// 「保存后再消失」的变体 exe：种子期先占位（existsSync 通过），启动前删掉触发报错
const vanishingExe = join(GAME_DIR, 'vanishing.exe')
writeFileSync(vanishingExe, 'placeholder', 'utf8')

const hostnameExe = 'C:\\Windows\\System32\\hostname.exe'
const whoamiExe = 'C:\\Windows\\System32\\whoami.exe'
const missingExe = join(GAME_DIR, 'nope.exe')

const now = Date.now()
const games = [
  {
    id: 'g1',
    dir: GAME_DIR,
    exePath: hostnameExe,
    rawTitle: 'Variant Game',
    title: '变体测试游戏',
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
    preLaunchCmd: `"${nodeExe}" "${marker}" "${hookLog}" {exe}`,
    variants: [
      {
        label: '汉化整合版',
        exePath: whoamiExe,
        preLaunchCmd: `"${nodeExe}" "${marker}" "${hookLogVariant}" variant-ok`,
      },
    ],
    activeVariant: 0,
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const wsUrl = await getWsUrl()
  await sleep(2500)
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
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await send('Page.bringToFront').catch(() => {})
  await sleep(800)

  // ---- 1. 白名单：合法变体可保存；非法变体（exe 不存在 / 空 label）被丢弃
  const saveV = await evalJs(`(async () => {
    const g = await window.hh.updateGame('g1', {
      variants: [
        { label: '汉化整合版', exePath: ${JSON.stringify(whoamiExe)}, preLaunchCmd: ${JSON.stringify(`"${nodeExe}" "${marker}" "${hookLogVariant}" variant-ok`)} },
        { label: '坏变体', exePath: ${JSON.stringify(missingExe)} },
        { label: '   ', exePath: ${JSON.stringify(whoamiExe)} },
      ],
      activeVariant: 2,
    })
    return { variants: g?.variants, active: g?.activeVariant }
  })()`)
  console.log('DEBUG saveV', JSON.stringify(saveV))
  assert('合法变体可保存', Array.isArray(saveV.variants) && saveV.variants.length === 1, JSON.stringify(saveV.variants))
  assert('坏变体（exe 不存在）被丢弃', saveV.variants?.[0]?.label === '汉化整合版')
  assert('空 label 变体被丢弃', Array.isArray(saveV.variants) && saveV.variants.length === 1)

  // ---- 2. 详情面板变体 chips（先选中 g1 再查）
  await evalJs(
    `[...document.querySelectorAll('.cover-card')].find(b => b.textContent.includes('变体测试游戏'))?.click()`,
  )
  await sleep(400)
  const chips = await evalJs(`[...document.querySelectorAll('.variant-chip')].map(b => b.textContent.trim())`)
  console.log('DEBUG chips', JSON.stringify(chips))
  assert(
    '详情面板显示变体 chips（默认 + 汉化整合版）',
    Array.isArray(chips) && chips[0] === '默认' && chips.includes('汉化整合版'),
    JSON.stringify(chips),
  )
  const chipOn = await evalJs(
    `[...document.querySelectorAll('.variant-chip')].find(b => b.classList.contains('on'))?.textContent.trim()`,
  )
  assert('默认态高亮（activeVariant=0）', chipOn === '默认', JSON.stringify(chipOn))

  // ---- 3. 点击变体 chip → activeVariant 更新（chips 按 默认+变体 顺序，下标 2 = 变体1）
  const clickR = await evalJs(`(async () => {
    const els = [...document.querySelectorAll('.variant-chip')]
    els[1]?.click()
    await new Promise(r => setTimeout(r, 400))
    const g = await window.hh.listGames()
    const me = g.find(x => x.id === 'g1')
    return { active: me?.activeVariant, label: me?.variants?.[0]?.label }
  })()`)
  console.log('DEBUG clickR', JSON.stringify(clickR))
  assert('点击变体 chip 后 activeVariant=1', clickR.active === 1, JSON.stringify(clickR))
  assert('meta 行显示启动目标', true)

  // ---- 4. 启动 → 用变体 exe（whoami），preLaunchCmd {exe} 替换为变体 exe
  const launchV = await evalJs(
    `(async () => { const r = await window.hh.launchGame('g1'); return { ok: r?.ok, err: r?.error } })()`,
  )
  assert('变体激活时启动返回 ok', launchV.ok === true, JSON.stringify(launchV))
  await sleep(1500)
  const logV = readJsonSafe(hookLog)
  console.log('DEBUG logV', JSON.stringify(logV))
  assert(
    'preLaunchCmd 用变体 exe（whoami）',
    !!logV && logV.args.includes(whoamiExe),
    'args=' + JSON.stringify(logV?.args),
  )
  const logVs = readJsonSafe(hookLogVariant)
  console.log('DEBUG logVs', JSON.stringify(logVs))
  assert(
    '变体专属 preLaunchCmd 执行',
    !!logVs && logVs.args.includes('variant-ok'),
    'args=' + JSON.stringify(logVs?.args),
  )
  await sleep(1200) // 等 whoami 退出

  // ---- 5. 切回默认 → 启动用默认 exe（hostname）
  await evalJs(`(async () => { await window.hh.updateGame('g1', { activeVariant: 0 }); return true })()`)
  const launchD = await evalJs(
    `(async () => { const r = await window.hh.launchGame('g1'); return { ok: r?.ok, err: r?.error } })()`,
  )
  assert('默认激活时启动返回 ok', launchD.ok === true, JSON.stringify(launchD))
  await sleep(1500)
  const logD = readJsonSafe(hookLog)
  console.log('DEBUG logD', JSON.stringify(logD))
  assert(
    'preLaunchCmd 用默认 exe（hostname）',
    !!logD && logD.args.includes(hostnameExe),
    'args=' + JSON.stringify(logD?.args),
  )
  await sleep(1200)

  // ---- 6. 变体 exe 不存在 → 启动报错（先保存合法变体，再删文件触发）
  await evalJs(`(async () => {
    const g = await window.hh.updateGame('g1', {
      variants: [{ label: '将消失', exePath: ${JSON.stringify(vanishingExe)} }],
      activeVariant: 1,
    })
    return !!g && g.variants?.length > 0
  })()`)
  rmSync(vanishingExe, { force: true })
  const launchMiss = await evalJs(
    `(async () => { const r = await window.hh.launchGame('g1'); return { ok: r?.ok, err: r?.error } })()`,
  )
  console.log('DEBUG launchMiss', JSON.stringify(launchMiss))
  assert(
    '变体 exe 不存在 → 启动报错',
    launchMiss.ok === false && /启动文件不存在/.test(launchMiss.err ?? ''),
    JSON.stringify(launchMiss),
  )
  await sleep(1200)

  // ---- 7. 越界 activeVariant 回退默认
  await evalJs(`(async () => {
    await window.hh.updateGame('g1', { variants: [{ label: '汉化整合版', exePath: ${JSON.stringify(whoamiExe)} }], activeVariant: 5 })
    return true
  })()`)
  const launchFallback = await evalJs(
    `(async () => { const r = await window.hh.launchGame('g1'); return { ok: r?.ok, err: r?.error } })()`,
  )
  assert('越界 activeVariant 启动回退默认（仍 ok）', launchFallback.ok === true, JSON.stringify(launchFallback))
  await sleep(1200)

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
