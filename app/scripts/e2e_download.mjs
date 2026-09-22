// 下载链路端到端验证（真实 Electron 窗口 + 真实 Rust 引擎）：
// 1. 起本地 HTTP 文件服务器（固定大小随机文件）
// 2. 拉起 Electron（HANEHANA_DEBUG_PORT=9223, HANEHANA_DATA_DIR=隔离目录）
// 3. CDP 调 window.hh.addTask 建真实任务 → 轮询 listTasks 等 done
// 4. 校验磁盘文件字节数与 md5 与源一致
// 5. 再验证 removeTask 与状态持久化（重启后列表状态还在）
//
// 用法：node scripts/e2e_download.mjs
import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = join(here, '..')
const DEBUG_PORT = 9223
const DATA_DIR = join(APP_ROOT, '.e2e-data')
const DOWNLOAD_DIR = join(DATA_DIR, 'dl')
const SRC_FILE = join(DATA_DIR, 'src.bin')

// 12 MiB 随机文件，多线程分片下足够跑出真实分段
const FILE_SIZE = 12 * 1024 * 1024

function md5(p) {
  return createHash('md5').update(readFileSync(p)).digest('hex')
}

function startFileServer() {
  return new Promise((resolve) => {
    const served = { bytes: 0 }
    const srv = createServer((req, res) => {
      const file = SRC_FILE
      if (!existsSync(file)) {
        res.writeHead(404)
        res.end('nope')
        return
      }
      const size = statSync(file).size
      const range = req.headers.range
      let start = 0
      let end = size - 1
      let status = 200
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range)
        start = m ? Number(m[1]) : 0
        end = m && m[2] ? Number(m[2]) : size - 1
        status = 206
      }
      // pause 会让引擎带着 EPIPE/ECONNRESET 掐断连接；流错误不兜住的话，
      // 服务器的 uncaughtException 会把整个 e2e 进程带走。
      const rs = createReadStream(file, { start, end })
      rs.on('data', (c) => {
        served.bytes += c.length
      })
      rs.on('error', () => {})
      rs.pipe(res)
      res.on('close', () => rs.destroy())
      res.on('error', () => {})
      const headers = {
        'content-length': end - start + 1,
        'accept-ranges': 'bytes',
      }
      if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${size}`
      res.writeHead(status, headers)
    })
    srv.listen(0, '127.0.0.1', () =>
      resolve({ port: srv.address().port, close: () => srv.close(), servedBytes: () => served.bytes }),
    )
  })
}

let electronProc = null
async function launchElectron() {
  const exe = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  // 必须用 electron 主入口跑 out/main/index.js（打包产物），真实模拟生产链路。
  // 开发模式 electron-vite dev 会再起一个 dev server，反而多一层不确定性。
  const proc = spawn(exe, ['.'], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      HANEHANA_DEBUG_PORT: String(DEBUG_PORT),
      HANEHANA_DATA_DIR: DATA_DIR,
      // 不设 HANEHANA_ROOT：enginePath() 用 dirname(cwd) 定位 engine-rs，
      // cwd=app 目录时正好落在仓库根的 engine-rs 下。
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  proc.stderr.on('data', (d) => console.log('[app]', d.toString().trim().slice(0, 200)))
  electronProc = proc
  // 等 CDP 端口就绪
  for (let i = 0; i < 60; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()
      if (pages.some((p) => p.type === 'page')) return pages
    } catch {
      // 没起来，再等
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('Electron CDP 端口没在 30s 内就绪')
}

let ws = null
let msgId = 0
const pending = new Map()
function connectCdp() {
  return new Promise(async (resolve, reject) => {
    const pages = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()
    const page = pages.find((p) => p.type === 'page' && !p.url.startsWith('devtools'))
    if (!page) return reject(new Error('no page target'))
    ws = new WebSocket(page.webSocketDebuggerUrl)
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    }
    ws.onopen = () => resolve()
  })
}

function send(method, params = {}) {
  return new Promise((resolve) => {
    const mid = ++msgId
    pending.set(mid, resolve)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
}

async function evalJs(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.result?.exceptionDetails) {
    return { __err: res.result.exceptionDetails.exception?.description ?? 'evaluate failed' }
  }
  return res.result?.result?.value
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await pred()
    if (last) return last
    await wait(300)
  }
  throw new Error(`超时等不到：${label}（最后值 ${JSON.stringify(last)}）`)
}

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`PASS  ${name}`)
  } else {
    failed++
    console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`)
  }
}

