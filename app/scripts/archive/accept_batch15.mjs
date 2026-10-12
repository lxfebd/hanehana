// R1 批次验收：P0-1 on-accent 可读性 + P0-2 antd seed 随 preset + P0-6 语言即时生效
// 用法：node scripts/accept_batch15.mjs   （须先 npm run build）
//  - P0-1：添加游戏对话框 .path-input 文字色 = text-strong（不再误用 on-accent）；
//          --hh-color-on-success 已生成且为实色 hex
//  - P0-2：切主题套件保存后，--hh-color-window-fallback 与设置页复选框派生色跟着变
//          （旧 bug：antd seed 写死樱夜一套，切套件不跟随）
//  - P0-6：外观页签切 English → 保存 → 不刷新页面 .empty-text 立即变英文
//  - 结束恢复语言/套件到启动时原值
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const here = join(process.cwd(), 'scripts')
const APP_ROOT = process.cwd()
const PORT = '9272'
const DATA_DIR = join(APP_ROOT, '.batch15-data')
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })

const seed = spawn(process.execPath, [join(here, 'seed_layout.mjs'), DATA_DIR], {
  stdio: ['ignore', 'inherit', 'inherit'],
})
await new Promise((res) => seed.on('exit', res))
if (seed.exitCode !== 0) throw new Error('seed_layout failed')

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

