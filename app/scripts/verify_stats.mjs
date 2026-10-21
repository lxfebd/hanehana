// 统计页渲染质量验证（B5）：页头 + 6 张 KPI + 周/月周期切换 + 总趋势折线
// （缺日补零）+ Top10 排行 + 时段分布 + 海报导出入口
// 用法：node scripts/verify_stats.mjs
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { rmSync, mkdirSync } from 'node:fs'

const APP_ROOT = join(process.cwd())
const PORT = 9399
const DATA_DIR = join(APP_ROOT, '.stats-data')
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
// 补 play sessions（统计页的柱状图/排行按会话聚合；seed 只有 playMs 无 sessions）
// 跨 60 天铺：让周/月切换后的 KPI 与趋势线真的能看出差别（否则只跑最近 30 天
// 的话「月」与「周」在断言里只能比出文案，比不出数据）。
{
  const fs = await import('node:fs')
  const now = Date.now()
  const day = 86400000
  const games = JSON.parse(fs.readFileSync(join(DATA_DIR, 'games.json'), 'utf8'))
  const sessions = []
  for (let i = 0; i < 60; i++) {
    const g = games[i % games.length]
    if (!g) continue
    // 前半 30 天节奏更密、后半 30 天更疏：两种周期下的活跃天数/场次不同
    const dense = i < 30
    const ms = 30 * 60000 + (i % 5) * 15 * 60000
    if (!dense && i % 3 !== 0) continue
    sessions.push({
      gameId: g.id,
      title: g.title,
      start: now - i * day - ms,
      end: now - i * day,
      ms,
    })
  }
  fs.writeFileSync(join(DATA_DIR, 'play-sessions.json'), JSON.stringify(sessions), 'utf8')
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
      const e = await ev('!!window.hh')
      if (e) break
      await new Promise((r) => setTimeout(r, 500))
    }
    await new Promise((r) => setTimeout(r, 800))
    // 切到统计页（侧栏「更多 → 统计」）
    await ev(
      `(() => { const m = [...document.querySelectorAll('.nav-item')].find(x => (x.textContent||'').includes('更多')); if (m) { m.click(); return 'ok' } return 'no-more' })()`,
    )
    await new Promise((r) => setTimeout(r, 500))
    await ev(
      `(() => { const t = [...document.querySelectorAll('.more-menu .nav-item')].find(x => (x.textContent||'').includes('统计')); if (t) { t.click(); return 'ok' } return 'no-stats' })()`,
    )
    await new Promise((r) => setTimeout(r, 1500))

    // ---- 页头（B5-1）----
    const head = JSON.parse(
      await ev(`JSON.stringify((() => {
        const ph = document.querySelector('.stats-page .page-header')
        const crumbs = [...document.querySelectorAll('.stats-page .ph-crumb span, .stats-page .ph-crumb button')].map(x => x.textContent.trim()).filter(Boolean)
        return {
          hasPh: !!ph,
          title: (document.querySelector('.stats-page .ph-title')||{}).textContent?.trim() || '',
          crumbs,
          sub: (document.querySelector('.stats-page .ph-sub')||{}).textContent?.trim() || '',
          hasPosterBtn: !!document.querySelector('.stats-page .poster-btn')
        }
      })())`),
    )
    ck('页头 PageHeader 渲染', head.hasPh === true)
    ck('面包屑 首页 / 统计', head.crumbs.length === 2 && head.crumbs[0].includes('首页') && head.crumbs[1].includes('统计'), JSON.stringify(head.crumbs))
    ck('页头标题为统计', head.title.includes('统计'), head.title)
    ck('页头副标题渲染', head.sub.length > 0, head.sub)
    ck('海报导出入口在页头 actions', head.hasPosterBtn === true)

    // ---- KPI：6 张（B5-2）----
    const kpi = JSON.parse(
      await ev(`JSON.stringify((() => {
        const cards = [...document.querySelectorAll('.stats-page .kpi-strip .kpi-card')]
        return {
          n: cards.length,
          labels: cards.map(c => (c.querySelector('.kpi-label')||{}).textContent?.trim() || ''),
          values: cards.map(c => (c.querySelector('.kpi-value')||{}).textContent?.trim() || ''),
          subs: cards.filter(c => !!c.querySelector('.kpi-sub')).length
        }
      })())`),
    )
    ck('KPI 卡扩到 6 张', kpi.n === 6, 'n=' + kpi.n)
    ck('KPI 标签齐全（总时长/已玩/会话场次/新增/活跃天数/日均）', ['总时长','已玩','会话场次','新增','活跃天数','日均'].every(l => kpi.labels.some(x => x.includes(l))), JSON.stringify(kpi.labels))
    ck('KPI 每卡有周期口径副行', kpi.subs === 6, 'subs=' + kpi.subs)
    ck('KPI 数值非空（tabular 数字）', kpi.values.every(v => v.length > 0), JSON.stringify(kpi.values))

    // ---- 周期切换：周 / 月（B5-2）----
    const segs = JSON.parse(
      await ev(`JSON.stringify((() => [...document.querySelectorAll('.stats-page .period-bar .seg-chip')].map(b => ({ t: b.textContent.trim(), on: b.classList.contains('active') })))())`),
    )
    ck('周期切换按钮 周/月', segs.length === 2 && segs[0].t === '周' && segs[1].t === '月', JSON.stringify(segs))
    ck('默认选中月', segs[1] && segs[1].on === true, JSON.stringify(segs))

    // 读月份口径的总时长，切到周后重读：必须变（否则周期切换是假按钮）
    const readKpi = () =>
      ev(`(() => {
        const cards = [...document.querySelectorAll('.stats-page .kpi-strip .kpi-card')]
        const txt = (i) => (cards[i] ? (cards[i].querySelector('.kpi-value')||{}).textContent?.trim() || '' : '')
        const chart = document.querySelector('.stats-page .play-chart svg')
        const pts = chart ? chart.querySelectorAll('circle').length : 0
        const cells = chart ? chart.querySelectorAll('.pc-tick').length : 0
        return JSON.stringify({ total: txt(0), sessions: txt(2), active: txt(4), pts, cells, range: (document.querySelector('.stats-page .period-range')||{}).textContent?.trim() || '' })
      })()`)
    const monthState = JSON.parse(await readKpi())
    await ev(
      `(() => { const w = [...document.querySelectorAll('.stats-page .period-bar .seg-chip')].find(b => b.textContent.trim() === '周'); if (w) { w.click(); return 'ok' } return 'no-week' })()`,
    )
    await new Promise((r) => setTimeout(r, 900))
    const weekState = JSON.parse(await readKpi())
    ck('周/月切换后总时长按周期重算（数值不同）', monthState.total !== weekState.total, 'month=' + monthState.total + ' week=' + weekState.total)
    ck('周/月切换后会话场次按周期重算', monthState.sessions !== weekState.sessions, 'month=' + monthState.sessions + ' week=' + weekState.sessions)
    ck('周/月切换后活跃天数按周期重算', monthState.active !== weekState.active, 'month=' + monthState.active + ' week=' + weekState.active)
    ck('切换周期时区间文案同步', monthState.range !== weekState.range && weekState.range.length > 0, 'month=' + monthState.range + ' week=' + weekState.range)
    ck('周日期的趋势线点数少于月日期（7 < 30，补零后的日历轴）', weekState.pts > 0 && weekState.pts < monthState.pts, 'week=' + weekState.pts + ' month=' + monthState.pts)
    ck('趋势图 X 轴有刻度（非空轴）', weekState.cells > 0 && monthState.cells > 0, 'week=' + weekState.cells + ' month=' + monthState.cells)

    // ---- 总趋势 / Top10 / 时段分布（B5-3/4/5）----
    const charts = JSON.parse(
      await ev(`JSON.stringify((() => {
        const trend = document.querySelector('.stats-page .play-chart svg')
        const topRows = document.querySelectorAll('.stats-page .top-row').length
        const topThumbs = document.querySelectorAll('.stats-page .top-thumb img').length
        const hourCols = document.querySelectorAll('.stats-page .hour-chart .hour-col').length
        const hourFilled = [...document.querySelectorAll('.stats-page .hour-col')].filter(c => parseFloat((c.title||'').split('·')[1]||'0') > 0).length
        const panels = [...document.querySelectorAll('.stats-page .panel-title')].map(x => x.textContent.trim())
        const body = document.body.innerText
        return {
          hasTrend: !!trend,
          trendLine: trend ? !!trend.querySelector('path') : false,
          trendArea: trend ? !!trend.querySelector('path[opacity]') : false,
          topRows, topThumbs, hourCols, hourFilled, panels,
          hasDuration: /h|min/.test(body)
        }
      })())`),
    )
    ck('总趋势折线渲染（PlayChart svg + path）', charts.hasTrend === true && charts.trendLine === true)
    ck('总趋势有面积层', charts.trendArea === true)
    ck('Top10 排行渲染 10 行', charts.topRows === 10, 'rows=' + charts.topRows)
    ck('Top10 保留头像缩略图', charts.topThumbs > 0, 'thumbs=' + charts.topThumbs)
    ck('时段分布按 0–23 时渲染 24 根', charts.hourCols === 24, 'cols=' + charts.hourCols)
    ck('时段分布有非零时段（聚合出数据）', charts.hourFilled > 0, 'filled=' + charts.hourFilled)
    ck(
      '面板标题：总游玩趋势 / 游戏时长排行 / 时段分布',
      charts.panels.some(p => p.includes('总游玩趋势')) && charts.panels.some(p => p.includes('游戏时长排行')) && charts.panels.some(p => p.includes('时段分布')),
      JSON.stringify(charts.panels),
    )
    ck('统计页有内容（时长文本）', charts.hasDuration === true)

    console.log(
      '  统计页:',
      JSON.stringify({ kpi: kpi.n, month: monthState, week: weekState, top: charts.topRows, hours: charts.hourCols }),
    )
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
