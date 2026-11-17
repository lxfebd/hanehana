// 详情面板头部（零高度浮层）的永久回归靶：把「修复者口头验过」的三个数字钉进闸门。
//
// 背景：.dp-head-actions 旧写法是 sticky + margin-bottom:-40px（40 = 按钮行 28 + 12
// 手算让位），按钮尺寸一改整个面板头部就会跳位；现在改成 height:0 + pointer-events
// 分离（锚点不占布局、按钮自己开回命中测试）。改完时人工量过一遍（抽屉 banner 距顶 9 /
// 首颗按钮 13；整页 17 / 17；elementFromPoint 命中自身），但工程里没有任何断言——
// 下一个人调 --hh-space-* 或按钮尺寸时，这里会第一个红。
//
// 断言口径（全部带 ±1 容差，Message 里打印实测 rect，红了不用重跑就能定位）：
//   抽屉态：banner 顶边距面板顶 9±1；首颗 .dp-icon-btn top 13±1；elementFromPoint
//           命中按钮自身（pointer-events 分离没坏，按钮看得见也点得到）。
//   整页态：banner 17±1；按钮 17±1；按钮矩形不超出面板；elementFromPoint 仍命中自身。
// 用法：node scripts/verify_panel_head.mjs
import { spawn, spawnSync } from 'node:child_process'
import { pickFreePort, killTree } from './lib/probePort.mjs'
import { join } from 'node:path'
import { rmSync, mkdirSync } from 'node:fs'
import { waitFor } from './lib/waitFor.mjs'

