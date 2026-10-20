// 验证 YMGal 刮削全链路：seed 一款游戏 → scrapeSearch(中文名) → 取 YMGal 候选
// → scrapeApply → 读回 games.json 的 coverPath/thumbPath/color，确认封面真的落库。
// 用法：node scripts/verify_scrape_apply.mjs
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const APP_ROOT = join(process.cwd())
const PORT = 9349
const DATA_DIR = join(APP_ROOT, '.scrape-apply-data')
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(join(DATA_DIR, 'covers'), { recursive: true })
mkdirSync(join(DATA_DIR, 'thumbs'), { recursive: true })

// seed 一款游戏（真实形状：妹相随，无封面无元数据）
const GAME = {
  id: 'g-seed-1',
  title: '妹相随～黑白世界的缤纷冒险～',
  rawTitle: '妹相随～黑白世界的缤纷冒险～',
  dir: 'F:\\games\\妹相随',
  exePath: 'F:\\games\\妹相随\\game.exe',
  tags: [],
  sources: [],
  categories: [],
  favorite: false,
  playMs: 0,
  addedAt: Date.now(),
  manualEdit: false,
  variants: [],
  useLE: false,
  useMagpie: false,
}
mkdirSync(join(DATA_DIR, 'library'), { recursive: true })
writeFileSync(join(DATA_DIR, 'games.json'), JSON.stringify([GAME], null, 2), 'utf8')

const env = { ...process.env, HANEHANA_DEBUG_PORT: String(PORT), HANEHANA_DATA_DIR: DATA_DIR }
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
      }, 60000)
    })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails)
      return { __err: String(r.result.exceptionDetails.exception?.description ?? 'eval failed') }
    return r.result?.result?.value
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

    // 1. 搜索「妹相随」——验证 YMGal 出结果
    const t0 = Date.now()
    const search = await ev(`window.hh.scrapeSearch('妹相随')`)
    const dt = Date.now() - t0
    console.log(`== 搜索「妹相随」(${dt}ms) ==`)
    const results = search?.results ?? []
    const ymResults = results.filter((r) => r.provider === 'ymgal')
    ck('搜索出结果', results.length > 0, `results=${results.length}`)
    ck('YMGal 命中', ymResults.length > 0, `ymgal=${ymResults.length}`)
    if (!ymResults.length) {
      console.log('  warnings:', JSON.stringify(search?.warnings))
      return
    }
    const top = ymResults[0]
    console.log(`   [ymgal] ${top.title} | cn=${top.titleNative} | dev=${top.developer}`)
    console.log(`   COVER_FULL=${top.coverUrl}`)

    // 2. applyScrape 到 seed 的游戏——验证封面落库
    console.log('== applyScrape ==')
    const applied = await ev(`window.hh.scrapeApply('g-seed-1', ${JSON.stringify(top)})`)
    ck('applyScrape 返回 ok', applied?.ok === true, JSON.stringify(applied))
    await new Promise((r) => setTimeout(r, 2500))

    // 3. 读回游戏：coverPath / thumbPath / color 是否真的落盘
    const game = await ev(`window.hh.listGames()`)
    const g = Array.isArray(game) ? game.find((x) => x.id === 'g-seed-1') : null
    console.log('== 落库回读 ==')
    if (g) {
      ck('标题已更新', g.title === top.title, `${g.title}`)
      ck('来源已记录', (g.sources || []).some((s) => s.provider === 'ymgal'), JSON.stringify(g.sources))
      ck('开发商已写入', g.developer === top.developer, `${g.developer}`)
      ck('封面已落库 coverPath', !!g.coverPath && existsSync(g.coverPath), g.coverPath || '')
      ck('缩略图已生成 thumbPath', !!g.thumbPath && existsSync(g.thumbPath), g.thumbPath || '')
      ck('主色已提取', !!g.color && /^#[0-9a-f]{6}$/i.test(g.color), g.color || '')
      ck('汉化标签已带上', (g.tags || []).includes('汉化'), JSON.stringify(g.tags))
      if (g.coverPath) {
        const st = existsSync(g.coverPath) ? readFileSync(g.coverPath) : null
        ck('封面文件非空', st && st.length > 5000, `bytes=${st ? st.length : 0}`)
      }
      if (g.thumbPath) {
        const st = existsSync(g.thumbPath) ? readFileSync(g.thumbPath) : null
        ck('缩略图文件非空', st && st.length > 2000, `bytes=${st ? st.length : 0}`)
      }
    } else {
      ck('回读游戏存在', false, 'listGames 找不到 g-seed-1')
    }

    console.log(`\n==== ${pass} passed, ${fail} failed ====`)
    // 打印主进程 stderr 尾部（封面下载/缩略图的 console.error 诊断）
    const errTail = stderr.slice(-3000)
    if (/(封面|cover|thumb|失败|Error)/i.test(errTail)) {
      console.log('--- 主进程诊断 ---')
      console.log(errTail)
    }
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
