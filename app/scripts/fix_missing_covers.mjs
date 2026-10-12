// 一次性补齐：对缺封面的游戏走真实刮削管线（scrapeSearch → scrapeApply）。
// 端到端验证修复后的 applyScrape：不带封面不清旧封面、下载过质量闸。
// 用法：node scripts/fix_missing_covers.mjs
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const APP_ROOT = process.cwd()
const PORT = '9342'

const exe = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
// Electron 44 不接受 --disable-gpu（bad option）；ELECTRON_RUN_AS_NODE 会让
// electron.exe 退化成纯 Node，必须清掉（同 probe_covers.mjs 的两条注记）。
const env = { ...process.env, HANEHANA_DEBUG_PORT: PORT }
delete env.ELECTRON_RUN_AS_NODE
delete env.HANEHANA_SCRAPE_MOCK_FILE // 真网络刮削，别吃 mock
const proc = spawn(exe, ['.'], { cwd: APP_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let stderr = ''
proc.stderr.on('data', (d) => {
  stderr += d.toString()
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getWsUrl() {
  for (let i = 0; i < 80; i++) {
    const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)
    if (m) return m[1]
    await sleep(500)
  }
  throw new Error('no DevTools line: ' + stderr.slice(0, 800))
}

try {
  const wsUrl = await getWsUrl()
  await sleep(3000)
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('ws open timeout')), 10000)
    ws.onopen = () => {
      clearTimeout(to)
      res()
    }
    ws.onerror = (e) => {
      clearTimeout(to)
      rej(new Error('ws error ' + (e?.message || '')))
    }
  })

  let msgId = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  let sessionId = null
  const sendRaw = (method, params = {}) =>
    new Promise((res, rej) => {
      const mid = ++msgId
      pending.set(mid, res)
      ws.send(JSON.stringify(sessionId ? { id: mid, method, params, sessionId } : { id: mid, method, params }))
      // 刮削要等网络（单源 12s 超时 ×2 源），宽限到 40s
      setTimeout(() => {
        if (pending.has(mid)) {
          pending.delete(mid)
          rej(new Error('cdp timeout: ' + method))
        }
      }, 40000)
    })

  const targets = await sendRaw('Target.getTargets')
  const page = (targets.result?.targetInfos || []).find((t) => t.type === 'page')
  if (!page) throw new Error('no page target')
  const att = await sendRaw('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  sessionId = att.result?.sessionId
  const evalJs = async (expr) => {
    const r = await sendRaw('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails)
      return { __err: String(r.result?.exceptionDetails.exception?.description ?? 'eval failed') }
    return r.result?.result?.value
  }

  // 主逻辑全在页面上下文里跑：找无封面的游戏 → 搜索 → 应用首个带封面的结果
  const result = await evalJs(`(async () => {
    const games = await window.hh.listGames()
    const out = []
    for (const g of games.filter(x => !x.coverPath)) {
      const s = await window.hh.scrapeSearch(g.title)
      const cand = (s.results || []).find(c => c.coverUrl)
      if (!cand) {
        out.push({ id: g.id.slice(0,8), title: g.title, ok: false, why: 'no cover result', warnings: s.warnings || [], hits: (s.results||[]).length })
        continue
      }
      const ap = await window.hh.scrapeApply(g.id, cand)
      const fresh = (await window.hh.listGames()).find(x => x.id === g.id)
      out.push({ id: g.id.slice(0,8), title: g.title, ok: !!ap.ok, error: ap.error, provider: cand.provider, gotCover: !!fresh.coverPath, warnings: s.warnings || [] })
    }
    return out
  })()`)

  console.log(JSON.stringify(result, null, 2))

  // 等 ensureThumb + persistCoalesced 落盘后再验缩略图
  await sleep(2500)
  const after = await evalJs(`(async () => {
    const g = await window.hh.listGames()
    return g.map(x => ({ id: x.id.slice(0,8), title: x.title, hasCover: !!x.coverPath, hasThumb: !!x.thumbPath, color: x.color || '' }))
  })()`)
  console.log('=== 应用后状态 ===')
  console.log(JSON.stringify(after, null, 1))

  ws.close()
} catch (e) {
  console.error('FIX FAIL:', e.message)
  console.error('stderr tail:', stderr.slice(-800))
  process.exitCode = 1
} finally {
  proc.kill()
}
