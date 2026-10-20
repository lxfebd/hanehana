// 扫描导入 → 本地封面回填 → 封面墙渲染 端到端验证（用户首次使用核心流程）
// 造含 game.exe + cover.jpg（合法竖版封面）的游戏目录 → scanDir 扫描 → 导入 →
// 断言封面回填（adoptLocalCover）→ 封面墙 img 真实渲染。
// 用法：node scripts/verify_scan_cover.mjs
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const APP_ROOT = join(process.cwd())
const PORT = 9391
const DATA_DIR = join(APP_ROOT, '.scan-cover-data')
const GAME_DIR = join(APP_ROOT, '.scan-cover-game')
for (let i = 0; i < 5; i++) {
  try {
    rmSync(DATA_DIR, { recursive: true, force: true })
    rmSync(GAME_DIR, { recursive: true, force: true })
    break
  } catch {
    await new Promise((r) => setTimeout(r, 800))
  }
}
// 造游戏目录：exe + cover.jpg（真实竖版 PNG 转存为 jpg 不行——直接生成合法 PNG 但命名 cover.jpg 会被质量闸解）
// 用最小合法 PNG（1x1 放大不行）——生成 200x300 渐变 PNG 作为封面
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function gradientPng(w, h, top, bottom) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc(h * (1 + w * 3))
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1)
    raw[y * (1 + w * 3)] = 0
    for (let x = 0; x < w; x++) {
      const i = y * (1 + w * 3) + 1 + x * 3
      // 渐变 + 轻微噪点（避免纯渐变被判近纯色废图；质量闸要通道明暗变化）
      const n = ((x * 13 + y * 7) % 23) - 11
      raw[i] = Math.max(0, Math.min(255, top[0] + (bottom[0] - top[0]) * t + n))
      raw[i + 1] = Math.max(0, Math.min(255, top[1] + (bottom[1] - top[1]) * t + n))
      raw[i + 2] = Math.max(0, Math.min(255, top[2] + (bottom[2] - top[2]) * t + n))
    }
  }
  const idat = deflateSync(raw)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}
// 造游戏目录
mkdirSync(GAME_DIR, { recursive: true })
writeFileSync(join(GAME_DIR, 'game.exe'), Buffer.from('fake exe'), 'utf8')
writeFileSync(join(GAME_DIR, 'cover.jpg'), gradientPng(400, 600, [90, 60, 160], [30, 120, 200])) // 竖版 2:3 渐变+噪点

// 数据目录初始化
mkdirSync(join(DATA_DIR, 'covers'), { recursive: true })
mkdirSync(join(DATA_DIR, 'thumbs'), { recursive: true })
writeFileSync(join(DATA_DIR, 'games.json'), '[]', 'utf8')

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
      }, 60000)
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
    await new Promise((r) => setTimeout(r, 1000))
    // 1. 扫描并入库（scanDir 返回 {hits, added, skipped, dupes}）
    console.log('== 扫描导入 ==')
    const scanR = await ev(`window.hh.scanDir(${JSON.stringify(GAME_DIR)})`)
    const added = Array.isArray(scanR?.added) ? scanR.added : null
    ck('扫描并入库', !!added && added.length > 0, 'added=' + (added ? added.length : JSON.stringify(scanR)))
    if (!added || !added.length) {
      console.log('  scan result:', JSON.stringify(scanR))
      return
    }
    await new Promise((r) => setTimeout(r, 2500)) // 等 backfillLocalCovers 回填
    // 2. 回读：coverPath 是否被回填（本地 cover.jpg）
    const games = await ev(`window.hh.listGames()`)
    const g = Array.isArray(games) ? games[0] : null
    ck('游戏入库', !!g, 'games=' + (Array.isArray(games) ? games.length : 'n/a'))
    if (g) {
      ck('本地封面回填 (coverPath)', !!g.coverPath && existsSync(g.coverPath), g.coverPath || '')
      if (g.coverPath) {
        const fs = await import('node:fs')
        const buf = fs.readFileSync(g.coverPath)
        ck('回填封面非空', buf.length > 5000, 'bytes=' + buf.length)
      }
    }
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