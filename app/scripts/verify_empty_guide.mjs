// 验证沉浸式空库引导页：空库启动 → .empty-wrap/.empty-aurora/.empty-steps/三步文案存在
import { spawn } from 'node:child_process'
import { pickFreePort, killTree } from './lib/probePort.mjs'
import { join } from 'node:path'
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { waitFor } from './lib/waitFor.mjs'

const APP_ROOT = join(process.cwd())
const PORT = await pickFreePort()
const DATA_DIR = join(APP_ROOT, '.empty-guide-data')
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(join(DATA_DIR, 'covers'), { recursive: true })
mkdirSync(join(DATA_DIR, 'thumbs'), { recursive: true })
writeFileSync(join(DATA_DIR, 'games.json'), '[]', 'utf8') // 空库
// 空库标题的期望值直接取自 i18n 词典（zh/en 两份源文件）：文案改了闸门跟着改，
// 而不是「includes('空')」这种「带个空字就过」的弱断言（zh.ts 的 lib_empty 现在是
// '游戏库还是空的'，en.ts 是 'Your library is empty'）。
const libEmptyTitles = ['zh', 'en'].map((lang) => {
  const file = join(APP_ROOT, 'src', 'renderer', 'i18n', lang + '.ts')
  const m = /lib_empty:\s*'([^']*)'/.exec(readFileSync(file, 'utf8'))
  if (!m) throw new Error('i18n 词典里找不到 lib_empty：' + file)
  return m[1]
})

const env = { ...process.env, HANEHANA_DEBUG_PORT: String(PORT), HANEHANA_DATA_DIR: DATA_DIR }
delete env.ELECTRON_RUN_AS_NODE
const proc = spawn(join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.'], {
  cwd: APP_ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
let stderr = ''
proc.stderr.on('data', (d) => (stderr += d.toString()))
async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)
    if (m) return m[1]
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('no DevTools')
}
function connectWs(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url)
    const to = setTimeout(() => rej(new Error('ws timeout')), 10000)
    ws.onopen = () => {
      clearTimeout(to)
      res(ws)
    }
    ws.onerror = () => rej(new Error('ws err'))
  })
}
async function main() {
  const wsUrl = await getWsUrl()
  // DevTools 已在监听 ⇒ /json 立刻可取；下面 /json 循环本身就是条件等待。原来固定 2500ms 是白等。
  const port = (wsUrl.match(/:(\d+)\//) || [])[1]
  let pageJson = null
  for (let i = 0; i < 20 && !pageJson; i++) {
    try {
      const l = await (await fetch('http://127.0.0.1:' + port + '/json')).json()
      pageJson = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
    } catch {
      /* retry */
    }
    if (!pageJson) await new Promise((r) => setTimeout(r, 500))
  }
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
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const mid = ++msgId
      pending.set(mid, res)
      ws.send(JSON.stringify({ id: mid, method, params }))
      setTimeout(() => {
        if (pending.has(mid)) {
          pending.delete(mid)
          rej(new Error('timeout'))
        }
      }, 30000)
    })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.exception?.description ?? '') }
    return r.result?.result?.value
  }
  try {
    let pass = 0
    let fail = 0
    const ck = (n, c, x = '') => {
      if (c) {
        pass++
        console.log('  [PASS] ' + n)
      } else {
        fail++; process.exitCode = 1
        console.log('  [FAIL] ' + n + ' ' + (x || ''))
      }
    }
    // 启动页现在是 home 仪表盘（B8）——空库引导在库页，先导航过去
    // 先等应用就绪（原来这里是固定 2500ms）：慢机上侧栏还没渲染就点导航会拿到 'no'。
    await waitFor(() => ev('!!(window.hh && document.querySelector(".sidebar .nav-item"))'), { timeoutMs: 30000, label: '应用就绪（hh + 侧栏导航）' })
    const nav = await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => (x.textContent || '').includes('全部游戏') || (x.textContent || '').includes('Library')); if (b) { b.click(); return 'ok' } return 'no' })()`)
    if (nav !== 'ok') console.log('  [warn] 未能导航到库页：', nav)
    // 等空库引导页出现，再等三步都挂上（原来固定 800 + 手拉循环 + 800ms）
    await waitFor(() => ev('!!document.querySelector(".empty-wrap")'), { timeoutMs: 15000, label: '空库引导页出现（.empty-wrap）' })
    await waitFor(() => ev('document.querySelectorAll(".step").length === 3'), { timeoutMs: 8000, label: '空库引导三步挂载完成' })
    const expr = `JSON.stringify((() => {
      const w = document.querySelector(".empty-wrap")
      const au = document.querySelector(".empty-aurora")
      const card = document.querySelector(".empty")
      const steps = [...document.querySelectorAll(".step")].map(s => s.textContent.trim())
      const cta = document.querySelector(".empty-cta")
      const title = (document.querySelector(".empty-title")||{}).textContent || ""
      return { wrap: !!w, aurora: !!au, card: !!card, steps, cta: cta ? cta.textContent.trim() : "", stepNums: document.querySelectorAll(".step-num").length, title }
    })())`
    const st = JSON.parse(await ev(expr))
    ck('空库引导页渲染', st.wrap && st.card, 'wrap=' + st.wrap + ' card=' + st.card)
    ck('光晕底存在', st.aurora, 'aurora=' + st.aurora)
    ck('三步引导齐全', st.steps.length === 3 && st.stepNums === 3, JSON.stringify(st.steps))
    ck(
      '标题与 i18n 词典 lib_empty 完全相等',
      libEmptyTitles.includes(String(st.title || '').trim()),
      'title=' + JSON.stringify(st.title) + ' 期望=' + JSON.stringify(libEmptyTitles),
    )
    ck('主按钮存在', !!st.cta, 'cta=' + st.cta)
    ck('三步文案非空', st.steps.every((s) => s.length > 2), JSON.stringify(st.steps))
    console.log('  三步:', JSON.stringify(st.steps))
    console.log('  标题:', st.title)
    console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====')
  } finally {
    ws.close()
    killTree(proc)
  }
}
main().catch((e) => {
  console.error(e)
  console.error(stderr.slice(-1500))
  try {
    killTree(proc)
  } catch {
    /* ignore */
  }
  process.exit(1)
})
