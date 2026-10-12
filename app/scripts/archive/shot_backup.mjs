// T17 视觉验收：备份对话框 + 详情面板备份入口截图
// 用法：node scripts/shot_backup.mjs
//  - 种子：真实存档目录 + games.json
//  - 打开详情面板 → 点「备份记录」→ 截图对话框
//  - 再创建一个快照 → 重新打开截图
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { spawn } from 'node:child_process'

const here = join(process.cwd(), 'scripts')
const APP_ROOT = process.cwd()
const PORT = '9262'
const DATA_DIR = join(APP_ROOT, '.shot-backup-data')
const GAME_DIR = join(APP_ROOT, '.shot-backup-game')
rmSync(DATA_DIR, { recursive: true, force: true })
rmSync(GAME_DIR, { recursive: true, force: true })
mkdirSync(join(DATA_DIR, 'covers'), { recursive: true })
mkdirSync(join(GAME_DIR, 'save'), { recursive: true })
mkdirSync(join(GAME_DIR, 'GameData'), { recursive: true })
writeFileSync(join(GAME_DIR, 'save', 'global.dat'), 'x'.repeat(20), 'utf8')
writeFileSync(join(GAME_DIR, 'save', 'slot1.dat'), 'y'.repeat(10), 'utf8')
writeFileSync(join(GAME_DIR, 'save', 'config.ini'), '[options]\n', 'utf8')
writeFileSync(join(GAME_DIR, 'GameData', 'profile.sav'), 'profile', 'utf8')
writeFileSync(join(GAME_DIR, 'game.exe'), 'EXE', 'utf8')

// 渐变封面（复用 seed_layout 的编码器摘要：直接生成一张 240x320 图）
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
    const row = y * (1 + w * 3)
    raw[row] = 0
    for (let x = 0; x < w; x++) {
      const off = row + 1 + x * 3
      raw[off] = Math.round(top[0] + (bottom[0] - top[0]) * t)
      raw[off + 1] = Math.round(top[1] + (bottom[1] - top[1]) * t)
      raw[off + 2] = Math.round(top[2] + (bottom[2] - top[2]) * t)
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}
writeFileSync(join(DATA_DIR, 'covers', 'g1.png'), gradientPng(240, 320, [124, 111, 168], [58, 48, 92]))

const now = Date.now()
const games = [
  {
    id: 'g1',
    dir: GAME_DIR,
    exePath: join(GAME_DIR, 'game.exe'),
    rawTitle: 'YuzuSakura',
    title: '千恋＊万花 千恋＊万花',
    titleNative: '千恋＊万花',
    coverPath: join(DATA_DIR, 'covers', 'g1.png'),
    releaseDate: '2016-07-29',
    rating: 8.4,
    tags: ['柚子社', '废萌', '恋爱'],
    categories: [],
    sources: [{ provider: 'vndb', id: 'v1' }],
    playMs: 12400000,
    useLE: false,
    useMagpie: false,
    addedAt: now,
    favorite: true,
    backupEnabled: true,
    developer: '柚子社 Yuzusoft',
    description: '柚子社招牌废萌作品。故事发生在温泉旅馆经营的小镇，主人公与多位女主角的夏日恋爱物语。',
  },
]
writeFileSync(join(DATA_DIR, 'games.json'), JSON.stringify(games, null, 2), 'utf8')

const exe = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const proc = spawn(exe, ['--disable-gpu', '.'], {
  cwd: APP_ROOT,
  env: { ...process.env, HANEHANA_DEBUG_PORT: String(PORT), HANEHANA_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
let stderr = ''
proc.stderr.on('data', (d) => {
  stderr += d.toString()
  const line = d.toString().trim()
  if (line.includes('[hanehana]') || /Error/.test(line)) process.stdout.write('[app] ' + line.slice(0, 300) + '\n')
})
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
  const ws = await connectWs(wsUrl)
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
      const msg = { id: mid, method, params }
      if (sessionId) msg.sessionId = sessionId
      ws.send(JSON.stringify(msg))
      setTimeout(() => {
        if (pending.has(mid)) {
          pending.delete(mid)
          rej(new Error('cdp timeout: ' + method))
        }
      }, 15000)
    })
  const targets = await sendRaw('Target.getTargets')
  const page = (targets.result?.targetInfos || []).find((t) => t.type === 'page')
  if (!page) throw new Error('no page target')
  const att = await sendRaw('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  sessionId = att.result?.sessionId
  if (!sessionId) throw new Error('attach failed')
  const send = (method, params = {}) => sendRaw(method, params)
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails)
      return { __err: String(r.result.exceptionDetails.exception?.description ?? 'eval failed') }
    return r.result?.result?.value
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  async function shot(name) {
    // CDP 截屏在本机 --disable-gpu 下有已知软件渲染重影（T16 证伪：非产品 bug）；
    // 系统 CopyFromScreen 又总被前台锁挡，抓到的是本机桌面自身（也是 Electron）。
    // 这里用 CDP 截图仅作「渲染存在」的证据，布局细节以 dialog textContent 断言为准。
    await send('Page.bringToFront').catch(() => {})
    await wait(500)
    const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    if (!r.result?.data) throw new Error('no screenshot data')
    await import('node:fs').then(({ writeFileSync }) =>
      writeFileSync(join(APP_ROOT, 'scripts', 'wide_shots', name), Buffer.from(r.result.data, 'base64')),
    )
    console.log('cdp shot saved', name)
  }
  await mkdirSync(join(APP_ROOT, 'scripts', 'wide_shots'), { recursive: true })

  // 1. 创建快照（让对话框有内容可显示）
  const snap = await evalJs(
    `(async () => { const s = await window.hh.backupCreate('g1'); return { files: s?.files, dirPath: s?.dirPath } })()`,
  )
  console.log('snap', JSON.stringify(snap))

  // 2. 选中游戏卡片 → 详情面板出现 → 点「备份记录」
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await send('Page.bringToFront').catch(() => {})
  await wait(600)
  await evalJs(`document.querySelector('.cover-card')?.click()`)
  await wait(500)
  const hasFavRow = await evalJs(`[...document.querySelectorAll('.fav-btn')].map(b => b.textContent).join('|')`)
  console.log('favRow', JSON.stringify(hasFavRow))
  await shot('t17-detail-backup.png')

  // 3. 打开备份对话框
  await evalJs(`[...document.querySelectorAll('.fav-btn')].find(b => b.textContent.includes('备份记录'))?.click()`)
  await wait(700)
  await shot('t17-backup-dialog.png')

  const dialogText = await evalJs(`document.querySelector('.backup-body')?.textContent ?? ''`)
  console.log('dialog', JSON.stringify(dialogText.slice(0, 200)))

  proc.kill()
  process.exit(0)
}
try {
  await main()
} catch (e) {
  console.error('ERROR', e)
  proc.kill()
  process.exit(1)
}
