// 封面破图回退的永久回归靶：把「状态驱动 + 换批次清空」两个语义钉进闸门。
//
// 背景（已发生的事故）：CoverGrid.vue 原来在 @error 里写 img.style.display='none'。
// RecycleScroller 会复用卡片 DOM，而 Vue 并不知道这个命令式隐藏——下一个滑进视口的
// 正常封面沿用同一块节点，于是封面永久消失，且只在滚动/切筛选后复现（极难回看）。
// 现在改成状态驱动：brokenImgs 按 't:'+id / 'i:'+id 记录，模板 v-if 过滤并回退到
// 海报占位；换一批卡片（props.games 身份变化）时清空重试。这两件事此前没有任何闸门。
//
// 本脚本用真实故障路径验证（不是塞一个假状态）：
//   1) 造一款 thumbPath 指向不存在文件、但 coverPath 正常的游戏（coverPath 正常是为了
//      躲开启动自愈：coverHeal 会把「封面文件丢失」的卡连 thumbPath 一起清掉，
//      那样根本不会走到 <img> 的 @error，也就测不到我们要测的东西）；
//   2) 断言封面墙里那张卡没有加载失败的 <img>、显示占位；
//   3) 滚动到库底让 RecycleScroller 回收那一行、再滚回来，断言占位与「不连坐」都还在
//      （display:none 的旧实现会在这里把别的卡连坐成空白）；
//   4) 恢复：把真实封面写到那个路径 → 切分类再切回（换一批卡片）→ 断言图片回来。
// 用法：node scripts/verify_cover_fallback.mjs
import { spawn, spawnSync } from 'node:child_process'
import { pickFreePort, killTree } from './lib/probePort.mjs'
import { join } from 'node:path'
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs'
import { waitFor } from './lib/waitFor.mjs'

