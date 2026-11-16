// 回归总入口：串起闸门（按顺序，遇错即停）。
//   1. typecheck          —— vue-tsc 双 tsconfig（零依赖 npm 脚本）
//   2. regression:static  —— accept_batch21/22/23 静态闸（秒级）
//   3. regression:layers  —— 真机层叠命中测试（verify_ui_layers.mjs）
//   4. regression:download—— 真实引擎下载链路（e2e_download.mjs，HTTPS fixture）
// 用法：node scripts/reg_all.mjs [--no-layers] [--no-download]
//
// --no-download 是逃生阀：本机没编译 Rust 引擎、或者离线时跑不了真实下载链路。
// 用它的那次结果**不能**记成「download 闸绿」——2026-10-31 起的 nightly 连红 11 次
// 期间，CHANGELOG 里一串 ALL PASS 就是这么来的。CI（visual.yml）不带这个参数。
// --no-layers 同理，只用于没有图形会话的环境。
//
// 跳着跑的这次以 exit 3 结束：调用方必须能区分「全跑过了」和「跳过一部分」，
// 否则逃生阀会重新变成「每次都绿」的假绿来源。
import { spawnSync } from 'node:child_process'

const steps = [
  ['typecheck', 'npm run typecheck', (r) => r.status === 0],
  ['regression:static', 'node scripts/reg_static.mjs', (r) => r.status === 0],
]
const skipped = []
// regression:layers：真机层叠命中测试（verify_ui_layers.mjs），elementFromPoint 断言
// 弹窗不被封面卡片覆盖——防 backdrop-filter 把 z-index 关进祖先层叠上下文这类 bug。
if (!process.argv.includes('--no-layers')) {
  steps.push(['regression:layers', 'node scripts/verify_ui_layers.mjs', (r) => r.status === 0])
} else {
  skipped.push('regression:layers')
}
if (!process.argv.includes('--no-download')) {
  steps.push(['regression:download', 'node scripts/e2e_download.mjs', (r) => r.status === 0])
} else {
  skipped.push('regression:download')
}

let failed = null
// 第三列是每步自己的判据：原先只析构 [name, cmd]，那个 validator 从未被调用。
for (const [name, cmd, ok] of steps) {
  console.log(`\n========== ${name}: ${cmd} ==========`)
  const r = spawnSync(cmd, { shell: true, stdio: 'inherit', cwd: process.cwd() })
  if (!ok(r)) {
    failed = name
    break
  }
}

if (failed) {
  console.error(`\n==== REGRESSION FAILED at ${failed} ====`)
  process.exit(1)
}
if (skipped.length) {
  console.log(`\n==== REGRESSION PARTIAL PASS（跳过：${skipped.join(', ')}）====`)
  console.log('    跳过的步骤不算绿：这次结果不能记成闸门全绿。')
  process.exit(3)
}
console.log('\n==== REGRESSION ALL PASS ====')
