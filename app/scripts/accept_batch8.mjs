// T19.2 验收：G14 数据导出（游戏库导出 CSV / JSON）
// 用法：node scripts/accept_batch8.mjs
// 说明：
//  主进程 ExportGames 支持 HANEHANA_EXPORT_DEST 测试缝（跳过系统保存对话框直接写文件），
//  因此本脚本可以在无人工干预下验证导出的文件内容与入口 UI。
// 断言：
//  1. 工具栏出现「导出」按钮（.export-wrap .tool-btn）
//  2. 点击后弹出菜单，含「导出 CSV」「导出 JSON」
//  3. 导出 CSV：文件落盘、表头正确、含种子字段、RFC4180 引号转义
//  4. 导出 JSON：文件落盘、JSON 可解析、字段齐全
//  5. 取消导出（不设 HANEHANA_EXPORT_DEST 时不自动化——这里用另一条：直接经 preload 桥调用，
//     确认返回 { ok: true, path: ... }）
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const APP_ROOT = process.cwd()
const PORT = '9264'
const DATA_DIR = join(APP_ROOT, '.batch8-data')
const GAME_DIR = join(APP_ROOT, '.batch8-game')
const EXPORT_DIR = join(APP_ROOT, '.batch8-export')
rmSync(DATA_DIR, { recursive: true, force: true })
rmSync(GAME_DIR, { recursive: true, force: true })
rmSync(EXPORT_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(GAME_DIR, { recursive: true })
mkdirSync(EXPORT_DIR, { recursive: true })

// 种子：两个游戏，一个含逗号/引号/换行的字段，验证 RFC4180 转义
const now = Date.now()
const games = [
  {
    id: 'g1', dir: GAME_DIR, exePath: join(GAME_DIR, 'game1.exe'), rawTitle: 'Seed One', title: '种子一号',
    developer: '柚子社', series: ['S1', 'S2'], releaseDate: '2020-01-01', rating: '8.5',
    tags: ['汉化', '日常'], categories: ['ADV'], coverPath: '', playMs: 3600000,
    lastPlayed: new Date(now - 86400000).toISOString(), lengthMinutes: 300, favorite: true,
  },
  {
    id: 'g2', dir: GAME_DIR, exePath: join(GAME_DIR, 'game2.exe'), rawTitle: 'Seed Two', title: '种子二号"引号",带逗号',
    developer: '涡旋社,Inc', series: [], releaseDate: '', rating: '',
    tags: ['R18', '奇','怪\n换行'], categories: [], coverPath: '', playMs: 0,
    lastPlayed: '', lengthMinutes: null, favorite: false,
  },
]
writeFileSync(join(DATA_DIR, 'games.json'), JSON.stringify(games, null, 2), 'utf8')

const csvDest = join(EXPORT_DIR, 'library.csv')
const jsonDest = join(EXPORT_DIR, 'library.json')

const exe = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const proc = spawn(exe, ['--disable-gpu', '.'], {
  cwd: APP_ROOT,
  env: { ...process.env, HANEHANA_DEBUG_PORT: String(PORT), HANEHANA_DATA_DIR: DATA_DIR, HANEHANA_EXPORT_DEST: csvDest },
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
    ws.onopen = () => { clearTimeout(to); resolve(ws) }
    ws.onerror = () => reject(new Error('ws error'))
  })
}
let passed = 0
let failed = 0
function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log('PASS ' + name) }
  else { failed++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

/** 迷你 RFC4180 解析器：处理引号包裹 + 内部引号翻倍 + 单元格内换行 */
function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let inQuotes = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      cell += ch; i++; continue
    }
    if (ch === '"') { inQuotes = true; i++; continue }
    if (ch === ',') { row.push(cell); cell = ''; i++; continue }
    if (ch === '\r') { i++; continue }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue }
    cell += ch; i++
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.some((c) => c !== ''))
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
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('cdp timeout: ' + method)) } }, 15000)
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
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await send('Page.bringToFront').catch(() => {})
  await wait(800)

  // ---- 1. 工具栏导出按钮存在
  const btn = await evalJs(`!!document.querySelector('.export-wrap .tool-btn')`)
  assert('工具栏有导出按钮', btn === true)

  // ---- 2. 点击弹出菜单含两个选项
  await evalJs(`document.querySelector('.export-wrap .tool-btn')?.click()`)
  await wait(300)
  const menu = await evalJs(`[...document.querySelectorAll('.export-item')].map(b => b.textContent.trim())`)
  console.log('DEBUG menu', JSON.stringify(menu))
  assert('导出菜单含 CSV/JSON', Array.isArray(menu) && menu.includes('导出 CSV') && menu.includes('导出 JSON'), JSON.stringify(menu))

  // ---- 3. 直接经 preload 桥导出 CSV（HANEHANA_EXPORT_DEST → csvDest）
  const csvR = await evalJs(`(async () => await window.hh.exportGames('csv'))()`)
  console.log('DEBUG csvR', JSON.stringify(csvR))
  assert('导出 CSV 返回 ok+path', csvR?.ok === true && typeof csvR.path === 'string', JSON.stringify(csvR))
  assert('CSV 文件已落盘', existsSync(csvDest))
  const csvContent = readFileSync(csvDest, 'utf8')
  const csvLines = csvContent.split(/\r?\n/)
  console.log('DEBUG csv head', JSON.stringify(csvLines.slice(0, 3)))
  assert('CSV 表头含 title', csvLines[0]?.split(',').includes('title'))
  assert('CSV 表头含 exePath', csvLines[0]?.split(',').includes('exePath'))
  // 用迷你解析器还原记录，验证转义与字段完整
  const parsed = parseCsv(csvContent)
  const header = parsed[0]
  const dataRows = parsed.slice(1)
  assert('CSV 有 2 行数据', dataRows.length === 2, 'rows=' + dataRows.length)
  const idx = (name) => header.indexOf(name)
  assert('CSV 表头含 title/exePath/developer', idx('title') >= 0 && idx('exePath') >= 0 && idx('developer') >= 0)
  const g2 = dataRows.find((r) => (r[idx('title')] ?? '').includes('种子二号'))
  assert('RFC4180 引号转义生效', !!g2 && g2[idx('title')] === '种子二号"引号",带逗号', JSON.stringify(g2?.[idx('title')]))
  assert('逗号字段被引号包裹', !!g2 && g2[idx('developer')] === '涡旋社,Inc', JSON.stringify(g2?.[idx('developer')]))
  assert('换行字段被引号包裹', !!g2 && g2[idx('tags')] === 'R18; 奇; 怪\n换行', JSON.stringify(g2?.[idx('tags')]))
  assert('CSV 保留 playMs', !!g2 && g2[idx('playMs')] === '0')
  const g1 = dataRows.find((r) => r[idx('title')] === '种子一号')
  assert('CSV 含 series 拼接', !!g1 && g1[idx('series')] === 'S1; S2', JSON.stringify(g1?.[idx('series')]))
  assert('CSV 含 favorite', !!g1 && g1[idx('favorite')] === 'true')

  // ---- 4. 导出 JSON：直接经 preload 桥导出 json —— 但 HANEHANA_EXPORT_DEST 只指了一个文件，
  // 需要先确认 preload 桥存在且能走通（同 CSV 同路径会被覆盖，但文件内容应是 JSON）
  const jsonR = await evalJs(`(async () => await window.hh.exportGames('json'))()`)
  console.log('DEBUG jsonR', JSON.stringify(jsonR))
  assert('导出 JSON 返回 ok+path', jsonR?.ok === true && typeof jsonR.path === 'string', JSON.stringify(jsonR))
  // 由于 HANEHANA_EXPORT_DEST 固定单一文件，JSON 会覆盖同一路径（测试缝行为）。为验证 JSON 内容，
  // 这里单独再启一个无测试缝的实例验证 JSON 分支，或在同进程里改 env 重启 —— 简化：验证同文件现在可解析为 JSON
  let jsonObj = null
  try { jsonObj = JSON.parse(readFileSync(csvDest, 'utf8')) } catch { jsonObj = null }
  assert('导出文件为可解析 JSON', Array.isArray(jsonObj) && jsonObj.length === 2, csvDest)
  assert('JSON 含 playHours 计算字段', Array.isArray(jsonObj) && jsonObj[0].playHours === 1)

  // ---- 5. 桥返回类型断言
  assert('桥返回没有 error 字段', !csvR?.error && !jsonR?.error, JSON.stringify({ csvR, jsonR }))

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