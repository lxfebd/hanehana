// R3 批次验收：P0-5 下载完成 → 一键导入游戏库 + P1-6 完成通知指引
// 用法：node scripts/accept_batch17.mjs   （须先 npm run build）
//  - 本地起 HTTP 服两份产物：Ingest Test.exe / Ingest Test.zip
//  - exe 下载完成 → 任务行出现「导入游戏库」→ 点击 → listGames 出现该作
//  - zip 下载完成 → 同一行不出现导入按钮（解压后走扫描，不给假按钮）
//  - 完成通知文案含指引（主进程 notifyTerminal 纯文本，这里对源码约定做行为替代：
//    通知在前台被 mute，故以任务行闭环为主断言）
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

const here = join(process.cwd(), 'scripts')
const APP_ROOT = process.cwd()
const PORT = '9274'
const DATA_DIR = join(APP_ROOT, '.batch17-data')
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })

const seed = spawn(process.execPath, [join(here, 'seed_layout.mjs'), DATA_DIR], { stdio: ['ignore', 'inherit', 'inherit'] })
await new Promise((res) => seed.on('exit', res))
if (seed.exitCode !== 0) throw new Error('seed_layout failed')

// 本地文件服：exe 与 zip 各一份（内容不校验引擎能否执行，入库只查存在性）
const EXE_BYTES = Buffer.concat([Buffer.from('MZ fake game for ingest\r\n'), Buffer.alloc(64, 0x90)])
const ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Array(60).fill(0)])
const srv = createServer((req, res) => {
  if (req.url?.startsWith('/ingest.exe')) {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': EXE_BYTES.length })
    res.end(EXE_BYTES)
  } else if (req.url?.startsWith('/ingest.zip')) {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': ZIP_BYTES.length })
    res.end(ZIP_BYTES)
  } else {
    res.writeHead(404).end('nope')
  }
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const srvPort = srv.address().port

const exe = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const proc = spawn(exe, ['--disable-gpu', '.'], {
  cwd: APP_ROOT,
  env: { ...process.env, HANEHANA_DEBUG_PORT: String(PORT), HANEHANA_DATA_DIR: DATA_DIR },
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

let passed = 0
let failed = 0
function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log('PASS ' + name) }
  else { failed++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

async function main() {
  const wsUrl = await getWsUrl()
  await new Promise((r) => setTimeout(r, 2500))
  // 直连 page ws：浏览器端 Target.getTargets 在本时序下返回空表，HTTP /json 才稳。
  const port = (wsUrl.match(/:(\d+)\//) || [])[1]
  let pageJson = null
  let lastJson = ''
  for (let i = 0; i < 20 && !pageJson; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      lastJson = JSON.stringify(list.map((t) => ({ type: t.type, url: t.url })))
      pageJson = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
    } catch (e) { lastJson = 'fetch fail: ' + e }
    if (!pageJson) await new Promise((r) => setTimeout(r, 500))
  }
  if (!pageJson) throw new Error('no page target via /json | ' + lastJson)
  const ws = await connectWs(pageJson.webSocketDebuggerUrl)
  let msgId = 0
  const pending = new Map()
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const sendRaw = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++msgId
    pending.set(mid, res)
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }))
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('cdp timeout: ' + method)) } }, 15000)
  })
  const send = (method, params = {}) => sendRaw(method, params)
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.exception?.description ?? 'eval failed') }
    return r.result?.result?.value
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  try {
    await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    await send('Page.bringToFront').catch(() => {})
    await send('Page.reload', { ignoreCache: true })
    await wait(3500)
    const boot = await evalJs(`document.querySelector('.tag')?.textContent ?? ''`)
    console.log('BOOT:', boot)

    // 保存目录必须落在设置允许的目录树内（TasksAdd 路径闸）
    const dlDir = await evalJs(`window.hh.getSettings().then(s => s.download_dir)`)
    console.log('DOWNLOAD_DIR:', dlDir)
    assert('拿到默认下载目录', typeof dlDir === 'string' && !!dlDir && !dlDir.__err, String(dlDir))

    const exeDest = join(dlDir, 'Ingest Test.exe')
    const zipDest = join(dlDir, 'Ingest Test.zip')
    const addExe = await evalJs(`window.hh.addTask({
      url: 'http://127.0.0.1:${srvPort}/ingest.exe',
      dest: ${JSON.stringify(exeDest)},
      threads: 1,
      note: 'batch17-exe',
    })`)
    const addZip = await evalJs(`window.hh.addTask({
      url: 'http://127.0.0.1:${srvPort}/ingest.zip',
      dest: ${JSON.stringify(zipDest)},
      threads: 1,
      note: 'batch17-zip',
    })`)
    console.log('ADD_EXE:', JSON.stringify(addExe), 'ADD_ZIP:', JSON.stringify(addZip))
    assert('exe 任务已创建', addExe?.ok === true, JSON.stringify(addExe))
    assert('zip 任务已创建', addZip?.ok === true, JSON.stringify(addZip))

    // 下载页等两条都完成
    await evalJs(`[...document.querySelectorAll('.nav-item')].find(e => e.textContent.includes('下载'))?.click()`)
    await wait(800)
    let exeRow = null
    let zipRow = null
    for (let i = 0; i < 60; i++) {
      const found = await evalJs(`(() => {
        const rows = [...document.querySelectorAll('.task-row')]
        const find = (key) => rows.find(x => (x.querySelector('.name')?.textContent ?? '').includes(key)) ?? null
        const info = (row) => row ? { done: row.classList.contains('done'), html: row.outerHTML.slice(0, 500) } : null
        return { exe: info(find('Ingest Test.exe')), zip: info(find('Ingest Test.zip')) }
      })()`)
      exeRow = found?.exe
      zipRow = found?.zip
      if (exeRow?.done && zipRow?.done) break
      await wait(500)
    }
    console.log('EXE_ROW_DONE:', exeRow?.done, 'ZIP_ROW_DONE:', zipRow?.done)
    assert('exe 任务已到 done', exeRow?.done === true, String(exeRow?.done))
    assert('zip 任务已到 done', zipRow?.done === true, String(zipRow?.done))

    // exe 行应有「导入游戏库」按钮，zip 行不应有
    const btnState = await evalJs(`(() => {
      const rows = [...document.querySelectorAll('.task-row')]
      const find = (key) => rows.find(x => (x.querySelector('.name')?.textContent ?? '').includes(key))
      const exeRow = find('Ingest Test.exe')
      const zipRow = find('Ingest Test.zip')
      const hasIngest = (row) => !!row && !!row.querySelector('button[title="导入游戏库"]')
      return { exe: hasIngest(exeRow), zip: hasIngest(zipRow) }
    })()`)
    console.log('INGEST_BTN:', JSON.stringify(btnState))
    assert('exe 行有「导入游戏库」按钮', btnState?.exe === true, JSON.stringify(btnState))
    assert('zip 行无导入按钮（不给假入口）', btnState?.zip === false, JSON.stringify(btnState))

    // 点导入 → 库里出现
    const before = await evalJs(`window.hh.listGames()`)
    const beforeN = Array.isArray(before) ? before.length : -1
    await evalJs(`(() => {
      const rows = [...document.querySelectorAll('.task-row')]
      const row = rows.find(x => (x.querySelector('.name')?.textContent ?? '').includes('Ingest Test.exe'))
      row?.querySelector('button[title="导入游戏库"]')?.click()
      return true
    })()`)
    let after = null
    for (let i = 0; i < 20; i++) {
      await wait(400)
      after = await evalJs(`window.hh.listGames()`)
      if (Array.isArray(after) && after.some((g) => String(g.exePath).toLowerCase() === exeDest.toLowerCase())) break
    }
    const hit = Array.isArray(after) ? after.find((g) => String(g.exePath).toLowerCase() === exeDest.toLowerCase()) : null
    console.log('GAMES:', beforeN, '->', Array.isArray(after) ? after.length : after, 'HIT:', hit?.title)
    assert('点击导入后库 +1 且 exePath 命中', !!hit && Array.isArray(after) && after.length === beforeN + 1, JSON.stringify({ beforeN, afterN: Array.isArray(after) ? after.length : null, hit: hit?.title }))
    assert('导入条目标题取自文件名', hit?.title === 'Ingest Test', String(hit?.title))

    // 二次点击同产物 → 应提示已在库中（去重闸）
    await evalJs(`(() => {
      const rows = [...document.querySelectorAll('.task-row')]
      const row = rows.find(x => (x.querySelector('.name')?.textContent ?? '').includes('Ingest Test.exe'))
      row?.querySelector('button[title="导入游戏库"]')?.click()
      return true
    })()`)
    await wait(1200)
    const msgText = await evalJs(`[...document.querySelectorAll('.ant-message-notice')].map(n => n.textContent).join(' | ')`)
    const after2 = await evalJs(`window.hh.listGames()`)
    console.log('DEDUP_MSG:', msgText, 'N:', Array.isArray(after2) ? after2.length : after2)
    assert('重复导入提示已在库中', String(msgText).includes('已在库中') || String(msgText).includes('已在游戏中'), String(msgText))
    assert('重复导入不产生重复条目', Array.isArray(after2) && after2.length === (Array.isArray(after) ? after.length : -1), String(Array.isArray(after2) ? after2.length : after2))
  } finally {
    console.log(`\n==== ${passed} passed, ${failed} failed ====`)
    ws.close()
    proc.kill()
    srv.close()
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  console.error('--- stderr tail ---')
  console.error(stderr.slice(-2000))
  try { proc.kill() } catch { /* ignore */ }
  try { srv.close() } catch { /* ignore */ }
  process.exit(1)
})
