// 验证 FullscreenView 剧照舞台（aurora 式客厅主视觉）在真实 App 里渲染正确。
// 断言：进全屏后出现 .fs-stage、中央大封面、左右 ghost、大标题、启动胶囊；
// 方向键切换选中时舞台标题跟随变化；截图存 .shots/fs-stage/。
// 自包含：先 seed_layout 造 12 款有封面游戏再起 App。用法：node scripts/verify_fs_stage.mjs
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { rmSync, mkdirSync } from 'node:fs'

const APP_ROOT = join(process.cwd())
const PORT = 9351
const DATA_DIR = join(APP_ROOT, '.fs-stage-data')
const SHOTS = join(APP_ROOT, '.shots', 'fs-stage')
// 自包含：seed 12 款有封面的游戏（渐变 PNG 封面），不清旧数据以支持反复跑
rmSync(DATA_DIR, { recursive: true, force: true })
const seed = spawnSync(process.execPath, [join(APP_ROOT, 'scripts', 'seed_layout.mjs'), DATA_DIR], {
  cwd: APP_ROOT,
  stdio: ['ignore', 'inherit', 'inherit'],
})
if (seed.status !== 0) throw new Error('seed_layout failed')
mkdirSync(SHOTS, { recursive: true })

const env = {
  ...process.env,
  HANEHANA_DEBUG_PORT: String(PORT),
  HANEHANA_DATA_DIR: DATA_DIR,
  HANEHANA_NO_OS_FULLSCREEN: '1',
}
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
  throw new Error('no DevTools line')
}

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const to = setTimeout(() => reject(new Error('ws timeout')), 10000)
    ws.onopen = () => {
      clearTimeout(to)
      resolve(ws)
    }
    ws.onerror = () => reject(new Error('ws error'))
  })
}