let passed = 0
let failed = 0
function assert(name, cond, extra = '') {
  if (cond) {
    passed++
    console.log('PASS ' + name)
  } else {
    failed++
    console.log('FAIL ' + name + (extra ? ' :: ' + extra : ''))
  }
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

  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await send('Page.bringToFront').catch(() => {})

  try {
    // 干净起点
    await send('Page.reload', { ignoreCache: true })
    await wait(3500)
    const boot = await evalJs(`document.querySelector('.tag')?.textContent ?? ''`)
    console.log('BOOT:', boot)

    const orig = await evalJs(
      `window.hh.getSettings().then(s => ({ language: s.language, theme_preset: s.theme_preset, dark: s.dark, theme_mode: s.theme_mode }))`,
    )
    console.log('ORIG_SETTINGS:', JSON.stringify(orig))
    assert('启动时读到设置', !!orig && !orig.__err, JSON.stringify(orig))

    // ---------- P0-1a：path-input 文字色 = text-strong ----------
    await evalJs(`[...document.querySelectorAll('.nav-item')].find(e => e.textContent.includes('添加游戏'))?.click()`)
    await wait(900)
    const colors = await evalJs(`(() => {
      const inp = document.querySelector('.path-input')
      if (!inp) return null
      const probe = document.createElement('span')
      document.body.appendChild(probe)
      probe.style.color = 'var(--hh-color-text-strong)'
      const expect = getComputedStyle(probe).color
      probe.style.color = 'var(--hh-color-on-accent)'
      const onAcc = getComputedStyle(probe).color
      probe.remove()
      return { actual: getComputedStyle(inp).color, expect, onAcc }
    })()`)
    console.log('PATH_INPUT_COLORS:', JSON.stringify(colors))
    assert('path-input 已显示（对话框打开）', !!colors && !colors.__err, JSON.stringify(colors))
    assert(
      'path-input 文字色 = text-strong',
      colors?.actual === colors?.expect,
      String(colors?.actual) + ' vs ' + String(colors?.expect),
    )
    assert('path-input 文字色 ≠ on-accent（旧 bug 已修）', colors?.actual !== colors?.onAcc, String(colors?.actual))
    // 关掉对话框
    await evalJs(`document.querySelector('.ant-modal-close')?.click()`)
    await wait(600)

    // ---------- P0-1b：on-success token 已生成 ----------
    const tok = await evalJs(`(() => {
      const cs = getComputedStyle(document.documentElement)
      return {
        onSuccess: cs.getPropertyValue('--hh-color-on-success').trim(),
        success: cs.getPropertyValue('--hh-color-success').trim(),
      }
    })()`)
    console.log('TOKENS:', JSON.stringify(tok))
    assert(
      '--hh-color-on-success 已生成',
      typeof tok?.onSuccess === 'string' && tok.onSuccess.startsWith('#') && tok.onSuccess.length >= 7,
      String(tok?.onSuccess),
    )
    assert(
      '--hh-color-success 仍为实色',
      typeof tok?.success === 'string' && tok.success.startsWith('#'),
      String(tok?.success),
    )

    // ---------- P0-2：antd seed 随 preset ----------
    const fb0 = await evalJs(
      `getComputedStyle(document.documentElement).getPropertyValue('--hh-color-window-fallback').trim()`,
    )
    await evalJs(`[...document.querySelectorAll('.nav-item')].find(e => e.textContent.includes('设置'))?.click()`)
    await wait(900)
    const cb0 = await evalJs(`(() => {
      const el = document.querySelector('.ant-checkbox-inner')
      if (!el) return null
      const s = getComputedStyle(el)
      return { border: s.borderColor, bg: s.backgroundColor }
    })()`)
    console.log('CHECKBOX_BEFORE:', JSON.stringify(cb0))
    assert('设置页复选框可见', !!cb0 && !cb0.__err, JSON.stringify(cb0))

    // 切到外观页签，选一个非当前套件
    await evalJs(`[...document.querySelectorAll('.ant-tabs-tab')].find(e => e.textContent.includes('外观'))?.click()`)
    await wait(500)
    const switched = await evalJs(`(() => {
      const next = document.querySelector('.preset-card:not(.active)')
      if (!next) return false
      next.click()
      return next.querySelector('.preset-name')?.textContent ?? 'picked'
    })()`)
    console.log('PRESET_SWITCHED_TO:', switched)
    assert('已点选另一套主题', switched !== false, String(switched))
    await wait(300)
    const clickedSave = await evalJs(`(() => {
      const b = [...document.querySelectorAll('.ant-modal-wrap button')].find(x => x.textContent.replace(/\\s/g, '') === '保存' && !x.disabled)
      if (b) { b.click(); return true }
      return false
    })()`)
    assert('保存按钮已点击', clickedSave === true, String(clickedSave))
    await wait(2500)
    const fb1 = await evalJs(
      `getComputedStyle(document.documentElement).getPropertyValue('--hh-color-window-fallback').trim()`,
    )
    console.log('FALLBACK:', fb0, '->', fb1)
    assert('window-fallback 随套件变化', !!fb1 && fb1 !== fb0, String(fb0) + ' -> ' + String(fb1))

    // 重开设置，读复选框派生色（antd seed 链）
    await evalJs(`[...document.querySelectorAll('.nav-item')].find(e => e.textContent.includes('设置'))?.click()`)
    await wait(900)
    const cb1 = await evalJs(`(() => {
      const el = document.querySelector('.ant-checkbox-inner')
      if (!el) return null
      const s = getComputedStyle(el)
      return { border: s.borderColor, bg: s.backgroundColor }
    })()`)
    console.log('CHECKBOX_AFTER:', JSON.stringify(cb1))
    const cbChanged = !!cb0 && !!cb1 && (cb0.border !== cb1.border || cb0.bg !== cb1.bg)
    assert('antd 复选框派生色随套件变化（seed 已跟随）', cbChanged, JSON.stringify(cb0) + ' -> ' + JSON.stringify(cb1))
    await evalJs(`document.querySelector('.ant-modal-close')?.click()`)
    await wait(600)

    // ---------- P0-6：语言保存后即时生效（不刷新） ----------
    const emptyZh = await evalJs(`document.querySelector('.empty-text')?.textContent ?? ''`)
    console.log('EMPTY_BEFORE:', emptyZh)
    await evalJs(
      `[...document.querySelectorAll('.nav-item')].find(e => e.textContent.includes('设置') || e.textContent.includes('Settings'))?.click()`,
    )
    await wait(900)
    await evalJs(`[...document.querySelectorAll('.ant-tabs-tab')].find(e => e.textContent.includes('外观'))?.click()`)
    await wait(500)
    const pickedEn = await evalJs(`(() => {
      const b = [...document.querySelectorAll('.ant-radio-button-wrapper')].find(x => x.textContent.trim() === 'English')
      if (b) { b.click(); return true }
      return false
    })()`)
    assert('已选 English', pickedEn === true, String(pickedEn))
    await wait(300)
    const savedEn = await evalJs(`(() => {
      const b = [...document.querySelectorAll('.ant-modal-wrap button')].find(x => x.textContent.replace(/\\s/g, '') === '保存' && !x.disabled)
      if (b) { b.click(); return true }
      return false
    })()`)
    assert('保存（English）已点击', savedEn === true, String(savedEn))
    await wait(2500)
    const emptyEn = await evalJs(`document.querySelector('.empty-text')?.textContent ?? ''`)
    const diskLang = await evalJs(`window.hh.getSettings().then(s => s.language)`)
    console.log('EMPTY_AFTER:', emptyEn, 'DISK_LANG:', diskLang)
    assert('未刷新页面 .empty-text 已变英文', emptyEn === 'Click a cover to view details', String(emptyEn))
    assert('settings.language=en 已落盘', diskLang === 'en', String(diskLang))

    // ---------- 恢复语言/套件/明暗到启动原值（整份 settings 覆盖，防丢其他字段） ----------
    const restored = await evalJs(`window.hh.getSettings().then(s => window.hh.saveSettings({
      ...s,
      language: ${JSON.stringify(orig?.language ?? 'zh')},
      theme_preset: ${JSON.stringify(orig?.theme_preset ?? 'sakura')},
      dark: ${JSON.stringify(orig?.dark ?? true)},
      theme_mode: ${JSON.stringify(orig?.theme_mode ?? 'system')},
    }).then(r => !!(r && r.ok)))`)
    console.log('RESTORE:', restored)
    assert('已恢复启动时设置', restored === true, String(restored))
  } finally {
    console.log(`\n==== ${passed} passed, ${failed} failed ====`)
    ws.close()
    proc.kill()
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  try {
    proc.kill()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
