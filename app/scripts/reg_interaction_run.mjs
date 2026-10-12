// 三页交互回归自启动包装：seed 真实库（含失败任务）→ 起 Electron →
// 跑 reg_interaction.mjs（Task 1 汇总条 / Task 2 空态出口 / Task 3 未保存角标）→ 清理。
// 用法：node scripts/reg_interaction_run.mjs
import { join, dirname } from 'node:path'
import { rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = join(here, '..')
const PORT = process.env.HANEHANA_DEBUG_PORT || '9231'
const DATA_DIR = join(APP_ROOT, '.reg-interaction-data')
rmSync(DATA_DIR, { recursive: true, force: true })

const seed = spawn(process.execPath, [join(here, 'seed_layout.mjs'), DATA_DIR], {
  stdio: ['ignore', 'inherit', 'inherit'],
})
await new Promise((res) => seed.on('exit', res))
if (seed.exitCode !== 0) throw new Error('seed_layout failed')

const exe = join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const proc = spawn(exe, ['.'], {
  cwd: APP_ROOT,
  env: { ...process.env, HANEHANA_DEBUG_PORT: String(PORT), HANEHANA_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
let stderr = ''
proc.stderr.on('data', (d) => {
  stderr += d.toString()
})

async function waitPort() {
  for (let i = 0; i < 90; i++) {
    try {
      const p = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      if (p.some((x) => x.type === 'page')) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('app did not come up on ' + PORT + ': ' + stderr.slice(-800))
}

let ok = false
try {
  await waitPort()
  await new Promise((r) => setTimeout(r, 2000))
  const p = await new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [join(here, 'reg_interaction.mjs')], {
      cwd: APP_ROOT,
      env: { ...process.env, HANEHANA_DEBUG_PORT: String(PORT) },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('reg_interaction exit ' + code))))
  })
  console.log('reg_interaction: OK')
  ok = true
} catch (e) {
  console.error('FAIL', e.message)
  process.exitCode = 1
} finally {
  try {
    proc.kill()
  } catch {}
  try {
    rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {}
  console.log(ok ? 'REG_INTERACTION OK' : 'REG_INTERACTION FAIL')
}
