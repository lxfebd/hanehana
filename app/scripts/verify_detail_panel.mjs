// 详情面板渲染质量验证（B4 右栏选中态，对标 ReinaManager detail.png/stats.png）：
//   - banner/封面/标题/动作栏/元数据行（数据来源/开发商/发售日/加入时间/时长/评分）
//   - 标签区：行内搜索框 + 清除 + 展开/收起（默认折叠到 8 个）
//   - 四个分页（游玩数据/简介/编辑/存档）+ 默认落在游玩数据
//   - 游玩数据页：7D/30D/1Y/ALL 区间切换 + 区间副行 + 每游戏时长曲线 + 3 小统计
//   - 收藏切换交互正常（乐观更新 + 回读）
// 高频界面（用户点封面必看）。用法：node scripts/verify_detail_panel.mjs
import { spawn, spawnSync } from 'node:child_process'
import { pickFreePort, killTree } from './lib/probePort.mjs'
import { join } from 'node:path'
import { rmSync, mkdirSync } from 'node:fs'
import { waitFor } from './lib/waitFor.mjs'

const APP_ROOT = join(process.cwd())
const PORT = await pickFreePort()
const DATA_DIR = join(APP_ROOT, '.detail-data')
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
    /** 布局读数落定：连续两次读数相同才算稳（视口宽度到位 ≠ 重排完成，
     * 中间会读到 394 这种中间值）。轮询间隔不是等状态。 */
    const waitStable = async (read, label, tries = 20) => {
      let prev = null
      for (let i = 0; i < tries; i++) {
        const cur = await read()
        if (cur !== undefined && cur !== null && cur === prev) return cur
        prev = cur
        await new Promise((r) => setTimeout(r, 150))
      }
      console.log('  [warn] 布局读数未落定：' + label)
      return prev
    }
    // 启动页现在是 home 仪表盘（B8）——封面墙/详情在库页，先导航过去
    // 先等应用就绪（原来这里是固定 2500ms）：慢机上侧栏还没渲染就点导航，
    // 会拿到 'no'，接着在整个 15s 里等封面墙——那是时序假红，不是产品问题。
    await waitFor(() => ev('!!(window.hh && document.querySelector(".sidebar .nav-item"))'), { timeoutMs: 30000, label: '应用就绪（hh + 侧栏导航）' })
    const nav = await ev(`(() => { const b = document.querySelector('[data-testid="nav-library"]'); if (b) { b.click(); return 'ok' } return 'no' })()`)
    if (nav !== 'ok') console.log('  [warn] 未能导航到库页：', nav)
    // 切页后等封面墙真的渲染（固定 800+1000ms 和手拉循环都换成条件等待）
    await waitFor(() => ev('!!document.querySelector(".cover-card")'), { timeoutMs: 15000, label: '库页封面墙出现（.cover-card）' })
    // 选中第一个封面 → 详情面板出现
    await ev(`(() => { const c = document.querySelector('.cover-card'); if (c) { c.click(); return 'ok' } return 'no-card' })()`)
    await waitFor(() => ev('!!document.querySelector(".detail-panel")'), { timeoutMs: 8000, label: '选中后详情面板出现' })
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
        // 语义钩子：收藏按钮由 DetailBanner 暴露 data-testid，状态看 aria-pressed；
        // 不再按「收藏」文案找按钮——文案随 locale 变，钩子不变。
        const favBtn = document.querySelector('[data-testid="act-fav"]')
        return {
          panel: !!panel, banner: !!banner, bannerH: banner ? banner.offsetHeight : 0,
          title: title ? title.textContent.trim().slice(0, 20) : '',
          play: !!play, metaCount: metaCells.length, metaKeys: metaKeys,
          hasTags: !!tagsBox, tagChips: tagChips, tagTotal: tagTotal,
          hasTagSearch: !!tagSearch,
          tagsExpand: !!document.querySelector('.dp-tags-toggle'),
          tabCount: tabs.length,
          tabLabels: tabs.map(t => t.textContent.trim()),
          activeTabId: activeTab ? activeTab.getAttribute('data-testid') : '',
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
    await waitFor(() => ev('!!document.querySelector(".dp-tags-none")'), { timeoutMs: 5000, label: '标签搜索空态出现（无匹配）' })
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
    await waitFor(() => ev('document.querySelectorAll(".dp-tags-chips .tag-chip").length >= 1'), { timeoutMs: 5000, label: '清除搜索后 chip 恢复' })
    const tagRestored = await ev(`(() => ({ chips: document.querySelectorAll('.dp-tags-chips .tag-chip').length, none: !!document.querySelector('.dp-tags-none') }))()`)
    ck('清除搜索后 chip 恢复', tagRestored && tagRestored.chips >= 1 && tagRestored.none === false, JSON.stringify(tagRestored))

    // ---- 分页 ----
    ck('四个分页齐（游玩数据/简介/编辑/存档）', st.tabCount === 4, 'tabs=' + st.tabCount + ' ' + JSON.stringify(st.tabLabels))
    ck('默认激活「游玩数据」', st.activeTabId === 'tab-stats', 'active=' + st.activeTabId)
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
    await ev(`(() => { const c=document.querySelector('[data-testid="range-play_all"]'); if(c){c.click();return 'ok'} return 'no' })()`)
    await waitFor(() => ev('(() => { const s = (document.querySelector(".pc-range-sub")||{}).textContent||""; return !!s && s.includes("–") })()'), { timeoutMs: 5000, label: 'ALL 区间副行更新' })
    const afterRange = await ev(`(() => ({ sub: (document.querySelector('.pc-range-sub')||{}).textContent||'', svg: !!document.querySelector('.play-chart svg') }))()`)
    ck('切到 ALL 区间后副行更新且曲线仍在', afterRange && afterRange.svg === true && (afterRange.sub || '').includes('–'), JSON.stringify(afterRange))
    // ---- 交互：切到简介页（BBCode 清洗后的正文）----
    await ev(`(() => { const t=document.querySelector('[data-testid="tab-intro"]'); if(t){t.click();return 'ok'} return 'no' })()`)
    await waitFor(() => ev('!!document.querySelector(".desc")'), { timeoutMs: 5000, label: '简介页正文出现' })
    const intro = await ev(`(() => {
      const d = document.querySelector('.desc')
      const txt = d ? d.textContent : ''
      return { hasDesc: !!d, bb: /\\[[a-z]/i.test(txt), text: txt.trim().slice(0, 60) }
    })()`)
    ck('简介页渲染正文', intro && (intro.hasDesc === true || (intro.text || '').length > 0), JSON.stringify(intro))
    ck('简介无 BBCode 残留（对基准的优势项）', !intro || intro.bb === false, JSON.stringify(intro && intro.text))
    // ---- 交互：切到存档页（备份开关 + 记录入口）----
    await ev(`(() => { const t=document.querySelector('[data-testid="tab-saves"]'); if(t){t.click();return 'ok'} return 'no' })()`)
    await waitFor(() => ev('!!document.querySelector(".dp-switch input[type=checkbox]")'), { timeoutMs: 5000, label: '存档页渲染（备份开关）' })
    const saves = await ev(`(() => ({ switch: !!document.querySelector('.dp-switch input[type=checkbox]'), btn: !!document.querySelector('[data-testid="act-backup-records"]') }))()`)
    ck('存档页有备份开关与记录入口', saves && saves.switch === true && saves.btn === true, JSON.stringify(saves))
    // ---- 收藏切换交互：点收藏 → aria-pressed 翻面 ----
    // 不能假定初始是「未收藏」：seed_layout.mjs 会给部分游戏打 favorite，
    // 断言写成「点后必须变成已收藏」在已收藏的种子上会反向失败。
    // 要验的是「点了状态就翻面」这个交互本身，所以先读初始态再比翻转。
    // 状态读 aria-pressed（语义状态），不比中文/英文文案——文案随 locale 变，状态不变。
    const readFav = () =>
      ev(`(() => { const b = document.querySelector('[data-testid="act-fav"]'); return b ? String(b.getAttribute('aria-pressed')) : 'no-btn' })()`)
    const favBefore = await readFav()
    await ev(`(() => { const b = document.querySelector('[data-testid="act-fav"]'); if (b) { b.click(); return 'ok' } return 'no' })()`)
    // 等状态真的翻转（乐观更新生效）再回读，原来固定 800ms
    await waitFor(
      async () => {
        const s = await readFav()
        return s !== 'no-btn' && s !== favBefore
      },
      { timeoutMs: 5000, label: '收藏按钮 aria-pressed 翻转' },
    )
    const favAfter = await readFav()
    ck(
      '收藏切换交互正常（aria-pressed 翻转 = 乐观更新生效）',
      favBefore !== 'no-btn' && favBefore !== favAfter,
      'before=' + favBefore + ' after=' + favAfter,
    )
    // ---- 右栏弹性（回归靶：右栏死咬 400、窗口拖窄后右栏占掉半个窗口 / 中栏被挤没）----
    // 默认窗口宽下右栏必须还是 token 宽（设计稿口径不能被弹性改掉）；
    // 窄窗下必须跟着收、不越界、内部不出横向滚动。
    const baseW = Math.round(
      (await ev(`(() => { const a = document.querySelector('.aside'); return a ? a.getBoundingClientRect().width : -1 })()`)) ?? -1,
    )
    ck('默认窗口右栏宽 = token（400，设计稿口径）', baseW === 400, 'w=' + baseW)
    await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false })
    await waitFor(() => ev('window.innerWidth === 1000'), { timeoutMs: 5000, label: '窄窗 1000 视口重排生效' })
    await waitStable(() => ev('Math.round(document.querySelector(".aside").getBoundingClientRect().width)'), '窄窗下右栏宽度落定')
    const flexRaw = await ev(`(() => {
      const aside = document.querySelector('.aside')
      const content = document.querySelector('.content')
      const panel = document.querySelector('.detail-panel')
      if (!aside || !content) return null
      const a = aside.getBoundingClientRect()
      const c = content.getBoundingClientRect()
      const acts = document.querySelector('.actions-sub')
      return JSON.stringify({
        iw: innerWidth,
        asideW: Math.round(a.width),
        asideRight: Math.round(a.right),
        contentW: Math.round(c.width),
        docSW: document.documentElement.scrollWidth,
        panelOverX: panel ? panel.scrollWidth - panel.clientWidth : -1,
        actsH: acts ? Math.round(acts.getBoundingClientRect().height) : -1,
        btnClip: [...document.querySelectorAll('.ghost-btn')].some(
          (b) => b.scrollWidth > b.clientWidth + 1 || b.scrollHeight > b.clientHeight + 1,
        ),
        panelFromAside:
          Math.round(panel.getBoundingClientRect().width) === Math.round(a.width),
      })
    })()`)
    const fx = flexRaw ? JSON.parse(flexRaw) : null
    ck('窄窗（1000）右栏弹性收缩到 token 以下', !!fx && fx.asideW < 400 && fx.asideW >= 280, 'aside=' + (fx && fx.asideW))
    ck('窄窗右栏不越出窗口（「只露一半」的回归靶）', !!fx && fx.asideRight <= fx.iw && fx.docSW <= fx.iw + 1, JSON.stringify(fx))
    ck('窄窗中栏保留可用宽度（不被右栏挤没）', !!fx && fx.contentW >= 420, 'content=' + (fx && fx.contentW))
    ck('窄窗面板内部无横向溢出', !!fx && fx.panelOverX === 0, 'overX=' + (fx && fx.panelOverX))
    // 面板宽度只有一个权威：抽屉里的面板宽 = .aside 宽（组件自己不写 width）。
    // 以前这里只能验「没越界」，因为宽度由父级覆盖回 100%；现在是同一件事。
    ck('面板宽度由右栏给（组件不再自带 token 宽）', !!fx && fx.panelFromAside === true, JSON.stringify(fx))
    // 次按钮不再靠 @container 340px 阈值换排：标签放不下就折行，判据是「不叠字/不被裁」。
    ck('窄窗次按钮不叠字（标签折行或单行放得下）', !!fx && fx.btnClip === false, 'actsH=' + (fx && fx.actsH) + ' clip=' + (fx && fx.btnClip))
    await send('Emulation.clearDeviceMetricsOverride')
    await waitFor(() => ev('window.innerWidth !== 1000'), { timeoutMs: 5000, label: '恢复视口重排生效' })
    await waitStable(() => ev('Math.round(document.querySelector(".aside").getBoundingClientRect().width)'), '恢复窗口后右栏宽度落定')
    const back = JSON.parse(
      (await ev(`(() => { const a = document.querySelector('.aside'); return JSON.stringify({ w: Math.round(a.getBoundingClientRect().width), iw: innerWidth }) })()`)) || '{}',
    )
    ck('恢复窗口宽度后右栏回到 token 宽（400）', back.w === 400, JSON.stringify(back))
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