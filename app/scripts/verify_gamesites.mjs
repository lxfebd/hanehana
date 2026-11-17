// 游戏站渲染验证：webview 内嵌浏览器挂载 + 搜索框 + 站点来源
// 用法：node scripts/verify_gamesites.mjs
import { spawn, spawnSync } from 'node:child_process'
import { pickFreePort, killTree } from './lib/probePort.mjs'
import { join } from 'node:path'
import { rmSync, mkdirSync } from 'node:fs'

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