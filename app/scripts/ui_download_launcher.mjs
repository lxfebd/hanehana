// cdp_ui_download 的自启动包装：seed 空库起隔离实例 → 跑 9 断言 → 清理。
// 用法：node scripts/ui_download_launcher.mjs
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = join(here, '..')
const PORT = '9224'
const DATA_DIR = join(APP_ROOT, '.ui-data')
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })

const exe = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const proc = spawn(exe, ['.'], {
  cwd: APP_ROOT,
  env: { ...process.env, HANEHANA_DEBUG_PORT: PORT, HANEHANA_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
proc.stderr.on('data', (d) => console.log('[app]', d.toString().trim().slice(0, 160)))

async function waitPort() {
  for (let i = 0; i < 60; i++) {
    try {
      const p = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      if (p.some((x) => x.type === 'page')) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('app did not come up on ' + PORT)
}

try {
  await waitPort()
  await new Promise((r) => setTimeout(r, 2000))
  const p = await new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [join(here, 'cdp_ui_download.mjs')], {
      env: { ...process.env, HANEHANA_DEBUG_PORT: PORT },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('cdp_ui_download exit ' + code))))
  })
  console.log('cdp_ui_download: PASS')
  process.exitCode = 0
} catch (e) {
  console.error('FAIL', e.message)
  process.exitCode = 1
} finally {
  try {
    proc.kill()
  } catch {}
  rmSync(DATA_DIR, { recursive: true, force: true })
}
