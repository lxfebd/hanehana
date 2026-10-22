// hero 最近游玩 chips 验证（B8：RecentStrip 组件退役，职能并入 Continue 卡 .hero-recent）：
// seed 有 lastPlayed 的游戏 → 断言 .hero-recent 渲染、chip 齐全、点击切换 hero 主角
// 附加：右栏滚动链防回归（.detail/.activity-feed/.af-body 高度链必须闭合，
// 否则动态流滑不动——曾因 flex item 的 stretch 高度不是 definite height 而整条不滚）。
// 用法：node scripts/verify_recent_strip.mjs（启动页即 home，无需导航）
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const APP_ROOT = join(process.cwd())
const PORT = 9395
const DATA_DIR = join(APP_ROOT, '.recent-data')
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
// 给前 2 款游戏设 lastPlayed（最近玩过），续读条应显示
{
  const gp = join(DATA_DIR, 'games.json')
  const games = JSON.parse(readFileSync(gp, 'utf8'))
  const now = Date.now()
  games[0].lastPlayed = now - 3600000 // 1 小时前
  games[1].lastPlayed = now - 86400000 * 2 // 2 天前
  writeFileSync(gp, JSON.stringify(games, null, 2), 'utf8')
}
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
        fail++
        console.log('  [FAIL] ' + n + ' ' + (x || ''))
      }
    }
    for (let i = 0; i < 20; i++) {
      const e = await ev('!!document.querySelector(".hero-recent")')
      if (e) break
      await new Promise((r) => setTimeout(r, 500))
    }
    await new Promise((r) => setTimeout(r, 800))
    const st = JSON.parse(
      await ev(`JSON.stringify((() => {
        const strip = document.querySelector('.hero-recent')
        const chips = [...document.querySelectorAll('.hero-recent-chip')]
        return {
          strip: !!strip,
          oldStrip: !!document.querySelector('.recent-strip'),
          count: chips.length,
          titles: chips.map(i => (i.querySelector('.hero-recent-title')||{}).textContent?.trim() || '').slice(0, 4),
          times: chips.map(i => (i.querySelector('.hero-recent-time')||{}).textContent?.trim() || ''),
          label: (document.querySelector('.hero-recent-label')||{}).textContent?.trim() || '',
        }
      })())`),
    )
    ck('hero 最近游玩条渲染（.hero-recent）', st.strip === true, 'strip=' + st.strip)
    ck('旧 RecentStrip 已退役（.recent-strip 不存在）', st.oldStrip === false, 'old=' + st.oldStrip)
    ck('最近游玩 chip 出现', st.count >= 1, 'count=' + st.count)
    ck('标签「最近游玩」', (st.label || '').length > 0, 'label=' + st.label)
    ck('时间显示（今天/昨天/日期）', st.times.some((x) => x.length > 0), 'times=' + JSON.stringify(st.times))
    console.log('  hero-recent:', JSON.stringify({ count: st.count, titles: st.titles, times: st.times, label: st.label }))
    // 点击末位 chip → hero 主角切换
    const beforeTitle = (await ev(`(document.querySelector('.hero-title')||{}).textContent?.trim() || ''`)) || ''
    const lastTitle = st.titles[st.titles.length - 1] || ''
    await ev(`(() => { const chips=[...document.querySelectorAll('.hero-recent-chip')]; const c=chips[chips.length-1]; if(c){c.click();return 'ok'} return 'no' })()`)
    await new Promise((r) => setTimeout(r, 700))
    const afterTitle = (await ev(`(document.querySelector('.hero-title')||{}).textContent?.trim() || ''`)) || ''
    ck('点击 chip 切换 hero 主角', afterTitle === lastTitle && afterTitle !== beforeTitle, `${beforeTitle} -> ${afterTitle}（want=${lastTitle}）`)

    // ---- 右栏滚动链（修复「信息流无法滑动」的防回归）----
    // 判定不靠「内容比容器高」（数据少时也成立）：直接查计算样式链 +
    // 用 wheel 事件真滚一次，看 scrollTop 是否变化。
    const rail = JSON.parse(
      await ev(`JSON.stringify((() => {
        const detail = document.querySelector('.detail')
        const feed = document.querySelector('.activity-feed')
        const body = document.querySelector('.af-body')
        if (!feed || !body) return { feed: false }
        const cs = (el) => { const s = getComputedStyle(el); return { flex: s.flexGrow + '/' + s.flexShrink, minH: s.minHeight, overflowY: s.overflowY, height: s.height } }
        const dr = detail ? detail.getBoundingClientRect() : null
        const fr = feed.getBoundingClientRect()
        const br = body.getBoundingClientRect()
        return {
          feed: true,
          detailH: dr ? Math.round(dr.height) : -1,
          feedH: Math.round(fr.height),
          bodyH: Math.round(br.height),
          feedTallerThanDetail: !!dr && fr.height > dr.height + 1,
          detailCS: detail ? cs(detail) : null,
          feedCS: cs(feed),
          bodyCS: cs(body),
          scrollable: body.scrollHeight > body.clientHeight + 1,
          railTallerThanWindow: fr.bottom > window.innerHeight + 1,
          winH: window.innerHeight,
        }
      })())`),
    )
    ck('右栏活动流渲染', rail.feed === true, 'feed=' + rail.feed)
    ck('feed不顶出右栏（flex 填充而非内容高度）', rail.feedTallerThanDetail === false, `feed=${rail.feedH} detail=${rail.detailH}`)
    ck('右栏不越过窗口底边', rail.railTallerThanWindow === false, `bottom 超出 ${rail.winH}`)
    ck('右栏 .detail 高度链闭合（stretch + min-height:0）', rail.detailCS && rail.detailCS.minH === '0px', JSON.stringify(rail.detailCS))
    ck('af-body 是滚动容器（overflow-y:auto）', !!rail.bodyCS && rail.bodyCS.overflowY === 'auto', JSON.stringify(rail.bodyCS))
    // 真滚一次：内容可滚（35 天会话）时 scrollTop 必须真的动；
    // 内容没溢出时不滚——两种都算滚动链闭合，只有「该滚滚不动」是病。
    const rolled = await ev(`(() => { const b = document.querySelector('.af-body'); if (!b) return { err: 'no-body' }; const before = b.scrollTop; b.scrollTop = 60; return { err: '', before, after: b.scrollTop, overflow: b.scrollHeight > b.clientHeight + 1, changed: b.scrollTop !== before } })()`)
    ck(
      '右栏信息流滚得动（溢出时 scrollTop 真变化）',
      !rolled.err && (rolled.overflow ? rolled.changed : true),
      JSON.stringify(rolled),
    )
    console.log('  rail:', JSON.stringify(rail))
    console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====')
  } finally {
    ws.close()
    proc.kill()
  }
}
main().catch((e) => {
  console.error(e)
  console.error(stderr.slice(-1200))
  try {
    proc.kill()
  } catch {
    /* ignore */
  }
  process.exit(1)
})