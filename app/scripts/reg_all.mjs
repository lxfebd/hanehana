// 回归总入口：串起六件套（按顺序，遇错即停）。
//   1. typecheck          —— vue-tsc 双 tsconfig（零依赖 npm 脚本）
//   2. regression:static  —— accept_batch21/22/23 静态闸（秒级）
//   3. regression:layout  —— 布局探针自启动（双主题 × 4 视口）
//   4. regression:app     —— 桥+导航 / 站点桥 / 保活 自启动
//   5. regression:download—— 真实引擎下载链路（e2e_download.mjs）
// 用法：node scripts/reg_all.mjs [--no-download]
import { spawnSync } from 'node:child_process'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const steps = [
  ['typecheck', 'npm run typecheck', (r) => r.status === 0],
  ['regression:static', 'node scripts/reg_static.mjs', (r) => r.status === 0],
  ['regression:layout', 'node scripts/reg_layout.mjs', (r) => r.status === 0],
  ['regression:app', 'node scripts/reg_app.mjs', (r) => r.status === 0],
]
if (!process.argv.includes('--no-download')) {
  steps.push(['regression:download', 'node scripts/e2e_download.mjs', (r) => r.status === 0])
}

let failed = null
for (const [name, cmd] of steps) {
  console.log(`\n========== ${name}: ${cmd} ==========`)
  const r = spawnSync(cmd, { shell: true, stdio: 'inherit', cwd: process.cwd() })
  if (r.status !== 0) {
    failed = name
    break
  }
}
if (failed) {
  console.error(`\n==== REGRESSION FAILED at ${failed} ====`)
  process.exit(1)
}
console.log('\n==== REGRESSION ALL PASS ====')
