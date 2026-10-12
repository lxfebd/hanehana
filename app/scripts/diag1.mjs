import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const APP = process.cwd()
rmSync('.diag-data', { recursive: true, force: true })
const s = spawn(process.execPath, ['scripts/seed_layout.mjs', join(APP, '.diag-data')], { stdio: 'inherit' })
s.on('exit', () => {
  const exe = join(APP, 'node_modules', 'electron', 'dist', 'electron.exe')
  const p = spawn(exe, ['.'], {
    cwd: APP,
    env: { ...process.env, HANEHANA_DEBUG_PORT: '9333', HANEHANA_DATA_DIR: join(APP, '.diag-data') },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  p.stderr.on('data', (d) => process.stdout.write('[app] ' + d.toString().slice(0, 100) + '\n'))
  setTimeout(async () => {
    let ws
    try {
      const pages = await (await fetch('http://127.0.0.1:9333/json')).json()
      console.log('PAGES', pages.map((x) => x.type + ':' + x.url).join(' | '))
      const page = pages.find((x) => x.type === 'page' && !x.url.startsWith('devtools'))
      ws = new WebSocket(page.webSocketDebuggerUrl)
      let id = 0
      const pend = new Map()
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data)
        if (m.id && pend.has(m.id)) {
          pend.get(m.id)(m)
          pend.delete(m.id)
        }
      }
      await new Promise((r) => (ws.onopen = r))
      const send = (method, params = {}) =>
        new Promise((res) => {
          const mid = ++id
          pend.set(mid, res)
          ws.send(JSON.stringify({ id: mid, method, params }))
        })
      const evl = async (expr) => {
        const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
        if (r.result?.exceptionDetails)
          return 'ERR:' + String(r.result.exceptionDetails.exception?.description).slice(0, 200)
        return r.result?.result?.value
      }
      await new Promise((r) => setTimeout(r, 3000))
      const rows = await evl(
        `(async()=>{ const r = await window.hh.listTasks(); return r.map(x => x.def.state + ':' + (x.snap?.state||'-')).join(',') })()`,
      )
      console.log('ROWS', rows)
      const nav = await evl(`[...document.querySelectorAll('.nav-item')].map(e=>e.textContent.trim()).join('|')`)
      console.log('NAV', nav)
      const click = await evl(
        `(async()=>{ const n=[...document.querySelectorAll('.nav-item')].find(e=>e.textContent.includes('下载任务')); if(!n) return 'no-nav'; n.click(); await new Promise(r=>setTimeout(r,800)); return { batch: !!document.querySelector('.dl-batch'), list: document.querySelectorAll('.task-row, .dl-row, [class*=task]').length } })()`,
      )
      console.log('CLICK', JSON.stringify(click))
      const errRows = await evl(
        `(async()=>{ const r = await window.hh.listTasks(); return r.filter(x => x.def.state === 'error' || x.snap?.state === 'error').map(x => x.def.state + '/' + (x.snap?.state||'-') + ':' + (x.snap?.error||x.def.error||'').slice(0,30)).join(' | ') })()`,
      )
      console.log('ERR_ROWS', errRows)
      const vis = await evl(`(() => {
        // 访问下载页组件内的 batchEventVisible 不可行，改从 DOM 推断：找 .dl-batch 与失败过滤 chip
        const n = [...document.querySelectorAll('.nav-item')].find(e => e.textContent.includes('下载任务'))
        if (n) n.click()
        return new Promise(r => setTimeout(() => {
          const chips = [...document.querySelectorAll('.seg-chip')].map(e => e.textContent.trim()).join('|')
          const batch = document.querySelector('.dl-batch')
          r({ chips, batch: !!batch, batchText: batch?.textContent?.slice(0, 80) ?? '' })
        }, 1000))
      })()`)
      console.log('VIS', JSON.stringify(vis))
      ws.close()
    } catch (e) {
      console.log('DIAG_ERR', e.message)
    }
    try {
      p.kill()
    } catch {}
    try {
      rmSync('.diag-data', { recursive: true, force: true })
    } catch {}
    setTimeout(() => process.exit(0), 500)
  }, 8000)
})