const APP_ROOT = join(process.cwd())
const PORT = await pickFreePort()
const DATA_DIR = join(APP_ROOT, '.cover-fallback-data')
const BROKEN_FILE = join(DATA_DIR, 'covers', 'nope.png')
const TARGET_ID = 'g1'
/** 目标卡标题里的稳定片段（标题本身带日文，用一段不会随字形变化的中文更稳） */
const TARGET_MARK = '万华镜'
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
// ---- 造坏：只把缩略图指到不存在的文件，封面本体保持有效 ----
const gamesPath = join(DATA_DIR, 'games.json')
const games = JSON.parse(readFileSync(gamesPath, 'utf8'))
const target = games.find((g) => g.id === TARGET_ID)
if (!target) throw new Error('种子数据里没有 ' + TARGET_ID)
target.thumbPath = BROKEN_FILE
// thumbSrc 指向有效封面 = 告诉启动回填「这张缩略图就是当前封面的产物，别重做」，
// 否则 ensureThumb 会从 coverPath 重新生成一张好缩略图，把坏路径覆盖掉。
target.thumbSrc = target.coverPath
// color 有值 = 这张卡不进回填队列（队列条件是 !thumbPath || !color），
// 同时它就是占位要用的「主色底」，断言里会验它真的画在 .cover-thumb 上。
target.color = '#7c6fa8'
writeFileSync(gamesPath, JSON.stringify(games, null, 2), 'utf8')
if (existsSync(BROKEN_FILE)) throw new Error('坏封面路径居然存在：' + BROKEN_FILE)

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
    /** 卡片状态读数：目标卡 + 其余卡（其余卡用来验「不连坐」）。 */
    const CARDS = `JSON.stringify((() => {
      const cards = [...document.querySelectorAll('.cover-card')]
      const titleOf = (c) => { const t = c.querySelector('.cover-title'); return t ? (t.textContent || '') : '' }
      const target = cards.find((c) => titleOf(c).includes(${JSON.stringify(TARGET_MARK)}))
      const stateOf = (c) => {
        const imgs = [...c.querySelectorAll('img')].map((i) => ({
          src: i.getAttribute('src') || '',
          complete: !!i.complete,
          w: i.naturalWidth,
          display: getComputedStyle(i).display,
          rectW: Math.round(i.getBoundingClientRect().width),
        }))
        const thumb = c.querySelector('.cover-thumb')
        return {
          imgs,
          poster: !!c.querySelector('.cover-poster-grad'),
          letter: !!c.querySelector('.cover-letter'),
          bg: thumb ? thumb.style.background || thumb.style.backgroundColor || '' : '',
        }
      }
      const others = cards.filter((c) => c !== target).map(stateOf)
      return {
        cards: cards.length,
        found: !!target,
        target: target ? stateOf(target) : null,
        othersBad: others.filter((o) => o.imgs.some((i) => i.display === 'none' || (i.complete && i.w === 0))).length,
        othersWithImg: others.filter((o) => o.imgs.some((i) => i.w > 0 && i.display !== 'none')).length,
      }
    })())`
    const cards = async () => {
      const raw = await ev(CARDS)
      return raw ? JSON.parse(raw) : null
    }
    /** 等卡片状态落定：连续两次读数一致才返回。
     *  为什么要等：首次进库页时 hh://thumb/g1 的请求还没回来，img 处于
     *  complete=false 的加载中态——这时候断言「没有失败图」读到的是假象。
     *  等的是「请求有结果」这件事，不是等结论：如果实现真把图留成
     *  display:none 的残片，状态会稳定在「有 img 且失败」，断言照样红。
     *  超时也把最后一次读数带回去，失败消息里能看到当时真实状态。 */
    const settledCards = async (label, timeoutMs = 15000) => {
      let last = null
      let prev = null
      try {
        await waitFor(
          async () => {
            last = await cards()
            if (!last || !last.found) return false
            const same = prev !== null && JSON.stringify(prev) === JSON.stringify(last)
            prev = last
            return same
          },
          { timeoutMs, intervalMs: 120, label },
        )
      } catch {
        /* 没落定也要继续：断言消息里带实际状态 */
      }
      return last
    }
    const failedImgs = (s) => (s ? s.imgs.filter((i) => i.complete && i.w === 0) : [])
    const hiddenImgs = (s) => (s ? s.imgs.filter((i) => i.display === 'none') : [])
    // 启动页是 home 仪表盘——先等应用就绪再导航，慢机上侧栏没渲染就点导航是时序假红
    await waitFor(() => ev('!!(window.hh && document.querySelector(".sidebar .nav-item"))'), { timeoutMs: 30000, label: '应用就绪（hh + 侧栏导航）' })
    await ev(`(() => { const b = document.querySelector('[data-testid="nav-library"]'); if (b) { b.click(); return 'ok' } return 'no' })()`)
    await waitFor(() => ev('!!document.querySelector(".cover-card")'), { timeoutMs: 15000, label: '库页封面墙出现（.cover-card）' })
    await waitFor(
      async () => {
        const s = await cards()
        return !!s && s.found
      },
      { timeoutMs: 15000, label: '目标卡（' + TARGET_MARK + '）出现在封面墙上' },
    )
    // ---- 前置条件：坏缩略图确实进了库数据（否则 <img> 根本不会渲染，后面全是空断言）----
    const dbg = await ev(`window.hh.listGames()`)
    const dbgTarget = Array.isArray(dbg) ? dbg.find((g) => g.id === TARGET_ID) : null
    ck(
      '造好的坏封面进了库数据（thumbPath 指向不存在的文件，<img> 会真的 404）',
      !!dbgTarget && dbgTarget.thumbPath === BROKEN_FILE && !existsSync(BROKEN_FILE),
      'thumbPath=' + (dbgTarget && dbgTarget.thumbPath) + ' expect=' + BROKEN_FILE,
    )
    // ---- 初始状态：破图卡必须是「占位」，不是「失败的图」----
    // 先等这个请求真的有结果：complete=false 的加载中态会稳定几百毫秒，
    // 只靠「两次读数一致」会把它当成落定态，读到的是假象。
    try {
      await waitFor(
        async () => {
          const s = await cards()
          const t = s && s.found ? s.target : null
          return !!t && t.imgs.every((i) => i.complete)
        },
        { timeoutMs: 15000, label: '目标卡封面请求完成（404 也是完成）' },
      )
    } catch {
      /* 请求一直不落定也继续：断言消息里会带当时的 img 状态 */
    }
    const s1 = await settledCards('目标卡封面加载结果落定（404 后进入失败态）')
    ck('目标卡在封面墙上', !!s1 && s1.found === true, JSON.stringify(s1 && { cards: s1.cards, found: s1.found }))
    ck(
      '坏卡里没有加载失败的 <img>（旧实现会留一块 display:none 的破图）',
      !!s1 && s1.found && failedImgs(s1.target).length === 0 && hiddenImgs(s1.target).length === 0,
      'imgs=' + JSON.stringify(s1 && s1.target && s1.target.imgs),
    )
    ck(
      '坏卡里没有残留的 hh://thumb 图（状态驱动 = v-if 过滤掉，而不是隐藏）',
      !!s1 && s1.found && (s1.target.imgs || []).length === 0,
      'imgs=' + JSON.stringify(s1 && s1.target && s1.target.imgs),
    )
    ck(
      '坏卡显示占位（海报渐变 + 大字标题）',
      !!s1 && s1.found && s1.target.poster === true && s1.target.letter === true,
      'poster=' + (s1 && s1.target && s1.target.poster) + ' letter=' + (s1 && s1.target && s1.target.letter),
    )
    ck(
      '占位带主色底（g.color 落到 .cover-thumb 的内联背景）',
      !!s1 && s1.found && /rgb|#/.test(String(s1.target.bg || '')),
      'bg=' + JSON.stringify(s1 && s1.target && s1.target.bg),
    )
    ck(
      '其余封面没有被连坐（无隐藏图 / 无失败图，且确有别的卡真的出了图）',
      !!s1 && s1.othersBad === 0 && s1.othersWithImg >= 1,
      'othersBad=' + (s1 && s1.othersBad) + ' othersWithImg=' + (s1 && s1.othersWithImg),
    )
    // ---- 回收再回来：RecycleScroller 复用卡片 DOM 是这起事故的根因 ----
    // 默认窗口下 12 张卡 4 行基本全部落在 buffer 里、不会被回收，所以先缩视口
    // 逼出真回收（1000×520：中栏只剩 2 列 × 6 行），再滚到库底。
    await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 520, deviceScaleFactor: 1, mobile: false })
    await waitFor(() => ev('window.innerWidth === 1000'), { timeoutMs: 5000, label: '窄视口 1000 生效' })
    await waitFor(
      () => ev(`document.querySelector('.cover-wall .scroller .grid-row .cover-card') ? document.querySelector('.cover-wall .scroller .grid-row').querySelectorAll(':scope > .cover-card').length === 2 : false`),
      { timeoutMs: 8000, label: '窄视口下网格回落成 2 列（保证有多行可回收）' },
    )
    // 给目标卡节点做个标记：滚走后它必须从文档里消失（= 真的被回收，不是没滚动）
    const marked = await ev(`(() => {
      const cards = [...document.querySelectorAll('.cover-card')]
      const titleOf = (c) => { const t = c.querySelector('.cover-title'); return t ? (t.textContent || '') : '' }
      const t = cards.find((c) => titleOf(c).includes(${JSON.stringify(TARGET_MARK)}))
      if (!t) return 'no-target'
      window.__fallbackTarget = t
      window.__fallbackScroll = t.closest('.scroller')
      return document.contains(window.__fallbackTarget) ? 'ok' : 'not-in-doc'
    })()`)
    const scroll = await ev(`(() => {
      const sc = window.__fallbackScroll
      if (!sc) return JSON.stringify({ ok: false })
      const max = sc.scrollHeight - sc.clientHeight
      sc.scrollTop = max
      return JSON.stringify({ ok: max > 40, max, rows: sc.querySelectorAll('.grid-row-item').length })
    })()`)
    let recycled = false
    try {
      await waitFor(() => ev('!document.contains(window.__fallbackTarget)'), { timeoutMs: 6000, label: '滚到库底后目标行被 RecycleScroller 回收' })
      recycled = true
    } catch {
      /* 没被回收也要继续：下面 ck 会把实际状态报出来 */
    }
    // 滚回顶部，等目标卡重新出现（此时是复用过的 DOM / 新节点）
    await ev(`(() => { const sc = window.__fallbackScroll; if (sc) sc.scrollTop = 0 })()`)
    await waitFor(
      async () => {
        const s = await cards()
        return !!s && s.found
      },
      { timeoutMs: 8000, label: '滚回顶部后目标卡重新出现' },
    )
    const s2 = await settledCards('滚动回收后目标卡状态落定')
    ck('滚走后目标行真的被回收（DOM 复用场景成立）', recycled && marked === 'ok', 'marked=' + marked + ' scroll=' + scroll)
    ck(
      '回收后再滚回来：坏卡仍是占位、仍无失败/隐藏的 <img>',
      !!s2 &&
        s2.found &&
        failedImgs(s2.target).length === 0 &&
        hiddenImgs(s2.target).length === 0 &&
        s2.target.poster === true,
      'imgs=' + JSON.stringify(s2 && s2.target && s2.target.imgs) + ' poster=' + (s2 && s2.target && s2.target.poster),
    )
    ck(
      '回收后再滚回来：其余封面仍不连坐（display:none 的老实现会在这里丢图）',
      !!s2 && s2.othersBad === 0 && s2.othersWithImg >= 1,
      'othersBad=' + (s2 && s2.othersBad) + ' othersWithImg=' + (s2 && s2.othersWithImg),
    )
    await send('Emulation.clearDeviceMetricsOverride')
    await waitFor(() => ev('window.innerWidth !== 1000'), { timeoutMs: 5000, label: '恢复窗口视口' })
    // ---- 恢复路径：写入真实封面 + 换一批卡片（切分类再切回）----
    copyFileSync(join(DATA_DIR, 'covers', 'g2.png'), BROKEN_FILE)
    ck('恢复素材已写到原坏路径', existsSync(BROKEN_FILE), BROKEN_FILE)
    const chipClick = async (label) =>
      ev(`(() => { const b = [...document.querySelectorAll('.cat-chip')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)}); if (b) { b.click(); return 'ok' } return 'no-chip' })()`)
    const chipAll = await chipClick('全部')
    const chipCat = await chipClick('全年龄')
    // 切分类后目标卡离场 = filteredGames 身份真的换了（CoverGrid 的 watch(games) 会清 brokenImgs）
    await waitFor(
      () => ev(`![...document.querySelectorAll('.cover-title')].some((x) => (x.textContent || '').includes(${JSON.stringify(TARGET_MARK)}))`),
      { timeoutMs: 6000, label: '切到「全年龄」后目标卡离场（换了一批卡片）' },
    )
    await chipClick('全部')
    let recovered = false
    try {
      await waitFor(
        async () => {
          const s = await cards()
          const img = s && s.found ? s.target.imgs.find((i) => i.complete && i.w > 0) : null
          return !!img
        },
        { timeoutMs: 20000, label: '换回「全部」后目标卡封面重新加载成功' },
      )
      recovered = true
    } catch {
      /* 没恢复也要继续：下面 ck 会把实际状态报出来 */
    }
    const s3 = await settledCards('恢复后目标卡状态落定', 8000)
    ck('换一批后图片回来（naturalWidth > 0，走 hh://thumb 协议）', recovered && !!s3 && s3.found && s3.target.imgs.some((i) => i.w > 0), 'imgs=' + JSON.stringify(s3 && s3.target && s3.target.imgs) + ' chips=' + chipAll + '/' + chipCat)
    ck(
      '图片回来后占位层已撤掉（v-if 跟着状态走，没有残留双影）',
      !!s3 && s3.found && s3.target.poster === false && s3.target.letter === false,
      'poster=' + (s3 && s3.target && s3.target.poster) + ' letter=' + (s3 && s3.target && s3.target.letter),
    )
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