const APP_ROOT = join(process.cwd())
const PORT = await pickFreePort()
const DATA_DIR = join(APP_ROOT, '.panel-head-data')
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
    /** 等布局读数落定：连续两次读数相同才返回（都走 waitFor，不用固定 sleep——
     *  整页展开是 View Transition，动画进行中量到的是中间值）。超时也把最后
     *  一次读数带回去：断言消息里必须有实测 rect，红了不用重跑就能定位。 */
    const settled = async (measure, label, timeoutMs = 8000) => {
      let last = null
      let prev = null
      try {
        await waitFor(async () => {
          last = await measure()
          if (!last) return false
          const same = prev !== null && JSON.stringify(last) === JSON.stringify(prev)
          prev = last
          return same
        }, { timeoutMs, intervalMs: 150, label })
      } catch {
        /* 读数没落定也要继续：last 交给断言，失败信息里有实测值 */
      }
      return last
    }
    // 面板头部三个数字的读数器（抽屉/整页通用：只读 .detail-panel 内的几何）
    const MEASURE = `JSON.stringify((() => {
      const panel = document.querySelector('.detail-panel')
      const banner = panel && panel.querySelector('.banner')
      const btn = panel && panel.querySelector('.dp-icon-btn')
      if (!panel || !banner || !btn) return null
      const pr = panel.getBoundingClientRect()
      const br = banner.getBoundingClientRect()
      const brn = btn.getBoundingClientRect()
      const cx = brn.left + brn.width / 2, cy = brn.top + brn.height / 2
      const hit = document.elementFromPoint(cx, cy)
      return {
        expanded: panel.classList.contains('is-expanded'),
        bannerTop: +(br.top - pr.top).toFixed(1),
        btnTop: +(brn.top - pr.top).toFixed(1),
        btnRect: [brn.left, brn.top, brn.right, brn.bottom].map((v) => Math.round(v)).join(','),
        panelRect: [pr.left, pr.top, pr.right, pr.bottom].map((v) => Math.round(v)).join(','),
        hitSelf: !!(hit && (hit === btn || btn.contains(hit))),
        hitDesc: hit ? String(hit.className || hit.tagName).slice(0, 30) : 'null',
      }
    })())`
    const read = async () => {
      const raw = await ev(MEASURE)
      return raw ? JSON.parse(raw) : null
    }
    // 启动页是 home 仪表盘——先等应用就绪再导航，慢机上侧栏没渲染就点导航是时序假红
    await waitFor(() => ev('!!(window.hh && document.querySelector(".sidebar .nav-item"))'), { timeoutMs: 30000, label: '应用就绪（hh + 侧栏导航）' })
    await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => (x.textContent || '').includes('全部游戏')); if (b) { b.click(); return 'ok' } return 'no' })()`)
    await waitFor(() => ev('!!document.querySelector(".cover-card")'), { timeoutMs: 15000, label: '库页封面墙出现（.cover-card）' })
    await ev(`(() => { const c = document.querySelector('.cover-card'); if (c) { c.click(); return 'ok' } return 'no-card' })()`)
    await waitFor(() => ev('!!document.querySelector(".detail-panel .banner")'), { timeoutMs: 8000, label: '选中后详情面板 + banner 出现' })
    // ---- 抽屉态 ----
    const drawer = await settled(read, '抽屉态布局读数落定')
    ck('抽屉态渲染（面板 + banner + 首颗按钮齐备）', !!drawer && drawer.expanded === false, JSON.stringify(drawer))
    if (drawer) {
      ck(
        '抽屉态 banner 顶边距面板顶 = 9±1',
        Math.abs(drawer.bannerTop - 9) <= 1,
        '实测 bannerTop=' + drawer.bannerTop + ' panelRect=[' + drawer.panelRect + ']',
      )
      ck(
        '抽屉态首颗 .dp-icon-btn top = 13±1',
        Math.abs(drawer.btnTop - 13) <= 1,
        '实测 btnTop=' + drawer.btnTop + ' btnRect=[' + drawer.btnRect + '] panelRect=[' + drawer.panelRect + ']',
      )
      ck(
        '抽屉态 elementFromPoint 命中按钮自身（pointer-events 分离没坏）',
        drawer.hitSelf === true,
        'hit=' + drawer.hitDesc + ' btnRect=[' + drawer.btnRect + ']',
      )
      console.log('  抽屉态实测:', JSON.stringify(drawer))
    }
    // ---- 点「整页展开」→ 整页态 ----
    // 展开走 View Transition：过渡期间 ::view-transition 快照层会接住 elementFromPoint
    // （命中直接返回 documentElement，实测 t=0~370ms 一直是 HTML），而伪元素动画在
    // 前 300ms 甚至还没创建，抓不到一个稳定的「过渡中」条件。这里显式切到「减少动效」
    // 分支：组件在那个分支里同步切 expanded（形态切换是功能，动画只是装饰），
    // 布局与过渡结束态是同一份，只是没有快照层来干扰命中测试。
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await waitFor(() => ev('matchMedia("(prefers-reduced-motion: reduce)").matches'), { timeoutMs: 5000, label: '减少动效仿真生效' })
    const clicked = await ev(`(() => { const b = [...document.querySelectorAll('.detail-panel .dp-icon-btn')].find(x => (x.getAttribute('aria-label') || '').includes('展开整页')); if (b) { b.click(); return 'ok' } return 'no-btn' })()`)
    await waitFor(() => ev('!!document.querySelector(".detail-panel.is-expanded")'), { timeoutMs: 8000, label: '整页展开生效（.is-expanded）' })
    const full = await settled(read, '整页态布局读数落定')
    ck('整页展开可点（找到「展开整页」按钮）', clicked === 'ok', 'click=' + clicked)
    ck('整页态渲染（is-expanded 就位）', !!full && full.expanded === true, JSON.stringify(full))
    if (full) {
      ck(
        '整页态 banner 顶边距面板顶 = 17±1',
        Math.abs(full.bannerTop - 17) <= 1,
        '实测 bannerTop=' + full.bannerTop + ' panelRect=[' + full.panelRect + ']',
      )
      ck(
        '整页态首颗 .dp-icon-btn top = 17±1',
        Math.abs(full.btnTop - 17) <= 1,
        '实测 btnTop=' + full.btnTop + ' btnRect=[' + full.btnRect + '] panelRect=[' + full.panelRect + ']',
      )
      const [bl, bt, brx, bb] = full.btnRect.split(',').map(Number)
      const [pl, pt, prx, pb] = full.panelRect.split(',').map(Number)
      ck(
        '整页态按钮矩形不超出面板',
        bl >= pl && bt >= pt && brx <= prx && bb <= pb,
        'btnRect=[' + full.btnRect + '] panelRect=[' + full.panelRect + ']',
      )
      ck(
        '整页态 elementFromPoint 命中按钮自身',
        full.hitSelf === true,
        'hit=' + full.hitDesc + ' btnRect=[' + full.btnRect + ']',
      )
      console.log('  整页态实测:', JSON.stringify(full))
    }
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
