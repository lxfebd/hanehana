// T17 验收：存档备份/恢复/云同步（G1）
// 用法：node scripts/accept_batch6.mjs
//  - 种子：真实游戏目录（含 save/ 存档）+ games.json
//  - CDP 断言：设置页「备份」页签、详情面板备份入口、备份对话框
//  - 桥调用：backupCreate/list/restore/delete/sync 全链路
//  - WebDAV：内嵌本地 mock server，验证上传（PUT）/列目录（PROPFIND）
import { mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

const here = join(process.cwd(), 'scripts')
const APP_ROOT = process.cwd()
const PORT = '9261'
const DAV_PORT = 9288
const DATA_DIR = join(APP_ROOT, '.batch6-data')
const GAME_DIR = join(APP_ROOT, '.batch6-game')
rmSync(DATA_DIR, { recursive: true, force: true })
rmSync(GAME_DIR, { recursive: true, force: true })
mkdirSync(join(DATA_DIR, 'covers'), { recursive: true })
mkdirSync(join(GAME_DIR, 'save'), { recursive: true })
mkdirSync(join(GAME_DIR, 'GameData'), { recursive: true })
// g2：目录存在但只有游戏本体 exe（无任何存档文件）
const GAME_DIR2 = join(APP_ROOT, '.batch6-game2')
mkdirSync(GAME_DIR2, { recursive: true })
writeFileSync(join(GAME_DIR2, 'game.exe'), 'BIG-BODY-EXE', 'utf8')

// 真实存档文件：save/ 下 3 个 + GameData 下 1 个 + 游戏本体 exe（不应进快照）
writeFileSync(join(GAME_DIR, 'save', 'global.dat'), 'save-data-v1', 'utf8')
writeFileSync(join(GAME_DIR, 'save', 'slot1.dat'), 'slot-one', 'utf8')
writeFileSync(join(GAME_DIR, 'save', 'config.ini'), '[options]\nfullscreen=1\n', 'utf8')
writeFileSync(join(GAME_DIR, 'GameData', 'profile.sav'), 'profile', 'utf8')
writeFileSync(join(GAME_DIR, 'game.exe'), 'BIG-BODY-EXE', 'utf8')

const now = Date.now()
const games = [
  {
    id: 'g1', dir: GAME_DIR, exePath: 'C:\\Windows\\System32\\whoami.exe', rawTitle: 'Test Game', title: '测试游戏 Test Game',
    coverPath: '', releaseDate: '2020-01-01', rating: 8.0, tags: ['测试'], categories: [],
    sources: [{ provider: 'vndb', id: 'v1' }], playMs: 0, useLE: false, useMagpie: false,
    addedAt: now, favorite: false, backupEnabled: true,
  },
  {
    id: 'g2', dir: GAME_DIR2, exePath: join(GAME_DIR2, 'game.exe'), rawTitle: 'No Save Game', title: '无存档游戏',
    coverPath: '', releaseDate: '2021-01-01', tags: [], categories: [],
    sources: [], playMs: 0, useLE: false, useMagpie: false, addedAt: now, favorite: false,
  },
]
writeFileSync(join(DATA_DIR, 'games.json'), JSON.stringify(games, null, 2), 'utf8')

// ---- 内嵌 WebDAV mock：内存态文件表，支持 PROPFIND/PUT/MKCOL/GET ----
const davStore = new Map() // key: 相对路径（/ 开头）, value: Buffer
davStore.set('/hanehana/', Buffer.alloc(0))
let davAuthOk = true
const davServer = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const rel = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/'
  const method = req.method
  const send = (code, body = '') => { res.writeHead(code, { 'Content-Type': 'application/xml; charset=utf-8' }); res.end(body) }
  if (method === 'MKCOL') {
    if (davStore.has(rel + '/')) return send(405)
    davStore.set(rel + '/', Buffer.alloc(0))
    return send(201)
  }
  if (method === 'PROPFIND') {
    // 简化：Depth:1 下列出 rel/ 下的直接子项
    const prefix = rel === '/' ? '' : rel
    const entries = []
    for (const k of davStore.keys()) {
      if (k.startsWith(prefix + '/') && k !== prefix + '/' && !k.slice(prefix.length + 1).includes('/')) {
        entries.push(k)
      }
    }
    const body = entries.map((k) => {
      const isDir = k.endsWith('/')
      const size = isDir ? 0 : (davStore.get(k)?.length ?? 0)
      return `<d:response><d:href>${k}</d:href><d:propstat><d:prop><d:getcontentlength>${size}</d:getcontentlength><d:getlastmodified>${new Date(now).toUTCString()}</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
    }).join('')
    return send(207, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${body}</d:multistatus>`)
  }
  if (method === 'PUT') {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => { davStore.set(rel, Buffer.concat(chunks)); send(201) })
    return
  }
  if (method === 'GET') {
    const buf = davStore.get(rel)
    if (!buf) return send(404)
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
    return res.end(buf)
  }
  send(501)
})