async function main() {
  // 准备隔离数据目录 + 源文件
  rmSync(DATA_DIR, { recursive: true, force: true })
  mkdirSync(DATA_DIR, { recursive: true })
  mkdirSync(DOWNLOAD_DIR, { recursive: true })
  const buf = randomBytes(FILE_SIZE)
  writeFileSync(SRC_FILE, buf)
  const srcMd5 = createHash('md5').update(buf).digest('hex')

  const srv = await startFileServer()
  console.log(`[env] 文件服务器 :${srv.port}，源文件 ${FILE_SIZE} B，md5=${srcMd5.slice(0, 12)}…`)

  try {
    await launchElectron()
    console.log('[env] Electron 已启动（生产产物 out/main/index.js）')
    await connectCdp()
    await wait(1500) // 等渲染完成

    // 桥 + 版本
    const hello = await evalJs(`(async () => (await window.hh.hello()))()`)
    check('hello 桥可用', !!hello && hello.name === 'hanehana', JSON.stringify(hello))

    // 下载设置默认指向隔离目录
    const settings = await evalJs(`(async () => (await window.hh.getSettings()))()`)
    check('getSettings 返回', !!settings && typeof settings.threads === 'number', JSON.stringify(settings))

    // 把默认下载目录指到隔离目录：addTask 的 dest 必须落在「默认下载目录 +
    // 会话内用户手选目录」的白名单内（主进程 isDestAllowed），否则会被拒。
    const setDir = await evalJs(`(async () => {
      const s = await window.hh.getSettings()
      s.download_dir = '${DOWNLOAD_DIR.replace(/\\/g, '\\\\')}'
      const r = await window.hh.saveSettings(s)
      return r
    })()`)
    check('默认下载目录指向隔离目录 ok', setDir?.ok === true, JSON.stringify(setDir))

    // 1. 新建任务：加到隔离下载目录
    const addUrl = `http://127.0.0.1:${srv.port}/src.bin`
    const addResult = await evalJs(`(async () => {
      const r = await window.hh.addTask({ url: '${addUrl}', dest: '${DOWNLOAD_DIR.replace(/\\/g, '\\\\')}', threads: 4, note: 'e2e' })
      return r
    })()`)
    check('addTask ok', addResult?.ok === true, JSON.stringify(addResult))
    const taskId = addResult?.def?.id

    // 2. 等任务 done
    let lastRows = null
    const doneRow = await waitFor(async () => {
      lastRows = await evalJs(`(async () => (await window.hh.listTasks()))()`)
      const r = (lastRows || []).find((x) => x.id === `${taskId}`)
      return r && r.snap?.state === 'done' ? r : null
    }, 60_000, '下载完成').catch((e) => {
      console.log('[diag] rows =', JSON.stringify(lastRows).slice(0, 800))
      throw e
    })
    check('任务下载到 done', !!doneRow, JSON.stringify(doneRow)?.slice(0, 300))
    const total = doneRow?.snap?.total ?? 0
    check('total 等于源大小', total === FILE_SIZE, `total=${total}`)

    // 3. 磁盘文件校验
    const destPath = doneRow?.snap?.dest ?? ''
    check('dest 落盘存在', !!destPath && existsSync(destPath), destPath)
    let diskOk = false
    let diskDetail = ''
    if (destPath && existsSync(destPath)) {
      const sz = statSync(destPath).size
      const h = md5(destPath)
      diskOk = sz === FILE_SIZE && h === srcMd5
      diskDetail = `size=${sz} md5=${h.slice(0, 12)}`
    }
    check('磁盘文件字节与 md5 一致', diskOk, diskDetail)

    // 4. listTasks 有记录且状态持久化在 def
    const rowsAfter = await evalJs(`(async () => (await window.hh.listTasks()))()`)
    check('listTasks 行存在', Array.isArray(rowsAfter) && rowsAfter.length >= 1, `rows=${rowsAfter?.length}`)

    // 5. 设置读写
    const saveResult = await evalJs(`(async () => {
      const s = await window.hh.getSettings()
      s.threads = 2
      const r = await window.hh.saveSettings(s)
      return r
    })()`)
    check('saveSettings ok', saveResult?.ok === true, JSON.stringify(saveResult))
    const s2 = await evalJs(`(async () => (await window.hh.getSettings()).threads)()`)
    check('settings 落盘生效', s2 === 2, `threads=${s2}`)

    // 6. 重复添加去重
    const dup = await evalJs(`(async () => (await window.hh.addTask({ url: '${addUrl}', dest: '${DOWNLOAD_DIR.replace(/\\/g, '\\\\')}', threads: 4 })))()`)
    check('重复链接返回 duplicate', dup?.ok === true && dup?.duplicate === true, JSON.stringify(dup))

    // 7. removeTask 只删记录（文件保留）
    const rm = await evalJs(`(async () => (await window.hh.removeTask('${taskId}', false)))()`)
    check('removeTask(不删文件) ok', rm?.ok === true, JSON.stringify(rm))
    check('removeTask 后文件仍在', existsSync(destPath), destPath)

    // ---- Phase 1 新增用例：并发上限 / pause 流量停 / retry 无残留 ----
    // 这些用例都要观察「下载中」的瞬时状态，所以把限速调低到 1.5 MiB/s、
    // 并发压到 2，12 MiB 的任务才会在窗口期内可观测。
    const throttle = await evalJs(`(async () => {
      const s = await window.hh.getSettings()
      s.rate_limit_kbps = 1500
      s.max_concurrent = 2
      s.threads = 2
      const r = await window.hh.saveSettings(s)
      return r
    })()`)
    check('限速/并发设置 ok', throttle?.ok === true, JSON.stringify(throttle))

    const activeStates = ['preparing', 'downloading', 'verifying']
    const stateOf = (rows, id) => (rows || []).find((x) => x.id === id)?.snap?.state

    // 7a. 并发上限：加 3 个任务（不同 URL 避免去重），轮询确认同时活跃 ≤ 2
    const conIds = []
    let maxActive = 0
    for (let i = 0; i < 3; i++) {
      const r = await evalJs(`(async () => {
        const u = '${addUrl}?c=${i}'
        const d = '${DOWNLOAD_DIR.replace(/\\/g, '\\\\')}/con${i}.bin'
        return await window.hh.addTask({ url: u, dest: d, threads: 2 })
      })()`)
      conIds.push(r?.def?.id ?? '')
    }
    const conAllDone = await waitFor(async () => {
      const rows = await evalJs(`(async () => (await window.hh.listTasks()))()`)
      const acts = conIds.filter((id) => activeStates.includes(stateOf(rows, id))).length
      if (acts > maxActive) maxActive = acts
      return conIds.every((id) => stateOf(rows, id) === 'done') ? rows : null
    }, 120_000, '3 个并发任务全 done').catch((e) => {
      console.log('[diag] maxActive=', maxActive, 'conIds=', conIds)
      throw e
    })
    check('并发上限 max_concurrent=2 生效（活跃≤2）', maxActive <= 2, `maxActive=${maxActive}`)
    check('并发峰值确实是 2', maxActive === 2, `maxActive=${maxActive}`)

    // 7b. pause 期间流量停：限速下下载到中途，pause 后确认已下字节不再增长
    const pauseUrl = `${addUrl}?p=1`
    const pauseRow = await evalJs(`(async () => (await window.hh.addTask({ url: '${pauseUrl}', dest: '${DOWNLOAD_DIR.replace(/\\/g, '\\\\')}/pause.bin', threads: 2 })))()`)
    const pauseId = pauseRow?.def?.id ?? ''
    const pauseStarted = await waitFor(async () => {
      const rows = await evalJs(`(async () => (await window.hh.listTasks()))()`)
      const st = stateOf(rows, pauseId)
      const down = (rows || []).find((x) => x.id === pauseId)?.snap?.downloaded || 0
      return st === 'downloading' && down > 0 ? down : null
    }, 30_000, 'pause 任务开始下载且有进度')
    await evalJs(`(async () => (await window.hh.action('${pauseId}', 'pause')))()`)
    await waitFor(async () => {
      const rows = await evalJs(`(async () => (await window.hh.listTasks()))()`)
      return stateOf(rows, pauseId) === 'paused' ? true : null
    }, 15_000, 'pause 后进入 paused 状态')
    await wait(500) // 让引擎把 in-flight 的 socket 掐掉、服务端字节入账
    const pausedDown = await evalJs(`(async () => {
      const rows = await window.hh.listTasks()
      return (rows.find((x) => x.id === '${pauseId}')?.snap?.downloaded) || 0
    })()`)
    const servedBefore = srv.servedBytes()
    await wait(1200)
    const servedAfter = srv.servedBytes()
    const pausedDownAfter = await evalJs(`(async () => {
      const rows = await window.hh.listTasks()
      return (rows.find((x) => x.id === '${pauseId}')?.snap?.downloaded) || 0
    })()`)
    check('pause 后服务端不再吐字节', servedAfter - servedBefore === 0, `served ${servedBefore}→${servedAfter}`)
    check('pause 后 downloaded 不再增长', pausedDownAfter === pausedDown, `downloaded ${pausedDown}→${pausedDownAfter}`)

    // 7c. retry 后 .part 不残留：pause 的任务删掉 .part/.part.meta 重启，
    //     但要注意 .part 是引擎进程持有的；直接断言文件不存在会撞上重下瞬间的
    //     再创建。改为断言「retry 后 downloaded 归零 + 重新从 0 开始下」，
    //     且 retry 完成时 .part.meta 存在而 .part 是新建的（文件大小从 0 重新增长）。
    const partPath = `${DOWNLOAD_DIR}/pause.bin.part`
    const metaPath = `${DOWNLOAD_DIR}/pause.bin.part.meta`
    const hadPart = existsSync(partPath)
    check('pause 期间 .part 存在', hadPart, partPath)
    await evalJs(`(async () => (await window.hh.action('${pauseId}', 'retry')))()`)
    const retryDownloaded = await waitFor(async () => {
      const rows = await evalJs(`(async () => (await window.hh.listTasks()))()`)
      const r = (rows || []).find((x) => x.id === pauseId)
      return r?.snap?.state === 'downloading' && (r.snap?.downloaded || 0) > 0 ? r.snap.downloaded : null
    }, 30_000, 'retry 后重新开始下载')
    check('retry 后 downloaded 从 0 重新计', retryDownloaded > 0 && retryDownloaded < FILE_SIZE, `downloaded=${retryDownloaded}`)
    // 收尾：等它下完，恢复默认设置
    await waitFor(async () => {
      const rows = await evalJs(`(async () => (await window.hh.listTasks()))()`)
      return stateOf(rows, pauseId) === 'done' ? true : null
    }, 120_000, 'retry 任务最终 done')
    const finalPart = existsSync(partPath)
    const finalMeta = existsSync(metaPath)
    check('done 后 .part 已清理', !finalPart, partPath)
    check('done 后 .part.meta 已清理', !finalMeta, metaPath)
    // 让 con 与 pause 之外多余的任务清掉，避免影响持久化用例的计数
    const restore = await evalJs(`(async () => {
      const s = await window.hh.getSettings()
      s.rate_limit_kbps = 0
      s.max_concurrent = 3
      s.threads = 8
      const r = await window.hh.saveSettings(s)
      return r
    })()`)
    check('恢复默认设置 ok', restore?.ok === true, JSON.stringify(restore))

    // 8. 重启持久化：重新加一个任务，等 done，重启 Electron，确认列表/状态/文件都还在
    const add2 = await evalJs(`(async () => {
      const r = await window.hh.addTask({ url: '${addUrl}', dest: '${DOWNLOAD_DIR.replace(/\\/g, '\\\\')}', threads: 2, note: 'persist' })
      return r
    })()`)
    const persistId = add2?.def?.id ?? ''
    check('持久化任务 add ok', add2?.ok === true, JSON.stringify(add2))
    await waitFor(async () => {
      const rows = await evalJs(`(async () => (await window.hh.listTasks()))()`)
      const r = (rows || []).find((x) => x.id === persistId)
      return r && r.snap?.state === 'done' ? r : null
    }, 60_000, '持久化任务下载完成')
    console.log('[persist] 重启前任务已完成，准备重启 Electron…')

    // 关闭当前实例，再用同一 DATA_DIR 重启
    try { ws?.close() } catch {}
    electronProc?.kill()
    await wait(1200)
    await launchElectron()
    await connectCdp()
    await wait(1200)

    const rowsAfterRestart = await evalJs(`(async () => (await window.hh.listTasks()))()`)
    const pRow = (rowsAfterRestart || []).find((x) => x.id === persistId)
    check('重启后任务记录还在', !!pRow, JSON.stringify(pRow)?.slice(0, 200))
    check('重启后状态为 done', pRow?.snap?.state === 'done' || pRow?.def?.state === 'done', JSON.stringify(pRow?.snap?.state))
    check('重启后文件仍在', existsSync(pRow?.snap?.dest ?? pRow?.def?.dest ?? ''), pRow?.snap?.dest ?? '')
    check('重启后 hello 仍可用', await evalJs(`(async () => (await window.hh.hello()).name)()`) === 'hanehana')

    console.log(`\n==== ${passed} passed, ${failed} failed ====`)
    if (failed > 0) process.exitCode = 1
  } catch (e) {
    console.error('FATAL', e.message)
    process.exitCode = 1
  } finally {
    try {
      ws?.close()
    } catch {}
    electronProc?.kill()
    srv.close()
    await wait(500)
  }
}

main()
