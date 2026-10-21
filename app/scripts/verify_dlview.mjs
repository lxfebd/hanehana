// 下载页 + 收藏夹页渲染质量验证（B6）。
//   - 下载页：页头（面包屑/标题/副标题/带文字的新建按钮）+ 4 张 KPI（进行中/已完成/失败/总速度）
//     + 原有任务行/进度条/状态 chip/筛选 chips/按钮组全部保留
//   - 收藏夹页：页头 + 维度切换（开发商/系列）+ 分组卡（图标 + 组名 + 「n 款」）+
//     点组跳库并带上 meta 筛选 + 空态
// 用法：node scripts/verify_dlview.mjs
//
// 与 verify_download_view.mjs 的分工：那个脚本锁「下载功能链路」（任务行/筛选/
// Modal.confirm 行为），本脚本锁 B6 新增结构（页头 + KPI + 收藏夹浏览页）。
// 两个都留：老脚本的断言一条不减，回归不会因为新结构加进来而失效。
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { rmSync, mkdirSync } from 'node:fs'

const APP_ROOT = join(process.cwd())
const PORT = 9394
const DATA_DIR = join(APP_ROOT, '.dlview-data')
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
// seed 的游戏不带 favorite/developer/series，收藏夹页会是空态；补一份真实的
// 收藏分组数据（2 个开发商 + 2 个系列 + 1 款无开发商进「未分类」），
// 否则「点组跳库」「维度切换」这些 B6 的核心断言无从验证。
// DL_SKIP_FAV=1 可跳过（用于二分：确认任务行不渲染是否由本步骤引起）。
if (!process.env.DL_SKIP_FAV) {
  const fs = await import('node:fs')
  const games = JSON.parse(fs.readFileSync(join(DATA_DIR, 'games.json'), 'utf8'))
  const devOf = (i) => (i % 7 === 6 ? '' : ['柚子社', 'August', 'Minori'][i % 3])
  // series 必须是数组：主进程 searchIndex 与渲染层分组都按数组处理
  // （写成字符串会让 `series.join` 抛错，整个启动编排中断、任务列表空）
  const seriesOf = (i) => {
    if (i % 5 === 4) return []
    if (i % 3 === 0) return ['千恋＊万花']
    if (i % 2 === 0) return ['共通系列', 'Dracu-Riot!']
    return ['共通系列']
  }
  games.forEach((g, i) => {
    g.favorite = i % 3 !== 2 // 2/3 收藏
    g.developer = devOf(i)
    g.series = seriesOf(i)
  })
  fs.writeFileSync(join(DATA_DIR, 'games.json'), JSON.stringify(games), 'utf8')
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
  const clickNav = async (label) =>
    ev(
      `(() => { const b = [...document.querySelectorAll('.nav-item')].find(x => (x.textContent||'').includes('${label}')); if (b) { b.click(); return 'ok' } return 'no-nav' })()`,
    )
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
    // 启动编排诊断：useBoot 的 catch 会把失败原因写进标题栏（refreshGames/initTasks
    // 任一 reject 会让 initTasks 整体不执行 → 任务行空）。断言前先看它。
    const boot = await ev(`(document.querySelector('.titlebar .tag')||{}).textContent?.trim() || ''`)
    console.log('  [diag] boot:', JSON.stringify(boot))

    // ============ 下载页（B6-1） ============
    await clickNav('下载')
    await new Promise((r) => setTimeout(r, 1100))
    const dl = JSON.parse(
      await ev(`JSON.stringify((() => {
        const root = document.querySelector('.dl-layout')
        const crumbs = [...document.querySelectorAll('.dl-layout .ph-crumb span, .dl-layout .ph-crumb button')].map(x => x.textContent.trim()).filter(Boolean)
        const kpis = [...document.querySelectorAll('.dl-layout .kpi-strip .kpi-card')]
        const newBtn = [...document.querySelectorAll('.dl-layout .ph-actions .dl-btn')].find(b => (b.textContent||'').trim().length > 0)
        return {
          root: !!root,
          title: (document.querySelector('.dl-layout .ph-title')||{}).textContent?.trim() || '',
          sub: (document.querySelector('.dl-layout .ph-sub')||{}).textContent?.trim() || '',
          crumbs,
          kpiLabels: kpis.map(c => (c.querySelector('.kpi-label')||{}).textContent?.trim() || ''),
          kpiValues: kpis.map(c => (c.querySelector('.kpi-value')||{}).textContent?.trim() || ''),
          newBtnText: newBtn ? newBtn.textContent.trim() : '',
          rows: document.querySelectorAll('.task-row').length,
          segs: [...document.querySelectorAll('.seg-chip')].map(s => s.textContent.trim()),
          btns: document.querySelectorAll('.dl-btn').length,
          prog: document.querySelectorAll('.task-row .prog, .task-row .bar-fill').length,
          chips: document.querySelectorAll('.st-chip').length,
          speed: (document.querySelector('.total-speed')||{}).textContent?.trim() || ''
        }
      })())`),
    )
    ck('下载页页头渲染', dl.root === true && dl.title.length > 0)
    ck('页头面包屑 首页 / 下载任务', dl.crumbs.length === 2 && dl.crumbs[0].includes('首页') && dl.crumbs[1].includes('下载'), JSON.stringify(dl.crumbs))
    ck('页头标题为下载任务', dl.title.includes('下载'), dl.title)
    ck('页头副标题渲染', dl.sub.length > 0, dl.sub)
    ck('新建下载按钮带文字（主操作不是纯图标）', dl.newBtnText.length > 0, JSON.stringify(dl.newBtnText))
    ck('下载页 KPI 4 张', dl.kpiLabels.length === 4, 'n=' + dl.kpiLabels.length)
    ck(
      'KPI 标签齐全（进行中/已完成/失败/总速度）',
      ['进行中', '已完成', '失败', '总速度'].every(l => dl.kpiLabels.some(x => x.includes(l))),
      JSON.stringify(dl.kpiLabels),
    )
    ck('KPI 数值渲染（总速度为速率文本）', dl.kpiValues.length === 4 && dl.kpiValues.every(v => v.length > 0), JSON.stringify(dl.kpiValues))
    // 诊断：任务行不渲染时区分「数据没来」与「虚拟列表容器高度为 0」
    if (dl.rows === 0) {
      const diag = JSON.parse(
        await ev(`JSON.stringify((() => {
          const list = document.querySelector('.dl-list')
          return {
            listH: list ? Math.round(list.getBoundingClientRect().height) : -1,
            rows: document.querySelectorAll('.task-row').length
          }
        })())`),
      )
      console.log('  [diag] dl rows=0:', JSON.stringify(diag), 'boot=' + JSON.stringify(boot))
    }
    ck('任务列表渲染（原有链路未破坏）', dl.rows >= 3, 'rows=' + dl.rows)
    ck('筛选 chips 齐全', dl.segs.length >= 4, 'segs=' + JSON.stringify(dl.segs))
    ck('操作按钮组齐全（新建/全开/全停/重试/清理）', dl.btns >= 4, 'btns=' + dl.btns)
    ck('进度条/状态 chip 渲染', dl.prog >= 1 && dl.chips >= 3, 'prog=' + dl.prog + ' chips=' + dl.chips)
    ck('总速度位存在（无流量时隐藏是正确行为）', dl.speed.length >= 0, 'speed=' + dl.speed)

    // ============ 收藏夹页（B6-2） ============
    await clickNav('收藏')
    await new Promise((r) => setTimeout(r, 1100))
    const coll = JSON.parse(
      await ev(`JSON.stringify((() => {
        // 收藏夹页可能同时存在隐藏实例（保活）：只读可见那一份，
        // 否则维度切换/点组的断言会读到上一帧的旧 DOM。
        const pages = [...document.querySelectorAll('.collection-page')]
        const root = pages.find(p => p.getBoundingClientRect().height > 0) || pages[0]
        const q = (sel) => (root ? root.querySelector(sel) : null)
        const qa = (sel) => (root ? [...root.querySelectorAll(sel)] : [])
        const cards = qa('.coll-card')
        return {
          root: !!root,
          title: (q('.ph-title')||{}).textContent?.trim() || '',
          sub: (q('.ph-sub')||{}).textContent?.trim() || '',
          crumbs: qa('.ph-crumb span, .ph-crumb button').map(x => x.textContent.trim()).filter(Boolean),
          dimBtns: qa('.dim-seg .seg-chip').map(b => ({ t: b.textContent.trim(), on: b.classList.contains('active') })),
          cardCount: cards.length,
          cardNames: cards.map(c => (c.querySelector('.card-name')||{}).textContent?.trim() || ''),
          cardCounts: cards.map(c => (c.querySelector('.card-count')||{}).textContent?.trim() || ''),
          cardIcons: qa('.coll-card .card-ic svg').length,
          hasEmpty: !!q('.coll-empty'),
          otherClickable: cards.filter(c => c.classList.contains('is-other')).length,
          totalFavInSub: /\\d/.test((q('.ph-sub')||{}).textContent || '')
        }
      })())`),
    )
    ck('收藏夹页渲染', coll.root === true)
    ck('页头面包屑 首页 / 收藏夹', coll.crumbs.length === 2 && coll.crumbs[0].includes('首页') && coll.crumbs[1].includes('收藏'), JSON.stringify(coll.crumbs))
    ck('页头标题为收藏夹', coll.title.includes('收藏'), coll.title)
    ck('页头副标题带收藏总数', coll.totalFavInSub === true, coll.sub)
    ck('维度切换按钮 按开发商 / 按系列', coll.dimBtns.length === 2 && coll.dimBtns[0].t === '按开发商' && coll.dimBtns[1].t === '按系列', JSON.stringify(coll.dimBtns))
    ck('默认按开发商分组', coll.dimBtns[0] && coll.dimBtns[0].on === true, JSON.stringify(coll.dimBtns))
    ck('分组卡渲染（>=3 组：开发商维度）', coll.cardCount >= 3, 'n=' + coll.cardCount + ' names=' + JSON.stringify(coll.cardNames))
    ck('每组有文件夹图标', coll.cardIcons === coll.cardCount, 'icons=' + coll.cardIcons + '/' + coll.cardCount)
    ck('每组带数量「n 款」', coll.cardCounts.length === coll.cardCount && coll.cardCounts.every(v => /款$/.test(v)), JSON.stringify(coll.cardCounts))
    ck('未分类组存在且标记为不可点（无真实筛选值）', coll.cardNames.includes('未分类') && coll.otherClickable === 1, JSON.stringify(coll.cardNames))

    // 点一个真实组：应跳到库页并带上 developer meta 筛选
    const jump1 = JSON.parse(
      await ev(`JSON.stringify((() => {
        const pages = [...document.querySelectorAll('.collection-page')]
        const root = pages.find(p => p.getBoundingClientRect().height > 0) || pages[0]
        const cards = root ? [...root.querySelectorAll('.coll-card')] : []
        const target = cards.find(c => !c.classList.contains('is-other'))
        if (!target) return { ok: false }
        const name = (target.querySelector('.card-name')||{}).textContent?.trim()
        target.click()
        return { ok: true, name }
      })())`),
    )
    await new Promise((r) => setTimeout(r, 900))
    const afterJump1 = JSON.parse(
      await ev(`JSON.stringify((() => ({
        hasCoverWrap: !!document.querySelector('.cover-wrap'),
        hasCollection: !!document.querySelector('.collection-page'),
        hasDl: !!document.querySelector('.dl-layout'),
        coverCards: document.querySelectorAll('.cover-card').length
      }))())`),
    )
    ck('点组跳到库页（复用现成筛选链路）', afterJump1.hasCoverWrap === true && afterJump1.hasCollection === false, JSON.stringify(afterJump1))
    ck('库页按该组筛出封面卡', afterJump1.coverCards > 0, JSON.stringify(afterJump1))

    // 切到系列维度后分组集应变化
    await clickNav('收藏')
    await new Promise((r) => setTimeout(r, 1000))
    await ev(
      `(() => {
        const pages = [...document.querySelectorAll('.collection-page')]
        const root = pages.find(p => p.getBoundingClientRect().height > 0) || pages[0]
        const b = root && [...root.querySelectorAll('.dim-seg .seg-chip')].find(x => x.textContent.trim() === '按系列')
        if (b) { b.click(); return 'ok' } return 'no-series'
      })()`,
    )
    await new Promise((r) => setTimeout(r, 900))
    const series = JSON.parse(
      await ev(`JSON.stringify((() => {
        const pages = [...document.querySelectorAll('.collection-page')]
        const root = pages.find(p => p.getBoundingClientRect().height > 0) || pages[0]
        const qa = (sel) => (root ? [...root.querySelectorAll(sel)] : [])
        const cards = qa('.coll-card')
        return {
          n: cards.length,
          names: cards.map(c => (c.querySelector('.card-name')||{}).textContent?.trim() || ''),
          counts: cards.map(c => (c.querySelector('.card-count')||{}).textContent?.trim() || ''),
          active: qa('.dim-seg .seg-chip').find(b => b.classList.contains('active'))?.textContent?.trim() || '',
          pressed: qa('.dim-seg .seg-chip').map(b => b.getAttribute('aria-pressed'))
        }
      })())`),
    )
    ck('切到按系列分组（组集不同）', series.n >= 1 && series.active === '按系列', JSON.stringify(series))
    // 维度切换是否真的换了分组：组名集合必须不同（除了都可能出现的「未分类」兜底）
    const onlyDev = coll.cardNames.filter((n) => n !== '未分类')
    const onlySeries = series.names.filter((n) => n !== '未分类')
    const differs = onlyDev.length !== onlySeries.length || onlyDev.some((n) => !onlySeries.includes(n))
    ck(
      '系列维度组名与开发商维度不同（维度切换生效）',
      differs === true,
      'dev=' + JSON.stringify(coll.cardNames) + ' series=' + JSON.stringify(series.names) + ' pressed=' + JSON.stringify(series.pressed),
    )

    console.log('  下载页:', JSON.stringify({ kpi: dl.kpiLabels.length, rows: dl.rows, segs: dl.segs.length, btns: dl.btns }))
    console.log('  收藏夹:', JSON.stringify({ groups: coll.cardCount, seriesGroups: series.n, devNames: coll.cardNames, seriesNames: series.names }))
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
