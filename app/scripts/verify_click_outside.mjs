// 「点浮层外面收起」的永久回归靶：三个浮层 + 一条跨页边界。
//
// 背景：这三处收起逻辑刚从 document.querySelector('.xxx-wrap') 收口到
// composables/useClickOutside.ts（元素 ref 传进来，选择器只负责样式）。收口解决了
// 「类名成了隐式全局 API」的脆性，但也暴露了一个**跨页状态空洞**：
// 导出菜单的 DOM 在 LibraryToolbar 里、开关状态在 App 里；切到别的页面时组件卸载，
// 状态却留在 App 里为 true —— 回库页时组件重新挂载，菜单又「自己开着」。
// 旧实现是全局监听，切页那一下点击会顺手把它关掉，所以这个空洞一直没被发现。
//
// 本脚本把三处浮层的「打开 → 点空白 → 收起」全部走真实鼠标事件（CDP Input，
// 不是 element.click() 的合成事件），并对跨页边界做两条独立断言：
//   点击切页：打开导出菜单 → 点「下载任务」→ 点「全部游戏」→ 菜单不该残留；
//   快捷键切页：打开导出菜单 → 按 2（下载）→ 按 1（游戏库）→ 菜单不该残留。
// 两条都要有：点击切页那一下本身就是「点外面」，会被 useClickOutside 顺手关掉；
// 快捷键切页没有任何鼠标事件，才是真正会漏进页面切换的那条路（旧实现就漏在这）。
// 用法：node scripts/verify_click_outside.mjs
import { spawn, spawnSync } from 'node:child_process'
import { pickFreePort, killTree } from './lib/probePort.mjs'
import { join } from 'node:path'
import { rmSync, mkdirSync } from 'node:fs'
import { waitFor } from './lib/waitFor.mjs'

