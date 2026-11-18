// 设置页渲染质量验证：8 页签齐全、外观页主题卡、语言切换、保存交互
// 用法：node scripts/verify_settings.mjs
import { spawn, spawnSync } from 'node:child_process'
import { pickFreePort, killTree } from './lib/probePort.mjs'
import { join } from 'node:path'
import { rmSync, mkdirSync } from 'node:fs'
import { tryWaitFor } from './lib/waitFor.mjs'

const APP_ROOT = join(process.cwd())
const PORT = await pickFreePort()
const DATA_DIR = join(APP_ROOT, '.settings-data')
for (let i = 0; i < 5; i++) {
  try {
    rmSync(DATA_DIR, { recursive: true, force: true })
    break
  } catch {
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
    for (let i = 0; i < 20; i++) {
      const e = await ev('!!window.hh')
      if (e) break
      await new Promise((r) => setTimeout(r, 500))
    }
    await new Promise((r) => setTimeout(r, 800))
    // 打开设置（侧栏 data-testid 入口，不认中文/英文文案）
    await ev(`(() => { const b = document.querySelector('[data-testid="nav-settings"]'); if (b) { b.click(); return 'ok' } return 'no-nav' })()`)
    await new Promise((r) => setTimeout(r, 900))
    const dlg = JSON.parse(
      await ev(`JSON.stringify((() => {
        const tabs = [...document.querySelectorAll('.ant-tabs-tab')].map(t => t.textContent.trim())
        const cards = document.querySelectorAll('.preset-card').length
        return { dlg: !!document.querySelector('.dlg-foot'), tabs, presetCards: cards }
      })())`),
    )
    ck('设置对话框打开', dlg.dlg === true, 'dlg=' + dlg.dlg)
    ck('页签 ≥ 7（下载/通知/网络/外观/备份/工具/新作/关于）', (dlg.tabs || []).length >= 7, 'tabs=' + JSON.stringify(dlg.tabs))
    // 切到外观页 → 主题卡
    // 页签由 SettingsDialog 的 #tab 槽挂了 data-testid（tab-<key>），不再匹配「外观/Appearance」
    await ev(`(() => { const t = document.querySelector('[data-testid="tab-ui"]'); if (t) { t.click(); return 'ok' } return 'no' })()`)
    await new Promise((r) => setTimeout(r, 600))
    const ui = JSON.parse(
      await ev(`JSON.stringify((() => ({
        presetCards: document.querySelectorAll('.preset-card').length,
        previews: document.querySelectorAll('.preset-preview').length,
        // 语言切换控件：Radio.Button 的 input value 是语义值（zh/en），不按「中文/English」文案数
        langBtns: document.querySelectorAll('input[type=radio][value="zh"], input[type=radio][value="en"]').length,
      }))())`),
    )
    ck('外观页主题卡（5 套）', ui.presetCards >= 5, 'cards=' + ui.presetCards)
    ck('主题卡氛围预览', ui.previews >= 5, 'previews=' + ui.previews)
    ck('语言切换控件存在', ui.langBtns >= 2, 'lang=' + ui.langBtns)

    // ---- 真切换（B7）：控件存在 ≠ 切换生效 ----
    // 只数 input 个数的话，词典没接、保存没落盘、radio 只挂样式不挂 v-model 都会绿。
    // 这里走完整用户路径：点 English → 点保存（emit('save') → 主进程落盘 → setLanguage
    // 触发重渲染）→ 读侧栏 nav-library 的**文本**必须是 'Library'（词典 en 的真值）；
    // 再切回中文，确认复原——顺带验证「保存后立即生效、不用重启」这条既有承诺。
    const navLabel = () =>
      ev(`(() => { const s = document.querySelector('[data-testid="nav-library"] span'); return s ? (s.textContent || '').trim() : '' })()`)
    const clickRadio = (lang) =>
      ev(`(() => { const r = document.querySelector('input[type=radio][value="${lang}"]'); if (!r) return 'no-radio'; r.click(); return 'ok' })()`)
    const clickSave = () =>
      ev(`(() => { const b = document.querySelector('.dlg-foot button.ant-btn-primary'); if (!b) return 'no-save'; b.click(); return 'ok' })()`)
    const reopenUiTab = async () => {
      await ev(`(() => { const b = document.querySelector('[data-testid="nav-settings"]'); if (b) { b.click(); return 'ok' } return 'no-nav' })()`)
      await tryWaitFor(() => ev('!!document.querySelector(".dlg-foot")'), { timeoutMs: 5000, label: '再次打开设置' })
      await ev(`(() => { const t = document.querySelector('[data-testid="tab-ui"]'); if (t) { t.click(); return 'ok' } return 'no' })()`)
      return tryWaitFor(() => ev('!!document.querySelector(\'input[type=radio][value="zh"]\')'), {
        timeoutMs: 5000,
        label: '外观页语言控件重新出现',
      })
    }
    const zhBefore = await navLabel()
    const enClicked = await clickRadio('en')
    const enSaved = await clickSave()
    const toEn = await tryWaitFor(() => ev(`(() => { const s = document.querySelector('[data-testid="nav-library"] span'); return !!s && (s.textContent || '').trim() === 'Library' })()`), {
      timeoutMs: 8000,
      label: '界面语言切到英文（nav-library 文案 = Library）',
    })
    const enLabel = await navLabel()
    const uiTabBack = await reopenUiTab()
    const zhClicked = await clickRadio('zh')
    const zhSaved = await clickSave()
    const backToZh = await tryWaitFor(() => ev(`(() => { const s = document.querySelector('[data-testid="nav-library"] span'); return !!s && (s.textContent || '').trim() === '全部游戏' })()`), {
      timeoutMs: 8000,
      label: '界面语言切回中文（nav-library 文案 = 全部游戏）',
    })
    const zhLabel = await navLabel()
    ck(
      '语言真切换：点 English 保存后侧栏文案变 Library，切回中文复原',
      zhBefore === '全部游戏' &&
        enClicked === 'ok' &&
        enSaved === 'ok' &&
        toEn === true &&
        enLabel === 'Library' &&
        uiTabBack === true &&
        zhClicked === 'ok' &&
        zhSaved === 'ok' &&
        backToZh === true &&
        zhLabel === '全部游戏',
      JSON.stringify({ zhBefore, enClicked, enSaved, enLabel, toEn, uiTabBack, zhClicked, zhSaved, backToZh, zhLabel }),
    )
    console.log('  设置页:', JSON.stringify({ tabs: dlg.tabs, presetCards: ui.presetCards, previews: ui.previews }))
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