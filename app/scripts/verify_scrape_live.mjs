// 真实网络验证三源刮削（VNDB / Bangumi / YMGal）。
// 起真实构建的 App（开发版），经 CDP 调 window.hh.scrapeSearch(title)，
// 逐条打印各源命中数与耗时——验证「刮削不行」的修复在真实链路生效。
// 用法：node scripts/verify_scrape_live.mjs
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { rmSync, mkdirSync } from 'node:fs'

const APP_ROOT = join(process.cwd())
const PORT = 9347
const DATA_DIR = join(APP_ROOT, '.scrape-live-data')
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })

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

const titles = ['CLANNAD', '妹相随', 'Muv-Luv Alternative', 'ATRI -My Dear Moments-', '白色相簿2', '素晴らしき日々']

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
    for (const title of titles) {
      const t0 = Date.now()
      const r = await ev(`window.hh.scrapeSearch(${JSON.stringify(title)})`)
      const dt = Date.now() - t0
      if (r?.__err) {
        console.log(`=== ${title} EVAL-ERR: ${r.__err}`)
        fail++
        continue
      }
      const results = r?.results ?? []
      const warnings = r?.warnings ?? []
      const bySrc = {}
      for (const c of results) bySrc[c.provider] = (bySrc[c.provider] || 0) + 1
      const srcStr = Object.entries(bySrc).map(([k, v]) => `${k}:${v}`).join(' ')
      console.log(`=== ${title} (${dt}ms) results=${results.length} [${srcStr}] warn=${JSON.stringify(warnings)}`)
      for (const c of results.slice(0, 3)) {
        console.log(
          `   [${c.provider}] ${(c.title || '').slice(0, 30)} | cn=${(c.titleNative || '').slice(0, 16)} | dev=${(c.developer || '').slice(0, 14)} | date=${c.releaseDate || ''} | tags=${(c.tags || []).join(',')}`,
        )
      }
      const ok = results.length > 0 && Object.keys(bySrc).length >= 1
      if (ok) pass++
      else {
        fail++
        console.log(`   ✖ 无结果（warnings=${JSON.stringify(warnings)})`)
      }
    }
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
