// 静态闸回归：几个秒级静态断言脚本顺序跑（不改码，只 grep/读源码）。
// 用法：node scripts/reg_static.mjs
//
// verify_gate_wiring.mjs 是**元闸**：断言 package.json 里每个 regression:* 都被
// ci.yml / visual.yml / reg_all.mjs 引用（白名单见该文件）。它防的正是「闸门写好了
// 但没人调用」那类漏接线——不再靠人眼过 diff。
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = join(here, '..')
const scripts = ['accept_batch21.mjs', 'accept_batch22.mjs', 'accept_batch23.mjs', 'verify_gate_wiring.mjs']

for (const s of scripts) {
  const r = spawnSync(process.execPath, [join(here, s)], { cwd: APP_ROOT, stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`FAIL ${s}`)
    process.exit(r.status ?? 1)
  }
  console.log(`--- ${s} OK ---`)
}
console.log('REG_STATIC OK')
