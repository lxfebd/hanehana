// 游戏站渲染验证：webview 内嵌浏览器挂载 + 搜索框 + 站点来源
// 用法：node scripts/verify_gamesites.mjs
import { spawn, spawnSync } from 'node:child_process'
import { pickFreePort, killTree } from './lib/probePort.mjs'
import { join } from 'node:path'
import { rmSync, mkdirSync } from 'node:fs'
import { tryWaitFor } from './lib/waitFor.mjs'

const APP_ROOT = join(process.cwd())
const PORT = await pickFreePort()
const DATA_DIR = join(APP_ROOT, '.sites-data')
for (let i = 0; i < 5; i++) {
  try {
    rmSync(DATA_DIR, { recursive: true, force: true })
    break
  } catch {
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
  await new Promise((r) => setTimeout(r, 2500))
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
    for (let i = 0; i < 20; i++) {
      const e = await ev('!!window.hh')
      if (e) break
      await new Promise((r) => setTimeout(r, 500))
    }
    await new Promise((r) => setTimeout(r, 800))
    // 切到游戏站（侧栏一级入口「游戏站」——已从「更多」菜单提出来，对用户可见可点）
    await ev(`(() => { const t = document.querySelector('[data-testid="nav-games"]'); if (t) { t.click(); return 'ok' } return 'no-sites' })()`)
    await new Promise((r) => setTimeout(r, 2000))
    const st = JSON.parse(
      await ev(`JSON.stringify((() => {
        const wv = document.querySelector('webview')
        const inputs = [...document.querySelectorAll('input')].map(i => i.placeholder).filter(Boolean)
        const body = document.body.innerText
        return {
          webview: !!wv,
          wvSrc: wv ? (wv.getAttribute('src') || '').slice(0, 40) : '',
          inputs,
          hasGamer: body.includes('Gamer520') || body.includes('gamer'),
          hasNeko: body.includes('NekoGAL') || body.includes('neko'),
          hasPlayzip: body.includes('PlayZip') || body.includes('playzip'),
        }
      })())`),
    )
    ck('内嵌 webview 挂载', st.webview === true, 'webview=' + st.webview)
    ck('webview 有目标站点 src', (st.wvSrc || '').length > 0, 'src=' + st.wvSrc)
    ck('搜索输入框存在', (st.inputs || []).length > 0, 'inputs=' + JSON.stringify(st.inputs))
    ck('站点聚合入口（Gamer520/NekoGAL/PlayZip 至少可见）', st.hasGamer || st.hasNeko || st.hasPlayzip, 'gamer=' + st.hasGamer + ' neko=' + st.hasNeko + ' playzip=' + st.hasPlayzip)
    console.log('  游戏站:', JSON.stringify({ webview: st.webview, src: st.wvSrc, inputs: st.inputs }))

    // ---- 侧栏可收：下载站是宽内容页，144px 侧栏在 1280 窗里占掉整窗约 10%；
    //      收起成 56px 图标条后内嵌站点应当多出至少 80px 横向空间（回归靶）。
    const dimsExpr = `(() => {
      const sb = document.querySelector('.sidebar')
      const wv = document.querySelector('webview')
      const label = document.querySelector('.sidebar .nav-item span')
      return JSON.stringify({
        sidebar: sb ? Math.round(sb.getBoundingClientRect().width) : -1,
        rail: !!(sb && sb.classList.contains('rail')),
        webview: wv ? Math.round(wv.getBoundingClientRect().width) : -1,
        labelShown: label ? getComputedStyle(label).display !== 'none' : null,
        toggles: document.querySelectorAll('.rail-toggle').length,
      })
    })()`
    const before = JSON.parse(await ev(dimsExpr))
    await ev(`(() => { const b = document.querySelector('.rail-toggle'); if (b) { b.click(); return 'ok' } return 'no' })()`)
    await new Promise((r) => setTimeout(r, 700))
    const after = JSON.parse(await ev(dimsExpr))
    ck('侧栏有收起/展开按钮', before.toggles === 1, 'toggles=' + before.toggles)
    ck('默认展开：侧栏 144px 且标签可见', before.sidebar === 144 && before.labelShown === true, JSON.stringify(before))
    ck('收起后侧栏变 56px 图标条且标签隐藏', after.sidebar === 56 && after.rail === true && after.labelShown === false, JSON.stringify(after))
    ck(
      '收起后下载站多出 ≥80px 横向空间',
      after.webview - before.webview >= 80,
      'before=' + before.webview + ' after=' + after.webview + ' 差=' + (after.webview - before.webview),
    )
    await ev(`(() => { const b = document.querySelector('.rail-toggle'); if (b) { b.click(); return 'ok' } return 'no' })()`)
    await new Promise((r) => setTimeout(r, 700))
    const back = JSON.parse(await ev(dimsExpr))
    ck('再点一次展开：侧栏回到 144px', back.sidebar === 144 && back.rail === false, JSON.stringify(back))

    // ---- B4：820 宽不再自动收（自动 rail 已删除）----
    // 回归靶：旧实现 `rail = ui.navCollapsed || narrow`（matchMedia ≤860px）在窄窗
    // 把侧栏收成 56——此时点按钮视觉上没有任何变化，却把 navCollapsed='1' 落盘，
    // 拉宽后侧栏仍旧收着（与注释承诺的「拉宽自己回来」相反）；860→861 那一格
    // 侧栏 56→144，主列在一像素内少 87px（断崖）。窗口 minWidth 是 800，
    // 800 宽下 144 侧栏 + 右栏 clamp(300, 32vw, 400) 仍排得下。
    // 这里在 820 量三件事：不自动收、无横向溢出、按钮两个方向都真的有效果。
    await send('Emulation.setDeviceMetricsOverride', { width: 820, height: 900, deviceScaleFactor: 1, mobile: false })
    await tryWaitFor(() => ev('window.innerWidth === 820'), { timeoutMs: 5000, label: '820 视口重排生效' })
    const at820 = JSON.parse(await ev(dimsExpr))
    const overflow820 = await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth')
    ck('820 宽不自动收：侧栏仍是 144px 且未进 rail', at820.sidebar === 144 && at820.rail === false, JSON.stringify(at820))
    ck('820 宽无横向溢出', typeof overflow820 === 'number' && overflow820 <= 1, 'doc 溢出=' + overflow820)
    await ev(`(() => { const b = document.querySelector('.rail-toggle'); if (b) { b.click(); return 'ok' } return 'no' })()`)
    await tryWaitFor(
      () => ev(`(() => { const sb = document.querySelector('.sidebar'); return !!sb && Math.round(sb.getBoundingClientRect().width) === 56 })()`),
      { timeoutMs: 4000, label: '820 宽点击后收成 56px' },
    )
    const collapsed820 = JSON.parse(await ev(dimsExpr))
    await ev(`(() => { const b = document.querySelector('.rail-toggle'); if (b) { b.click(); return 'ok' } return 'no' })()`)
    await tryWaitFor(
      () => ev(`(() => { const sb = document.querySelector('.sidebar'); return !!sb && Math.round(sb.getBoundingClientRect().width) === 144 })()`),
      { timeoutMs: 4000, label: '820 宽再点展开回 144px' },
    )
    const expanded820 = JSON.parse(await ev(dimsExpr))
    ck(
      '820 宽按钮点了能收起/展开（56 ⇄ 144，双向都有反馈）',
      collapsed820.sidebar === 56 &&
        collapsed820.rail === true &&
        expanded820.sidebar === 144 &&
        expanded820.rail === false,
      JSON.stringify({ collapsed820, expanded820 }),
    )
    await send('Emulation.clearDeviceMetricsOverride')
    await tryWaitFor(() => ev('window.innerWidth !== 820'), { timeoutMs: 5000, label: '恢复窗口宽度' })

    // ---- B3：rail 下「更多」菜单的锚点与标签 ----
    // 旧实现两处一起错（都在 NavSidebar.vue 的样式里）：
    //   1. `.sidebar.rail .nav-item span { display: none }` 不带 `>`，把 .more-menu 里
    //      四个条目的标签一起隐藏——rail 下打开「更多」只剩四个图标、没有文字；
    //   2. `.more-menu { left: calc(100% + 8px) }` 相对的是收窄后的 .more-wrap（宽 40），
    //      菜单左缘落在侧栏右缘附近，实测压住侧栏 6px。
    // 修法：选择器带 `>` 只打侧栏直属条目；rail 下 .more-wrap 改为 position: static，
    // 让 100% 以 .sidebar 为基准 → 菜单在侧栏右侧 8px 处。这里两条都钉成断言。
    await ev(`(() => { const b = document.querySelector('.rail-toggle'); if (b) { b.click(); return 'ok' } return 'no' })()`)
    await tryWaitFor(
      () => ev(`(() => { const sb = document.querySelector('.sidebar'); return !!sb && sb.classList.contains('rail') })()`),
      { timeoutMs: 4000, label: '侧栏进 rail 态' },
    )
    await ev(`(() => { const b = document.querySelector('[data-testid="nav-more"]'); if (b) { b.click(); return 'ok' } return 'no' })()`)
    await tryWaitFor(() => ev('!!document.querySelector(".more-menu")'), { timeoutMs: 4000, label: 'rail 下更多菜单打开' })
    const menu = JSON.parse(await ev(`(() => {
      const sb = document.querySelector('.sidebar')
      const m = document.querySelector('.more-menu')
      if (!sb || !m) return JSON.stringify({ found: false })
      const sr = sb.getBoundingClientRect()
      const mr = m.getBoundingClientRect()
      const items = [...m.querySelectorAll('.nav-item')].map((b) => {
        const s = b.querySelector('span')
        return { text: s ? (s.textContent || '').trim() : '', shown: s ? getComputedStyle(s).display !== 'none' : false }
      })
      // 菜单得真的能点：中心点 elementFromPoint 命中菜单自身/后代，不能是内容区
      // （menu 在 .sidebar 的层叠上下文里，z-index popover；这条防「画出来了但被盖住」）
      const hit = document.elementFromPoint(Math.round(mr.left + mr.width / 2), Math.round(mr.top + mr.height / 2))
      return JSON.stringify({
        found: true,
        sbRight: Math.round(sr.right),
        menuLeft: Math.round(mr.left),
        gap: Math.round(mr.left - sr.right),
        w: Math.round(mr.width),
        hitSelf: !!hit && (hit === m || m.contains(hit)),
        items,
      })
    })()`))
    ck('rail 下「更多」菜单不被侧栏压住（左缘 ≥ 侧栏右缘 + 6px）', menu.found === true && menu.gap >= 6, JSON.stringify(menu))
    ck(
      'rail 下「更多」菜单四条目文字仍可见（rail 规则没误伤菜单）',
      menu.found === true && menu.items.length === 4 && menu.items.every((i) => i.shown && i.text.length > 0),
      JSON.stringify(menu.items),
    )
    ck('rail 下「更多」菜单真的可点（中心点命中菜单自身，没被内容区盖住）', menu.found === true && menu.hitSelf === true, JSON.stringify(menu))
    // 恢复现场：先关菜单，再把侧栏展开（后面接手的人/闸门从默认态开始）
    await ev(`(() => { const b = document.querySelector('[data-testid="nav-more"]'); if (b) { b.click(); return 'ok' } return 'no' })()`)
    await tryWaitFor(() => ev('!document.querySelector(".more-menu")'), { timeoutMs: 3000, label: '更多菜单收起' })
    await ev(`(() => { const b = document.querySelector('.rail-toggle'); if (b) { b.click(); return 'ok' } return 'no' })()`)
    await tryWaitFor(
      () => ev(`(() => { const sb = document.querySelector('.sidebar'); return !!sb && !sb.classList.contains('rail') })()`),
      { timeoutMs: 4000, label: '恢复展开态' },
    )
    console.log('  rail 更多菜单:', JSON.stringify({ gap: menu.gap, sbRight: menu.sbRight, menuLeft: menu.menuLeft }))
    console.log('  820 宽:', JSON.stringify({ at820, overflow820, collapsed820, expanded820 }))
    console.log('  侧栏弹性:', JSON.stringify({ before, after }))
    console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====')
  } finally {
    ws.close()
    killTree(proc)
  }
}
main().catch((e) => {
  console.error(e)
  console.error(stderr.slice(-1200))
  try {
    killTree(proc)
  } catch {
    /* ignore */
  }
  process.exit(1)
})