async function main() {
  const wsUrl = await getWsUrl()
  await new Promise((r) => setTimeout(r, 2500))
  const port = (wsUrl.match(/:(\d+)\//) || [])[1]
  let pageJson = null
  for (let i = 0; i < 20 && !pageJson; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      pageJson = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
    } catch {
      /* retry */
    }
    if (!pageJson) await new Promise((r) => setTimeout(r, 500))
  }
  if (!pageJson) throw new Error('no page target')
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
          rej(new Error('cdp timeout: ' + method))
        }
      }, 30000)
    })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.exception?.description ?? 'eval failed') }
    return r.result?.result?.value
  }
  const shot = async (name) => {
    try {
      const r = await send('Page.captureScreenshot', { format: 'png' })
      if (r?.result?.data) {
        const fs = await import('node:fs')
        fs.writeFileSync(join(SHOTS, name), Buffer.from(r.result.data, 'base64'))
        console.log(`  [shot] ${name}`)
      }
    } catch (e) {
      console.log(`  [shot-fail] ${name}: ${e.message}`)
    }
  }

  try {
    let pass = 0
    let fail = 0
    const ck = (name, cond, extra = '') => {
      if (cond) {
        pass++
        console.log(`  [PASS] ${name}`)
      } else {
        fail++
        console.log(`  [FAIL] ${name} ${extra ? ':: ' + extra : ''}`)
      }
    }

    // 加载游戏库（直接用主进程 listGames 检查有数据后再进全屏）
    const games = await ev(`window.hh.listGames()`)
    ck('库有游戏', Array.isArray(games) && games.length > 0, `len=${Array.isArray(games) ? games.length : 'n/a'}`)
    // 从侧栏「更多 → 全屏模式」进入（走 enterFullscreen 完整链路，设置 ui.fullscreen）
    const entered = await ev(`(() => {
      const more = [...document.querySelectorAll('.nav-item')].find(b => (b.textContent||'').includes('更多') || (b.textContent||'').includes('More'))
      if (more) more.click()
      return 'more-clicked'
    })()`)
    await new Promise((r) => setTimeout(r, 500))
    const fsClicked = await ev(`(() => {
      const item = [...document.querySelectorAll('.more-menu .nav-item')].find(b => (b.textContent||'').includes('全屏') || (b.textContent||'').includes('Fullscreen'))
      if (item) { item.click(); return 'fs-clicked' }
      return 'fs-miss: ' + [...document.querySelectorAll('.more-menu .nav-item')].map(b=>b.textContent.trim()).join(',')
    })()`)
    console.log('  enter-fullscreen:', fsClicked)
    await new Promise((r) => setTimeout(r, 1500))
    ck('全屏状态已置', typeof fsClicked === 'string' && fsClicked.startsWith('fs-clicked'), `fsClicked=${fsClicked}`)
    const hasFs = await ev(`!!document.querySelector('.fs-root')`)
    ck('全屏层挂载', hasFs === true, `hasFs=${hasFs}`)
    if (hasFs !== true) {
      console.log('  全屏层未挂载，跳过断言')
      return
    }

    // 剧照舞台元素断言
    const st = JSON.parse(await ev(`JSON.stringify((() => {
      const stage = document.querySelector('.fs-stage')
      const cover = document.querySelector('.fs-stage-cover')
      const coverImg = document.querySelector('.fs-stage-cover img')
      const ghosts = document.querySelectorAll('.fs-ghost').length
      const title = document.querySelector('.fs-stage-title')
      const play = document.querySelector('.fs-stage-play')
      const fav = document.querySelector('.fs-stage-fav')
      const track = document.querySelector('.fs-scroller')
      const cards = document.querySelectorAll('.fs-card').length
      return {
        stage: !!stage, cover: !!cover, coverImg: !!coverImg, ghosts,
        title: title ? title.textContent.trim() : '',
        play: !!play, fav: !!fav, track: !!track, cards,
        coverW: cover ? cover.offsetWidth : 0, coverH: cover ? cover.offsetHeight : 0,
        ghLeft: !!document.querySelector('.fs-ghost.left'),
        ghRight: !!document.querySelector('.fs-ghost.right'),
      }
    })())`))
    ck('剧照舞台存在', st.stage, `stage=${st.stage}`)
    ck('中央大封面存在', st.cover && st.coverImg, `cover=${st.cover} img=${st.coverImg}`)
    // 边界：首张没有前一款 → ghost 可 1 个（只有右）；中间应 2 个
    ck('ghost 封面存在（首张≥1）', st.ghosts >= 1 && (st.ghLeft || st.ghRight), `ghosts=${st.ghosts} left=${st.ghLeft} right=${st.ghRight}`)
    ck('大标题有内容', st.title.length > 0, `title=${st.title.slice(0, 30)}`)
    ck('启动胶囊键存在', st.play, `play=${st.play}`)
    ck('收藏按钮存在', st.fav, `fav=${st.fav}`)
    ck('封面轨仍在（虚拟化）', st.track && st.cards > 0, `cards=${st.cards}`)
    ck('中央封面是竖版大图', st.coverW >= 180 && st.coverH > st.coverW, `${st.coverW}x${st.coverH}`)

    // 几何断言（vision 截图不可用时的证据）：舞台在上、封面轨在下、互不重叠、全在视口内
    const geo = JSON.parse(await ev(`JSON.stringify((() => {
      const r = (s) => { const el = document.querySelector(s); if (!el) return null; const b = el.getBoundingClientRect(); return { y: b.y, h: b.height, bottom: b.bottom, x: b.x, right: b.right, w: b.width } }
      const stage = r('.fs-stage')
      const track = r('.fs-scroller')
      const play = r('.fs-stage-play')
      const title = r('.fs-stage-title')
      const bar = r('.fs-bar')
      return {
        stage, track, play, title, bar,
        winW: window.innerWidth, winH: window.innerHeight,
        trackH: track ? track.h : 0,
        stageGetsRest: stage && track ? stage.h > track.h : false,
        noOverlap: stage && track ? stage.bottom <= track.y + 1 : false,
        barAbove: bar && stage ? bar.bottom <= stage.y + 1 : false,
        inViewport: stage && track && play && title
          ? stage.y >= -1 && track.bottom <= window.innerHeight + 1 && play.right <= window.innerWidth + 1 && title.x >= -1
          : false,
        titleCentered: title ? Math.abs((title.x + title.right) / 2 - window.innerWidth / 2) < 160 : false,
      }
    })())`))
    ck('舞台占主区（比封面轨高）', geo.stageGetsRest, `stageH=${geo.stage?.h} trackH=${geo.trackH}`)
    ck('舞台与封面轨无重叠', geo.noOverlap, `stageBottom=${geo.stage?.bottom} trackY=${geo.track?.y}`)
    ck('顶部操作条在舞台之上', geo.barAbove, `barBottom=${geo.bar?.bottom} stageY=${geo.stage?.y}`)
    ck('关键元素在视口内', geo.inViewport, JSON.stringify({ winW: geo.winW, winH: geo.winH, trackBottom: geo.track?.bottom }))
    ck('大标题水平居中', geo.titleCentered, JSON.stringify(geo.title))
    await shot('1b_stage_geometry.png')
    const firstTitle = st.title

    // 方向键切换：标题应跟随变化
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 })
    await new Promise((r) => setTimeout(r, 800))
    const title2 = await ev(`document.querySelector('.fs-stage-title')?.textContent?.trim() || ''`)
    ck('方向键切换剧照标题跟随', title2 !== '' && title2 !== firstTitle, `before=${firstTitle.slice(0, 20)} after=${title2.slice(0, 20)}`)
    await shot('2_stage_next.png')

    console.log(`\n==== ${pass} passed, ${fail} failed ====`)
  } finally {
    ws.close()
    proc.kill()
  }
}

main().catch((e) => {
  console.error(e)
  console.error('--- stderr tail ---')
  console.error(stderr.slice(-2000))
  try {
    proc.kill()
  } catch {
    /* ignore */
  }
  process.exit(1)
})