// ---- 启动 app ----
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

async function main() {
  await new Promise((r) => davServer.listen(DAV_PORT, r))
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

  // ---- 1. 设置页「备份」页签存在
  await evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('设置'))?.click()`)
  await wait(600)
  const backupTab = await evalJs(`[...document.querySelectorAll('.ant-tabs-tab')].some(t => t.textContent.includes('备份'))`)
  assert('设置页有「备份」页签', backupTab === true)

  // ---- 2. 详情面板备份入口存在
  await evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('全部游戏'))?.click()`)
  await wait(600)
  await evalJs(`(async () => { const cards = document.querySelectorAll('.cover-card'); if (cards.length) cards[0].click(); return true })()`)
  await wait(400)
  const backupBtn = await evalJs(`[...document.querySelectorAll('.fav-btn')].some(b => b.textContent.includes('备份'))`)
  assert('详情面板有备份入口', backupBtn === true)

  // ---- 3. 桥调用：创建快照 → 列出 → 数量与文件正确
  const snapCreate = await evalJs(`(async () => { const s = await window.hh.backupCreate('g1'); return { files: s?.files, bytes: s?.totalBytes, dirPath: s?.dirPath } })()`)
  console.log('DEBUG snap', JSON.stringify(snapCreate))
  assert('backupCreate 创建快照（4 个存档文件）', snapCreate.files === 4, 'files=' + snapCreate.files)
  assert('快照字节数 > 0', (snapCreate.bytes ?? 0) > 0, 'bytes=' + snapCreate.bytes)

  const snapList = await evalJs(`(async () => { const l = await window.hh.backupsList(); const g = l.find(b => b.gameId === 'g1'); return { n: g?.snapshots.length, enabled: g?.enabled, firstFiles: g?.snapshots[0]?.files } })()`)
  console.log('DEBUG list', JSON.stringify(snapList))
  assert('backupsList 返回 1 份快照且 enabled', snapList.n === 1 && snapList.enabled === true, 'n=' + snapList.n)
  assert('快照文件数 = 4', snapList.firstFiles === 4, 'files=' + snapList.firstFiles)

  // ---- 4. 无存档游戏 g2：快照创建返回 files=0（不炸）
  const snapG2 = await evalJs(`(async () => { const s = await window.hh.backupCreate('g2'); return { files: s?.files, bytes: s?.totalBytes } })()`)
  assert('无存档游戏创建快照不炸（files=0）', snapG2.files === 0, 'files=' + snapG2.files)

  // ---- 5. 修改存档后恢复：先改本地 save/global.dat，再 restore 应还原
  writeFileSync(join(GAME_DIR, 'save', 'global.dat'), 'CORRUPTED', 'utf8')
  const snapDir = snapCreate.dirPath
  const restoreR = await evalJs(`(async () => { const r = await window.hh.backupRestore('g1', ${JSON.stringify(snapDir)}); return r })()`)
  console.log('DEBUG restore', JSON.stringify(restoreR))
  assert('backupRestore 返回 ok:true', restoreR?.ok === true, JSON.stringify(restoreR))
  const restored = readFileSync(join(GAME_DIR, 'save', 'global.dat'), 'utf8')
  assert('恢复后存档内容还原', restored === 'save-data-v1', 'got=' + restored)

  // ---- 6. 配置 WebDAV 并同步：设置页保存 → backupSync 上传 5 个文件（4 存档 + meta.json）
  await evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('设置'))?.click()`)
  await wait(500)
  await evalJs(`[...document.querySelectorAll('.ant-tabs-tab')].find(t => t.textContent.includes('备份'))?.click()`)
  await wait(300)
  // 直接经 store 保存设置更稳：填 webdav_url
  const saveDav = await evalJs(`(async () => {
    const s = await window.hh.getSettings()
    s.webdav_url = 'http://127.0.0.1:${DAV_PORT}/hanehana'
    s.webdav_user = 'u'
    s.webdav_pass = 'p'
    const r = await window.hh.saveSettings(s)
    return { ok: r?.ok }
  })()`)
  assert('保存 WebDAV 配置成功', saveDav.ok === true, JSON.stringify(saveDav))

  const syncR = await evalJs(`(async () => { const r = await window.hh.backupSync('g1', ${JSON.stringify(snapDir)}); return r })()`)
  console.log('DEBUG sync', JSON.stringify(syncR))
  assert('backupSync 上传 5 个文件', syncR.uploaded === 5, 'uploaded=' + syncR.uploaded)
  // 验证 mock 端确实收到：远端目录含 5 项
  const remoteKeys = [...davStore.keys()].filter((k) => k.includes('/hanehana/g1/'))
  assert('WebDAV 远端收到快照文件', remoteKeys.length >= 5, 'keys=' + remoteKeys.length)

  // ---- 7. 删除快照
  const delR = await evalJs(`(async () => { const ok = await window.hh.backupDelete('g1', ${JSON.stringify(snapDir)}); return ok })()`)
  const snapList2 = await evalJs(`(async () => { const l = await window.hh.backupsList(); const g = l.find(b => b.gameId === 'g1'); return g?.snapshots.length ?? -1 })()`)
  assert('backupDelete 删除快照（列表回到 0）', delR === true && snapList2 === 0, 'del=' + delR + ' n=' + snapList2)

  // ---- 8. 自动备份钩子：全局开关 backup_on_exit + g1 带 backupEnabled，
  // 启动一个立即退出的真 exe → exit 事件触发自动快照
  const beforeAuto = await evalJs(`(async () => { const l = await window.hh.backupsList(); const g = l.find(b => b.gameId === 'g1'); return g?.snapshots.length ?? 0 })()`)
  // 开全局开关
  const setGlob = await evalJs(`(async () => {
    const s = await window.hh.getSettings()
    s.backup_on_exit = true
    const r = await window.hh.saveSettings(s)
    return { ok: r?.ok, onExit: r?.settings?.backup_on_exit }
  })()`)
  assert('开启全局 backup_on_exit', setGlob.ok === true && setGlob.onExit === true, JSON.stringify(setGlob))
  // 验证 backupEnabled 能经 updateGame 持久化（G1 真修复点：白名单新增字段）
  // 分两步：先设 false 读回，再设 true 读回（连续调用共享引用会互相覆盖）
  const offR = await evalJs(`(async () => { const g = await window.hh.updateGame('g1', { backupEnabled: false }); return g?.backupEnabled })()`)
  const onR = await evalJs(`(async () => { const g = await window.hh.updateGame('g1', { backupEnabled: true }); return g?.backupEnabled })()`)
  assert('backupEnabled 可经 updateGame 开关', offR === false && onR === true, 'off=' + offR + ' on=' + onR)
  // g1 种子 exePath 已是 whoami：启动后立即退出（code 0 = 正常退出）→ 自动快照
  const launchAuto = await evalJs(`(async () => { const r = await window.hh.launchGame('g1'); return { ok: r?.ok, err: r?.error } })()`)
  assert('启动 g1（whoami 立即退出）返回 ok', launchAuto.ok === true, JSON.stringify(launchAuto))
  await wait(2000) // 等 exit 事件 + 自动备份完成
  const afterAuto = await evalJs(`(async () => { const l = await window.hh.backupsList(); const g = l.find(b => b.gameId === 'g1'); return { n: g?.snapshots.length ?? 0, enabled: g?.enabled } })()`)
  console.log('DEBUG auto', JSON.stringify(afterAuto))
  assert('自动备份触发：快照数 +1', afterAuto.n === beforeAuto + 1, 'before=' + beforeAuto + ' after=' + afterAuto.n)

  console.log('===== ' + passed + ' passed, ' + failed + ' failed =====')
  proc.kill()
  davServer.close()
  process.exit(failed ? 1 : 0)
}
try {
  await main()
} catch (e) {
  console.error('ERROR', e)
  proc.kill()
  davServer.close()
  process.exit(1)
}
