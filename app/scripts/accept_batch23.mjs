// R9 批次验收：P2-3 i18n 扩词（37→60+，手写词典，不接 i18next）
// 用法：node scripts/accept_batch23.mjs   （须先 npm run build）
//  - 静态：zh/en 键集一致且 ≥60；无 i18next；Download/Settings 接线 t()
//  - 运行时：切 en 后侧栏/下载页无 key 裸奔（不出现 nav_ / dl_ / set_ 裸键名）
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const here = join(process.cwd(), 'scripts')
const APP_ROOT = process.cwd()
const PORT = '9279'
const DATA_DIR = join(APP_ROOT, '.batch23-data')
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })

const seed = spawn(process.execPath, [join(here, 'seed_layout.mjs'), DATA_DIR], { stdio: ['ignore', 'inherit', 'inherit'] })
await new Promise((r) => seed.on('exit', r))
if (seed.exitCode !== 0) throw new Error('seed_layout failed')

let passed = 0
let failed = 0
function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log('PASS ' + name) }
  else { failed++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

// ---- 静态 ----
{
  const i18nSrc = readFileSync(join(APP_ROOT, 'src/renderer/i18n/index.ts'), 'utf8')
  // 抽 zh 与 en 的顶层键（行首两个空格 + key:）
  const zhBlock = i18nSrc.slice(i18nSrc.indexOf('const zh = {'), i18nSrc.indexOf('} as const'))
  const enBlock = i18nSrc.slice(i18nSrc.indexOf('const en:'), i18nSrc.indexOf('export type I18nKey'))
  const zhKeys = [...zhBlock.matchAll(/^\s{2}([a-z0-9_]+):/gm)].map((m) => m[1])
  const enKeys = [...enBlock.matchAll(/^\s{2}([a-z0-9_]+):/gm)].map((m) => m[1])
  console.log(`KEYS zh=${zhKeys.length} en=${enKeys.length}`)
  assert('zh 键 ≥ 60', zhKeys.length >= 60, String(zhKeys.length))
  assert('en 键 ≥ 60', enKeys.length >= 60, String(enKeys.length))
  const zhSet = new Set(zhKeys)
  const enSet = new Set(enKeys)
  const onlyZh = zhKeys.filter((k) => !enSet.has(k))
  const onlyEn = enKeys.filter((k) => !zhSet.has(k))
  assert('zh/en 键集一致', onlyZh.length === 0 && onlyEn.length === 0, JSON.stringify({ onlyZh, onlyEn }))
  assert('词典无重复键', zhKeys.length === zhSet.size, 'dup in zh')

  // 关键新键在场
  for (const k of ['dl_filter_downloading', 'dl_new', 'set_tab_download', 'set_tab_about', 'common_save', 'set_check_update']) {
    assert(`含键 ${k}`, zhSet.has(k) && enSet.has(k))
  }

  const pkg = readFileSync(join(APP_ROOT, 'package.json'), 'utf8')
  assert('未引入 i18next 依赖', !pkg.includes('i18next'))

  const dl = readFileSync(join(APP_ROOT, 'src/renderer/components/DownloadView.vue'), 'utf8')
  assert('DownloadView 接 t()', dl.includes("from '../i18n'") && dl.includes("t('dl_"))
  assert('DownloadView 过滤器用 labelKey', dl.includes('labelKey') && !/label:\s*'全部'/.test(dl))

  const st = readFileSync(join(APP_ROOT, 'src/renderer/components/SettingsDialog.vue'), 'utf8')
  assert('SettingsDialog 接 t()', st.includes("from '../i18n'"))
  assert('SettingsDialog 页签用 t()', st.includes(":tab=\"t('set_tab_download')\"") && st.includes(":tab=\"t('set_tab_about')\""))
  assert('SettingsDialog 循环变量不再占用 t', !/v-for="t in trackList"/.test(st))
}

// ---- 运行时 CDP ----
const exe = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const proc = spawn(exe, ['--disable-gpu', '.'], {
  cwd: APP_ROOT,
  env: { ...process.env, HANEHANA_DEBUG_PORT: String(PORT), HANEHANA_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
let stderr = ''
proc.stderr.on('data', (d) => { stderr += d.toString() })

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
    ws.onopen = () => { clearTimeout(to); resolve(ws) }
    ws.onerror = () => reject(new Error('ws error'))
  })
}

async function main() {
  const wsUrl = await getWsUrl()
  await new Promise((r) => setTimeout(r, 3000))
  const port = (wsUrl.match(/:(\d+)\//) || [])[1]
  let pageJson = null
  let lastJson = ''
  for (let i = 0; i < 20 && !pageJson; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      lastJson = JSON.stringify(list.map((t) => ({ type: t.type, url: t.url })))
      pageJson = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
    } catch (e) { lastJson = 'fetch fail: ' + e }
    if (!pageJson) await new Promise((r) => setTimeout(r, 500))
  }
  if (!pageJson) throw new Error('no page target via /json | ' + lastJson)
  const ws = await connectWs(pageJson.webSocketDebuggerUrl)
  let msgId = 0
  const pending = new Map()
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const sendRaw = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++msgId
    pending.set(mid, res)
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }))
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('cdp timeout: ' + method)) } }, 15000)
  })
  const send = (method, params = {}) => sendRaw(method, params)
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.exception?.description ?? 'eval failed') }
    return r.result?.result?.value
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  try {
    await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    await send('Page.bringToFront').catch(() => {})
    await send('Page.reload', { ignoreCache: true })
    await wait(5000)

    // 中文基线：侧栏
    const zhNav = await evalJs(`(() => [...document.querySelectorAll('.sidebar .nav-item')].map(b => b.textContent.trim()))()`)
    console.log('ZH_NAV:', JSON.stringify(zhNav))
    assert('中文侧栏有 全部游戏', Array.isArray(zhNav) && zhNav.some(s => s.includes('全部游戏')), JSON.stringify(zhNav))

    // 切 en（直接调 setLanguage 绑定不可从 window 拿——走设置页语言单选）
    const opened = await evalJs(`(() => {
      const btn = [...document.querySelectorAll('.sidebar .nav-item')].find(b => (b.textContent || '').includes('设置') || (b.textContent || '').includes('Settings'))
      if (!btn) return { step: 'no-btn' }
      btn.click()
      return { step: 'ok' }
    })()`)
    await wait(700)
    console.log('OPEN_SET:', JSON.stringify(opened))
    assert('打开设置弹层', opened?.step === 'ok' && await evalJs(`!document.querySelector('.ds-mask') === false`), JSON.stringify(opened))

    // 切到外观页签 → English radio
    await evalJs(`(() => {
      const tab = [...document.querySelectorAll('.ant-tabs-tab')].find(el => (el.textContent || '').includes('外观') || (el.textContent || '').includes('Appearance'))
      tab?.click()
      return !!tab
    })()`)
    await wait(400)
    const switchEn = await evalJs(`(() => {
      const btn = [...document.querySelectorAll('.ant-radio-button-wrapper')].find(el => (el.textContent || '').includes('English'))
      if (!btn) return { step: 'no-en' }
      btn.click()
      return { step: 'clicked' }
    })()`)
    console.log('SW_EN:', JSON.stringify(switchEn))
    assert('点到 English', switchEn?.step === 'clicked', JSON.stringify(switchEn))

    // 保存设置使 setLanguage 生效（App save 回调里会 setLanguage）
    const save = await evalJs(`(() => {
      const foot = document.querySelector('.dlg-foot')
      const btn = foot && [...foot.querySelectorAll('button')].find(b => !b.disabled)
      if (!btn) return { step: 'no-save', texts: foot ? [...foot.querySelectorAll('button')].map(b => b.textContent) : [] }
      btn.click()
      return { step: 'saved', text: btn.textContent }
    })()`)
    console.log('SAVE:', JSON.stringify(save))
    await wait(600)

    // Esc 关弹层
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await wait(400)

    // en 侧栏 + 下载页
    const enNav = await evalJs(`(() => [...document.querySelectorAll('.sidebar .nav-item')].map(b => b.textContent.trim()))()`)
    console.log('EN_NAV:', JSON.stringify(enNav))
    assert('en 侧栏 Library', Array.isArray(enNav) && enNav.some(s => s.includes('Library')), JSON.stringify(enNav))
    assert('en 侧栏无 nav_ 裸键', Array.isArray(enNav) && !enNav.some(s => /\b(nav_|toolbar_|lib_|detail_|dl_|set_|common_|count_)[a-z0-9_]*\b/.test(s)), JSON.stringify(enNav))

    await evalJs(`(() => {
      const btn = [...document.querySelectorAll('.sidebar .nav-item')].find(b => (b.textContent || '').includes('Downloads') || (b.textContent || '').includes('下载'))
      btn?.click()
      return !!btn
    })()`)
    await wait(600)

    const enDl = await evalJs(`(() => {
      const chips = [...document.querySelectorAll('.seg-chip')].map(b => b.textContent.trim())
      const body = document.body.innerText
      const keyLike = body.match(/\\b(?:nav|toolbar|lib|detail|dl|set|common|count)_[a-z0-9_]+\\b/g) || []
      return { chips, keyLike: [...new Set(keyLike)], hasEmpty: body.includes('No download tasks yet') || body.includes('tasks') }
    })()`)
    console.log('EN_DL:', JSON.stringify(enDl))
    assert('下载页过滤器英文', Array.isArray(enDl?.chips) && enDl.chips.some(s => s.includes('Downloading') || s.includes('Done')), JSON.stringify(enDl))
    assert('下载页无 i18n key 裸奔', Array.isArray(enDl?.keyLike) && enDl.keyLike.length === 0, JSON.stringify(enDl?.keyLike))
  } finally {
    console.log(`\n==== ${passed} passed, ${failed} failed ====`)
    ws.close()
    proc.kill()
    // 恢复中文，避免污染本机用户数据目录以外的测试数据（测试目录会删）
    try {
      const { writeFileSync, readFileSync, existsSync } = await import('node:fs')
      const sp = join(DATA_DIR, 'settings.json')
      if (existsSync(sp)) {
        const s = JSON.parse(readFileSync(sp, 'utf8'))
        s.language = 'zh'
        writeFileSync(sp, JSON.stringify(s, null, 2), 'utf8')
      }
    } catch { /* ignore */ }
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  console.error('--- stderr tail ---')
  console.error(stderr.slice(-2000))
  try { proc.kill() } catch { /* ignore */ }
  process.exit(1)
})