const APP_ROOT = join(process.cwd())
const PORT = await pickFreePort()
const DATA_DIR = join(APP_ROOT, '.click-outside-data')
for (let i = 0; i < 5; i++) {
  try {
    rmSync(DATA_DIR, { recursive: true, force: true })
    break
  } catch {
    // 数据目录被上一轮进程占用的重试退避（不是等页面状态）
    await new Promise((r) => setTimeout(r, 800))
  }
}
mkdirSync(join(DATA_DIR, 'covers'), { recursive: true })
mkdirSync(join(DATA_DIR, 'thumbs'), { recursive: true })
spawnSync(process.execPath, [join(APP_ROOT, 'scripts', 'seed_layout.mjs'), DATA_DIR], {
  cwd: APP_ROOT,
  stdio: ['ignore', 'inherit', 'inherit'],
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
proc.stderr.on('data', (d) => {
  stderr += d.toString()
})
/** 清临时数据目录。Windows 上 Electron 子进程刚被杀时目录句柄可能还开着一会儿，
 *  所以带退避重试（这是收尾清理，不是等页面状态）。 */
async function cleanupDataDir() {
  for (let i = 0; i < 8; i++) {
    try {
      rmSync(DATA_DIR, { recursive: true, force: true })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  console.log('[warn] 临时目录清理失败（可手动删）:', DATA_DIR)
}
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
  // DevTools 已在监听 ⇒ /json 立刻可取；下面 /json 循环本身就是条件等待。
  const port = (wsUrl.match(/:(\d+)\//) || [])[1]
  let pageJson = null
  for (let i = 0; i < 20 && !pageJson; i++) {
    try {
      const l = await (await fetch('http://127.0.0.1:' + port + '/json')).json()
      pageJson =
        l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && /index\.html|renderer/.test(t.url || '')) ?? null
      if (!pageJson) pageJson = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
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
  /** 真实鼠标点击（CDP Input）。为什么不用 element.click()：潜台词是「用户点了这里」，
   *  合成事件只有 isTrusted=false 的 click，握不到鼠标按下/移动的时序，
   *  也测不出「浮层自己盖住了点击位置」这类问题。 */
  const mouse = async (x, y, button = 'left') => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 })
  }
  /** 键盘击键（页面级快捷键切页用；必须走 keydown，应用的监听挂在 keydown 上） */
  const key = async (k, code, vk) => {
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
    }
  }
  /** 在封面墙里找一处会命中「非卡片」的空白点：返回点是 elementFromPoint 的命中结果，
   *  所以它一定不是按钮/卡片——点它等于点页面空白，不会顺手触发别的动作。
   *  每次点之前现算：右键菜单会浮在鼠标位置，之前算好的点可能已经落到菜单上。 */
  const findBlank = () =>
    ev(`(() => {
      const wrap = document.querySelector('.cover-wrap')
      if (!wrap) return null
      const r = wrap.getBoundingClientRect()
      const yEnd = Math.min(innerHeight - 2, r.bottom - 2)
      const xEnd = Math.min(innerWidth - 2, r.right - 2)
      for (let y = Math.max(2, r.top + 2); y < yEnd; y += 16) {
        for (let x = Math.max(2, r.left + 2); x < xEnd; x += 16) {
          const el = document.elementFromPoint(x, y)
          if (!el || !wrap.contains(el)) continue
          if (el.closest('.cover-card, .export-menu, .more-menu, .ctx-menu')) continue
          return { x: Math.round(x), y: Math.round(y), hit: String(el.className || el.tagName).slice(0, 40) }
        }
      }
      return null
    })()`)
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
    /** 点页面空白：现算一个空白点，再用真实鼠标点下去。 */
    const clickBlank = async () => {
      const p = await findBlank()
      if (!p) throw new Error('找不到页面空白点（.cover-wrap 里全是卡片？）')
      await mouse(p.x, p.y, 'left')
      return p
    }
    const gone = (sel) => ev(`!document.querySelector(${JSON.stringify(sel)})`)
    const openCount = (sel) => ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`)
    // 启动页是 home 仪表盘——先等应用就绪再导航，慢机上侧栏没渲染就点导航是时序假红
    await waitFor(() => ev('!!(window.hh && document.querySelector(".sidebar .nav-item"))'), { timeoutMs: 30000, label: '应用就绪（hh + 侧栏导航）' })
    const navTo = (label) =>
      ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].filter((x) => !x.closest('.more-menu')).find((x) => (x.textContent || '').includes(${JSON.stringify(label)})); if (b) { b.click(); return 'ok' } return 'no-nav' })()`)
    await navTo('全部游戏')
    await waitFor(() => ev('!!document.querySelector(".cover-card")'), { timeoutMs: 15000, label: '库页封面墙出现（.cover-card）' })
    // ---- 1. 导出菜单 ----
    await ev(`(() => { const b = document.querySelector('.export-wrap button'); if (b) b.click() })()`)
    await waitFor(() => ev('!!document.querySelector(".export-menu")'), { timeoutMs: 5000, label: '导出菜单打开' })
    const expOpen = (await openCount('.export-menu')) === 1
    ck('导出菜单能打开（.export-menu 出现）', expOpen, 'count=' + (await openCount('.export-menu')))
    const p1 = await clickBlank()
    let expClosed = false
    try {
      await waitFor(() => gone('.export-menu'), { timeoutMs: 5000, label: '点空白后导出菜单收起' })
      expClosed = true
    } catch {
      /* 没收起也要继续：下面 ck 报实际状态 */
    }
    ck('点页面空白处收起导出菜单', expClosed, 'blank=' + JSON.stringify(p1) + ' count=' + (await openCount('.export-menu')))
    // ---- 2. 侧栏「更多」菜单 ----
    await ev(`(() => { const b = document.querySelector('.more-toggle'); if (b) b.click() })()`)
    await waitFor(() => ev('!!document.querySelector(".more-menu")'), { timeoutMs: 5000, label: '侧栏「更多」菜单打开' })
    const moreOpen = (await openCount('.more-menu')) === 1
    ck('侧栏「更多」菜单能打开（.more-menu 出现）', moreOpen, 'count=' + (await openCount('.more-menu')))
    const p2 = await clickBlank()
    let moreClosed = false
    try {
      await waitFor(() => gone('.more-menu'), { timeoutMs: 5000, label: '点空白后「更多」菜单收起' })
      moreClosed = true
    } catch {
      /* 没收起也要继续 */
    }
    ck('点页面空白处收起侧栏「更多」菜单', moreClosed, 'blank=' + JSON.stringify(p2) + ' count=' + (await openCount('.more-menu')))
    // ---- 3. 封面右键菜单（Teleport 到 body）----
    const cardPoint = await ev(`(() => {
      const c = document.querySelector('.cover-card')
      if (!c) return null
      const r = c.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 40) }
    })()`)
    if (cardPoint) await mouse(cardPoint.x, cardPoint.y, 'right')
    let ctxOpened = false
    try {
      await waitFor(() => ev('!!document.querySelector(".ctx-menu")'), { timeoutMs: 5000, label: '封面右键菜单打开' })
      ctxOpened = true
    } catch {
      /* 没打开也要继续：下面 ck 会报出来 */
    }
    ck('封面右键菜单能打开（.ctx-menu 出现）', ctxOpened, 'card=' + JSON.stringify(cardPoint) + ' count=' + (await openCount('.ctx-menu')))
    const p3 = await clickBlank()
    let ctxClosed = false
    try {
      await waitFor(() => gone('.ctx-menu'), { timeoutMs: 5000, label: '点空白后右键菜单收起' })
      ctxClosed = true
    } catch {
      /* 没收起也要继续 */
    }
    ck('点页面空白处收起封面右键菜单', ctxClosed, 'blank=' + JSON.stringify(p3) + ' count=' + (await openCount('.ctx-menu')))
    // ---- 4. 跨页边界（点击切页）：菜单状态不该活过组件卸载 ----
    await ev(`(() => { const b = document.querySelector('.export-wrap button'); if (b) b.click() })()`)
    await waitFor(() => ev('!!document.querySelector(".export-menu")'), { timeoutMs: 5000, label: '跨页前导出菜单打开' })
    const navDownload = await navTo('下载任务')
    await waitFor(() => ev('!!document.querySelector(".dl-layout")'), { timeoutMs: 8000, label: '切到下载任务页（.dl-layout）' })
    const navBack = await navTo('全部游戏')
    await waitFor(() => ev('!!document.querySelector(".cover-wrap")'), { timeoutMs: 8000, label: '切回库页（.cover-wrap）' })
    await waitFor(() => ev('!!document.querySelector(".cover-card")'), { timeoutMs: 15000, label: '回库页后封面墙重新渲染' })
    // 这里不「等菜单消失」：残留恰恰是本脚本要抓的缺陷，等它消失就等于把断言变空。
    const residual1 = await openCount('.export-menu')
    ck(
      '跨页（点击切页）回来后导出菜单没有残留',
      residual1 === 0,
      'count=' + residual1 + ' nav=' + navDownload + '/' + navBack,
    )
    // ---- 5. 跨页边界（快捷键切页）：这条没有鼠标点击顺带关菜单 ----
    await ev(`(() => { const b = document.querySelector('.export-wrap button'); if (b) b.click() })()`)
    await waitFor(() => ev('!!document.querySelector(".export-menu")'), { timeoutMs: 5000, label: '快捷键切页前导出菜单打开' })
    await key('2', 'Digit2', 50)
    await waitFor(() => ev('!!document.querySelector(".dl-layout")'), { timeoutMs: 8000, label: '按 2 切到下载任务页（.dl-layout）' })
    await key('1', 'Digit1', 49)
    await waitFor(() => ev('!!document.querySelector(".cover-wrap")'), { timeoutMs: 8000, label: '按 1 切回库页（.cover-wrap）' })
    await waitFor(() => ev('!!document.querySelector(".cover-card")'), { timeoutMs: 15000, label: '快捷键回库页后封面墙重新渲染' })
    const residual2 = await openCount('.export-menu')
    ck('跨页（快捷键切页）回来后导出菜单没有残留', residual2 === 0, 'count=' + residual2)
    console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====')
  } finally {
    ws.close()
    killTree(proc)
    await cleanupDataDir()
  }
}
main().catch(async (e) => {
  console.error(e)
  console.error(stderr.slice(-1200))
  try {
    killTree(proc)
  } catch {
    /* ignore */
  }
  await cleanupDataDir()
  process.exit(1)
})
