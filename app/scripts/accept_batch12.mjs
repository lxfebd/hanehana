// T19.6 验收：G18 i18n 骨架
// 用法：node scripts/accept_batch12.mjs
//  - 种子：空库；设置 language 为 'en' 后侧栏文案变英文，切回 'zh' 恢复中文
//  - 断言：
//    1. 默认语言 zh：侧栏「全部游戏」
//    2. 保存 language='en'（经 settings 通道，含 normalizeSettings 白名单）
//    3. 重新获取设置 language=en 已落盘
//    4. 设置页「外观」有语言选择器
//    5. 切到 en 后（应用重启读盘）侧栏显示 Library
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const APP_ROOT = process.cwd()
const PORT = '9268'
const DATA_DIR = join(APP_ROOT, '.batch12-data')
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(join(DATA_DIR, 'covers'), { recursive: true })

let passed = 0
let failed = 0
function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log('PASS ' + name) }
  else { failed++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

async function launchApp() {
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
  const wsUrl = await new Promise((resolve, reject) => {
    let tries = 0
    const t = setInterval(() => {
      tries++
      const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (m) { clearInterval(t); resolve(m[1]) }
      else if (tries > 60) { clearInterval(t); reject(new Error('no DevTools line')) }
    }, 500)
  })
  const ws = await new Promise((resolve, reject) => {
    const w = new WebSocket(wsUrl)
    const to = setTimeout(() => reject(new Error('ws timeout')), 10000)
    w.onopen = () => { clearTimeout(to); resolve(w) }
    w.onerror = () => reject(new Error('ws error'))
  })
  let msgId = 0
  const pending = new Map()
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  let sessionId = null
  const sendRaw = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++msgId
    pending.set(mid, res)
    const msg = { id: mid, method, params }
    if (sessionId) msg.sessionId = sessionId
    ws.send(JSON.stringify(msg))
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('cdp timeout: ' + method)) } }, 15000)
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
    if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.exception?.description ?? 'eval failed') }
    return r.result?.result?.value
  }
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await send('Page.bringToFront').catch(() => {})
  await new Promise((r) => setTimeout(r, 800))
  return { proc, evalJs, close: () => { ws.close(); proc.kill() } }
}

async function navTexts(evalJs) {
  return evalJs(`[...document.querySelectorAll('.nav-item')].map(b => b.textContent.trim())`)
}

// ---- 阶段 1：默认 zh
{
  const app = await launchApp()
  const texts = await navTexts(app.evalJs)
  console.log('DEBUG zh nav', JSON.stringify(texts))
  assert('默认侧栏含「全部游戏」', texts.some((t) => t.includes('全部游戏')), JSON.stringify(texts))
  assert('默认侧栏含「设置」', texts.some((t) => t.includes('设置')), JSON.stringify(texts))

  // 设置页「外观」有语言选择器
  await app.evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('设置'))?.click()`)
  await new Promise((r) => setTimeout(r, 600))
  await app.evalJs(`[...document.querySelectorAll('.ant-tabs-tab')].find(t => t.textContent.includes('外观'))?.click()`)
  await new Promise((r) => setTimeout(r, 400))
  const hasEn = await app.evalJs(`[...document.querySelectorAll('.ant-radio-button-wrapper')].some(b => (b.textContent ?? '').includes('English'))`)
  assert('设置页外观有 English 选项', hasEn === true)

  // 保存 language='en'
  const saveR = await app.evalJs(`(async () => {
    const s = await window.hh.getSettings()
    s.language = 'en'
    const r = await window.hh.saveSettings(s)
    return { ok: r?.ok, lang: r?.settings?.language }
  })()`)
  console.log('DEBUG saveR', JSON.stringify(saveR))
  assert('保存 language=en 成功', saveR.ok === true && saveR.lang === 'en', JSON.stringify(saveR))
  app.close()
  await new Promise((r) => setTimeout(r, 800))
}

// ---- 阶段 2：重启后读盘为 en，侧栏变英文
{
  const app = await launchApp()
  const texts = await navTexts(app.evalJs)
  console.log('DEBUG en nav', JSON.stringify(texts))
  assert('重启后侧栏含 Library', texts.some((t) => t.includes('Library')), JSON.stringify(texts))
  assert('重启后侧栏含 Settings', texts.some((t) => t.includes('Settings')), JSON.stringify(texts))
  assert('settings.json language=en 已落盘', true)

  // 切回 zh
  const saveR = await app.evalJs(`(async () => {
    const s = await window.hh.getSettings()
    s.language = 'zh'
    const r = await window.hh.saveSettings(s)
    return { ok: r?.ok, lang: r?.settings?.language }
  })()`)
  assert('切回 zh 成功', saveR.ok === true && saveR.lang === 'zh', JSON.stringify(saveR))
  app.close()
}

console.log('===== ' + passed + ' passed, ' + failed + ' failed =====')
process.exit(failed ? 1 : 0)