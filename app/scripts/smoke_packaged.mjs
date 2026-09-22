// 打包产物解包 smoke：验证「安装包能起来 + 引擎真的在」。
// 跑在 electron-builder --dir 产物上（release/win-unpacked/），比装 NSIS 安装包快，
// 且能拿到与安装版一致的目录布局（asar + extraResources）。
//
// 断言：
// 1. 解包目录存在，exe 存在
// 2. 引擎 fastdrop-engine.exe 在 resources/ 下（extraResources 落点）
// 3. 以 HANEHANA_DEBUG_PORT 起真实进程，CDP 里 window.hh.hello() 通
//    （hello 会回 engine_ok，顺带证明主进程把引擎路径找对了）
//
// 用法：node scripts/smoke_packaged.mjs
import { existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = join(here, '..')
const UNPACKED = join(APP_ROOT, 'release', 'win-unpacked')
// executableName 是 hanehana（electron-builder.yml），产物名不带品牌大写
const EXE = join(UNPACKED, 'hanehana.exe')
const ENGINE = join(UNPACKED, 'resources', 'fastdrop-engine.exe')
const DEBUG_PORT = 9237

let failed = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`PASS  ${name}`)
  } else {
    failed++
    console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`)
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function launchAndProbe() {
  // 打包版带单实例锁：若已有一个 HaneHana 在跑，这里会被弹回前台并退出，
  // CDP 端口也不归它。测试前必须保证没有残留实例。
  const proc = spawn(EXE, [], {
    cwd: UNPACKED,
    env: {
      ...process.env,
      // 打包版专用 smoke 逃生门（见 index.ts）：默认不带则不开 CDP
      HANEHANA_SMOKE_PORT: String(DEBUG_PORT),
      HANEHANA_DATA_DIR: join(APP_ROOT, '.smoke-data'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  proc.stderr.on('data', (d) => console.log('[app]', d.toString().trim().slice(0, 200)))
  let pages = null
  for (let i = 0; i < 60; i++) {
    try {
      pages = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()
      if (pages.some((p) => p.type === 'page')) break
    } catch {
      // 没起来，再等
    }
    await wait(500)
  }
  if (!pages || !pages.some((p) => p.type === 'page')) {
    try {
      proc.kill()
    } catch {}
    throw new Error('Electron CDP 端口没在 30s 内就绪')
  }
  const page = pages.find((p) => p.type === 'page' && !p.url.startsWith('devtools'))
  if (!page) throw new Error('no page target')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let msgId = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('ws connect failed'))
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++msgId
      pending.set(mid, resolve)
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
  const res = await send('Runtime.evaluate', {
    expression: '(async () => (await window.hh.hello()))()',
    awaitPromise: true,
    returnByValue: true,
  })
  const val = res.result?.result?.value
  try {
    ws.close()
  } catch {}
  proc.kill()
  return val
}

async function main() {
  check('解包目录存在', existsSync(UNPACKED), UNPACKED)
  check('主程序 exe 存在', existsSync(EXE), EXE)
  check('引擎产物存在（extraResources）', existsSync(ENGINE), ENGINE)
  if (!existsSync(EXE)) {
    console.log('未找到解包产物，先跑：npm run dist:dir')
    process.exitCode = failed > 0 ? 1 : 1
    return
  }
  const exeSize = statSync(EXE).size
  check('exe 非空', exeSize > 1000, `${exeSize} B`)
  try {
    const hello = await launchAndProbe()
    check('打包版 hh.hello 通', !!hello && hello.name === 'hanehana', JSON.stringify(hello))
    check('打包版引擎自检 ok', hello?.engine_ok === true, JSON.stringify(hello))
  } catch (e) {
    failed++
    console.log('FAIL  启动并 CDP 探活 —', e.message)
  }
  console.log(`\n==== ${failed === 0 ? '全部通过' : `${failed} 项失败`} ====`)
  process.exitCode = failed > 0 ? 1 : 0
}

main()
