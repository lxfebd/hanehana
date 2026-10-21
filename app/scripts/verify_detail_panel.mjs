// 详情面板渲染质量验证（B4 右栏选中态，对标 ReinaManager detail.png/stats.png）：
//   - banner/封面/标题/动作栏/元数据行（数据来源/开发商/发售日/加入时间/时长/评分）
//   - 标签区：行内搜索框 + 清除 + 展开/收起（默认折叠到 8 个）
//   - 四个分页（游玩数据/简介/编辑/存档）+ 默认落在游玩数据
//   - 游玩数据页：7D/30D/1Y/ALL 区间切换 + 区间副行 + 每游戏时长曲线 + 3 小统计
//   - 收藏切换交互正常（乐观更新 + 回读）
// 高频界面（用户点封面必看）。用法：node scripts/verify_detail_panel.mjs
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { rmSync, mkdirSync } from 'node:fs'

const APP_ROOT = join(process.cwd())
const PORT = 9389
const DATA_DIR = join(APP_ROOT, '.detail-data')
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
        fail++
        console.log('  [FAIL] ' + n + ' ' + (x || ''))
      }
    }
    // 启动页现在是 home 仪表盘（B8）——封面墙/详情在库页，先导航过去
    const nav = await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => (x.textContent || '').includes('全部游戏') || (x.textContent || '').includes('Library')); if (b) { b.click(); return 'ok' } return 'no' })()`)
    if (nav !== 'ok') console.log('  [warn] 未能导航到库页：', nav)
    await new Promise((r) => setTimeout(r, 800))
    for (let i = 0; i < 20; i++) {
      const e = await ev('!!document.querySelector(".cover-card")')
      if (e) break
      await new Promise((r) => setTimeout(r, 500))
    }
    await new Promise((r) => setTimeout(r, 1000))
    // 选中第一个封面 → 详情面板出现
    await ev(`(() => { const c = document.querySelector('.cover-card'); if (c) { c.click(); return 'ok' } return 'no-card' })()`)
    await new Promise((r) => setTimeout(r, 900))
    const st = JSON.parse(
      await ev(`JSON.stringify((() => {
        const panel = document.querySelector('.detail-panel')
        const banner = document.querySelector('.banner')
        const title = document.querySelector('.banner-title')
        const play = document.querySelector('.primary-btn')
        const metaCells = [...document.querySelectorAll('.dp-meta-cell')]
        const metaKeys = metaCells.map(c => (c.querySelector('.dp-meta-key')||{}).textContent)
        const tagsBox = document.querySelector('.dp-tags')
        const tagChips = document.querySelectorAll('.dp-tags-chips .tag-chip').length
        const tagTotal = tagsBox ? Number((tagsBox.querySelector('.dp-tags-count') || {}).textContent.split('/').pop()) || 0 : 0
        const tagSearch = document.querySelector('.dp-tags-search input')
        const tabs = [...document.querySelectorAll('.dp-tab')]
        const activeTab = document.querySelector('.dp-tab.active')
        const favBtn = [...document.querySelectorAll('.fav-btn')].find(b => (b.textContent||'').includes('收藏'))
        return {
          panel: !!panel, banner: !!banner, bannerH: banner ? banner.offsetHeight : 0,
          title: title ? title.textContent.trim().slice(0, 20) : '',
          play: !!play, metaCount: metaCells.length, metaKeys: metaKeys,
          hasTags: !!tagsBox, tagChips: tagChips, tagTotal: tagTotal,
          hasTagSearch: !!tagSearch,
          tagsExpand: !!document.querySelector('.dp-tags-toggle'),
          tabCount: tabs.length,
          tabLabels: tabs.map(t => t.textContent.trim()),
          activeTabText: activeTab ? activeTab.textContent.trim() : '',
          hasRange: document.querySelectorAll('.pc-range .range-chip').length,
          hasRangeSub: !!document.querySelector('.pc-range-sub'),
          hasChart: !!document.querySelector('.play-chart'),
          hasChartSvg: !!document.querySelector('.play-chart svg'),
          miniStats: document.querySelectorAll('.dp-mini-stats .dp-mini').length,
          hasTools: !!document.querySelector('.dp-tools'),
          switches: document.querySelectorAll('.dp-switch input[type=checkbox]').length,
          favBtn: !!favBtn, favText: favBtn ? favBtn.textContent.trim() : '',
          ghostBtns: document.querySelectorAll('.ghost-btn').length,
        }
      })())`),
    )
    ck('详情面板渲染', st.panel && st.banner, 'panel=' + st.panel + ' banner=' + st.banner)
    // banner 保持 180px 不被 flex 列压缩（旧 224px 紧凑化为 180：右栏高度
    // 预算里曲线必须在首屏可见；防 flex-shrink 回归的语义不变——没有
    // flex:none 它会被压成 32px 一条，封面直接消失）
    ck('banner hero 保持 180px 不被压缩', st.bannerH >= 175, 'h=' + st.bannerH)
    ck('标题有内容', (st.title || '').length > 0, 'title=' + st.title)
    ck('主按钮（启动）存在', st.play === true, 'play=' + st.play)
    ck('元数据行齐全（来源/开发商/发售/加入/时长/评分）', st.metaCount >= 6, 'cells=' + st.metaCount)
    ck('元数据 label 与值成对', (st.metaKeys || []).filter(Boolean).length === st.metaCount, JSON.stringify(st.metaKeys))
    ck('次按钮组齐全（刮削/编辑/目录/复制）', st.ghostBtns >= 3, 'ghost=' + st.ghostBtns)
    // ---- 标签区（全集 + 行内搜索 + 展开）----
    ck('标签区渲染且 chip 有内容', st.hasTags && st.tagChips >= 1, 'chips=' + st.tagChips)
    ck('标签行内搜索框存在', st.hasTagSearch === true, 'search=' + st.hasTagSearch)
    // 展开/收起只在 tag 数超过折叠阈值（8）时出现——种子库每款 3–4 个 tag，
    // 不出现是正确行为（信息密度达标：默认就两行内）。因此按总数自适应断言。
    ck(
      '标签展开按钮按需出现（>8 才有）',
      st.tagTotal > 8 ? st.tagsExpand === true : true,
      'total=' + st.tagTotal + ' toggle=' + st.tagsExpand,
    )
    // 标签搜索过滤：输入一个不存在的词 → 只剩「没有匹配的标签」；清空 → chip 回来
    await ev(`(() => {
      const inp = document.querySelector('.dp-tags-search input')
      if (!inp) return 'no-input'
      inp.focus()
      inp.value = 'zzz-no-such-tag'
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      return 'typed'
    })()`)
    await new Promise((r) => setTimeout(r, 400))
    const tagFiltered = await ev(`(() => {
      const none = document.querySelector('.dp-tags-none')
      const chips = document.querySelectorAll('.dp-tags-chips .tag-chip').length
      return { chips: chips, none: none ? none.textContent.trim() : '' }
    })()`)
    ck('标签搜索过滤生效（无匹配时给空态文案）', tagFiltered && tagFiltered.chips === 0 && tagFiltered.none.length > 0, JSON.stringify(tagFiltered))
    await ev(`(() => {
      const btn = document.querySelector('.dp-tags-clear')
      if (btn) { btn.click(); return 'cleared' }
      const inp = document.querySelector('.dp-tags-search input')
      if (inp) { inp.value = ''; inp.dispatchEvent(new Event('input', { bubbles: true })); return 'cleared-by-input' }
      return 'no-clear'
    })()`)
    await new Promise((r) => setTimeout(r, 400))
    const tagRestored = await ev(`(() => ({ chips: document.querySelectorAll('.dp-tags-chips .tag-chip').length, none: !!document.querySelector('.dp-tags-none') }))()`)
    ck('清除搜索后 chip 恢复', tagRestored && tagRestored.chips >= 1 && tagRestored.none === false, JSON.stringify(tagRestored))

    // ---- 分页 ----
    ck('四个分页齐（游玩数据/简介/编辑/存档）', st.tabCount === 4, 'tabs=' + st.tabCount + ' ' + JSON.stringify(st.tabLabels))
    ck('默认激活「游玩数据」', st.activeTabText.includes('游玩数据') || st.activeTabText.includes('Game Stats'), 'active=' + st.activeTabText)
    // ---- 游玩数据页：区间 + 曲线 + 小统计 ----
    ck('区间切换 7D/30D/1Y/ALL 四枚', st.hasRange === 4, 'chips=' + st.hasRange)
    ck('区间副行（play_range）存在', st.hasRangeSub === true, 'sub=' + st.hasRangeSub)
    ck('每游戏时长曲线组件存在', st.hasChart === true, 'chart=' + st.hasChart)
    ck('时长曲线渲染出 svg', st.hasChartSvg === true, 'svg=' + st.hasChartSvg)
    // 曲线必须在首屏视口内：右栏是「banner+元数据+标签+分页+曲线」的堆叠，
    // 每一块都在吃 780px 预算——任何一块膨胀都会把曲线推出屏幕
    // （224px banner + 全宽收藏行的旧版就死在这里，截图里曲线完全不见）。
    const chartInView = await ev(`(() => { const s = document.querySelector('.play-chart svg'); if (!s) return null; const r = s.getBoundingClientRect(); const panel = document.querySelector('.detail-panel'); return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight, scrollTop: panel ? panel.scrollTop : -1 } })()`)
    ck('曲线默认在首屏视口内（右栏紧凑化防回归）', !!chartInView && chartInView.top >= 0 && chartInView.bottom <= chartInView.vh + 2, JSON.stringify(chartInView))
    ck('三个小统计（总时长/场次/本周）', st.miniStats === 3, 'minis=' + st.miniStats)
    ck('工具与开关分组常驻（LE/Magpie）', st.hasTools === true && st.switches >= 2, 'switches=' + st.switches)
    ck('收藏按钮存在', st.favBtn, 'fav=' + st.favText)
    // ---- 交互：区间切换后副行/曲线仍在 ----
    await ev(`(() => { const c=[...document.querySelectorAll('.pc-range .range-chip')].find(x=>(x.textContent||'').trim()==='全部'||(x.textContent||'').trim()==='ALL'); if(c){c.click();return 'ok'} return 'no' })()`)
    await new Promise((r) => setTimeout(r, 600))
    const afterRange = await ev(`(() => ({ sub: (document.querySelector('.pc-range-sub')||{}).textContent||'', svg: !!document.querySelector('.play-chart svg') }))()`)
    ck('切到 ALL 区间后副行更新且曲线仍在', afterRange && afterRange.svg === true && (afterRange.sub || '').includes('–'), JSON.stringify(afterRange))
    // ---- 交互：切到简介页（BBCode 清洗后的正文）----
    await ev(`(() => { const t=[...document.querySelectorAll('.dp-tab')].find(x=>(x.textContent||'').includes('简介')||(x.textContent||'').includes('Introduction')); if(t){t.click();return 'ok'} return 'no' })()`)
    await new Promise((r) => setTimeout(r, 600))
    const intro = await ev(`(() => {
      const d = document.querySelector('.desc')
      const txt = d ? d.textContent : ''
      return { hasDesc: !!d, bb: /\\[[a-z]/i.test(txt), text: txt.trim().slice(0, 60) }
    })()`)
    ck('简介页渲染正文', intro && (intro.hasDesc === true || (intro.text || '').length > 0), JSON.stringify(intro))
    ck('简介无 BBCode 残留（对基准的优势项）', !intro || intro.bb === false, JSON.stringify(intro && intro.text))
    // ---- 交互：切到存档页（备份开关 + 记录入口）----
    await ev(`(() => { const t=[...document.querySelectorAll('.dp-tab')].find(x=>(x.textContent||'').includes('存档')||(x.textContent||'').includes('Save')); if(t){t.click();return 'ok'} return 'no' })()`)
    await new Promise((r) => setTimeout(r, 500))
    const saves = await ev(`(() => ({ switch: !!document.querySelector('.dp-switch input[type=checkbox]'), btn: !![...document.querySelectorAll('.dp-pane-btn')].find(b=>(b.textContent||'').includes('备份')) }))()`)
    ck('存档页有备份开关与记录入口', saves && saves.switch === true && saves.btn === true, JSON.stringify(saves))
    // ---- 收藏切换交互：点收藏 → 文案翻转 ----
    // 不能假定初始是「未收藏」：seed_layout.mjs 会给部分游戏打 favorite，
    // 断言写成「点后必须变成已收藏」在已收藏的种子上会反向失败。
    // 要验的是「点了文案就翻面」这个交互本身，所以先读初始态再比翻转。
    const favBefore = await ev(`(() => { const b = [...document.querySelectorAll('.fav-btn')].find(x => (x.textContent||'').includes('收藏')); return b ? b.textContent.trim() : 'no-btn' })()`)
    await ev(`(() => { const b = [...document.querySelectorAll('.fav-btn')].find(x => (x.textContent||'').includes('收藏')); if (b) { b.click(); return 'ok' } return 'no' })()`)
    await new Promise((r) => setTimeout(r, 800))
    const favAfter = await ev(`(() => { const b = [...document.querySelectorAll('.fav-btn')].find(x => (x.textContent||'').includes('收藏')); return b ? b.textContent.trim() : 'no-btn' })()`)
    ck(
      '收藏切换交互正常（文案翻转 = 乐观更新生效）',
      favBefore !== 'no-btn' && favBefore !== favAfter && ((favAfter || '').includes('收藏') || (favAfter || '').includes('Faved')),
      'before=' + favBefore + ' after=' + favAfter,
    )
    console.log(
      '  面板状态:',
      JSON.stringify({
        title: st.title,
        bannerH: st.bannerH,
        meta: st.metaCount,
        tagChips: st.tagChips,
        tabs: st.tabLabels,
        minis: st.miniStats,
        fav: favAfter,
      }),
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