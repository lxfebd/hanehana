// 元闸：回归靶「接进入口」的防复发检查（M8-B B1）。
//
// 背景：package.json 里挂着 regression:coverfallback / :clickoutside / :panelhead /
// :backup 四个新靶，但 ci.yml / visual.yml / reg_all.mjs 一个都没引用它们——
// 把 CoverGrid 改回 display:none，CI 依旧全绿。闸门写好了却没人调用，等于没有闸门；
// 这类「漏接线」靠人眼过 diff 是靠不住的，所以用一条秒级静态闸把它钉死。
//
// 断言（三个方向，各自可证伪）：
//   1. 反方向覆盖：package.json 里每个 regression:* 至少出现在 ci.yml / visual.yml /
//      reg_all.mjs 之一（白名单见下，别名见 2）；
//   2. 别名不算漏：同一条命令（同一份 node 脚本）已经被另一个「已接线」的键引用时，
//      这个键视为已覆盖——regression:collection 就是 node scripts/verify_dlview.mjs，
//      和已接线的 regression:dlview 跑的是同一段代码；
//   3. 正方向引用：三处入口里 `npm run regression:*` 提到的键必须真的存在于
//      package.json。键被改名/删掉时，CI 那一步会在 runner 上报 "Missing script"，
//      要等一次跑完才看得见；这里在秒级静态闸里先红，并点名是哪个键。
//
// 白名单（每一项都写清理由，别让它悄悄长大；键从 package.json 消失时本闸会红）：
//   regression            —— 总入口 reg_all.mjs 自身，由人或调度器调用；
//   regression:layers:all —— 手动深扫（--all：10 个视口 × 全套浮层，分钟级、抖动面大），
//                            不适合进 CI；默认口径的 regression:layers 已接线；
//   regression:collection —— 历史双轨的别名：它跑 verify_dlview.mjs，而已接线的
//                            regression:dlview 跑 verify_download_view.mjs，是同一个
//                            「下载视图」视觉面的两代脚本。键留着给老习惯/人工复核用，
//                            不接进 CI：同一面跑两遍只是双倍耗时，不增加覆盖。
//
// 用法：node scripts/verify_gate_wiring.mjs   （纯静态读文件，无需 build 产物/端口）
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = join(here, '..')
const REPO_ROOT = join(APP_ROOT, '..')

/**
 * 三个「入口」：任何 regression:* 只要被其中一个引用，就算接上线了。
 * 路径从脚本位置推（不依赖 process.cwd()）：本闸会被 reg_all 从 app/ 调、也会被
 * CI 从 app/ 调，从仓库根手动跑同样要能读到——所以只认相对于这个文件的路径。
 */
const WIRING = [
  ['ci.yml', join(REPO_ROOT, '.github', 'workflows', 'ci.yml')],
  ['visual.yml', join(REPO_ROOT, '.github', 'workflows', 'visual.yml')],
  ['reg_all.mjs', join(APP_ROOT, 'scripts', 'reg_all.mjs')],
]

/** 允许不接线/不存在的键 → 理由（理由必须在，否则白名单就是后门） */
const EXEMPT = new Map([
  ['regression', '总入口 reg_all.mjs 自身，由人或调度器调用；它的接线由 steps 数组保证'],
  ['regression:layers:all', '手动深扫（--all：10 个视口 × 全套浮层，分钟级、抖动面大）不进 CI'],
  ['regression:collection', '历史双轨别名（verify_dlview.mjs）：同一「下载视图」面已由 regression:dlview 覆盖'],
])

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

let scripts = {}
try {
  scripts = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')).scripts ?? {}
} catch (e) {
  assert('package.json 可读且含 scripts', false, String(e && e.message))
}
assert('package.json 有 regression:* 脚本', Object.keys(scripts).some((k) => k.startsWith('regression:')))

const wiring = WIRING.map(([name, path]) => {
  try {
    return [name, readFileSync(path, 'utf8')]
  } catch {
    // 读不到就当空文本：下面的覆盖检查会因此红，问题不会被吞掉
    return [name, '']
  }
})
assert(
  '三处入口文件可读（ci.yml / visual.yml / reg_all.mjs）',
  wiring.every(([, text]) => text.length > 0),
  wiring.filter(([, text]) => !text.length).map(([name]) => name).join(', '),
)

/** 从三处入口里抠出所有 regression:* 令牌（带边界，避免 layers 被 layers:all 前缀命中） */
const tokens = new Set()
for (const [, text] of wiring) {
  for (const m of text.matchAll(/regression:[a-z0-9]+(?::[a-z0-9]+)*/gi)) tokens.add(m[0])
}

const keys = Object.keys(scripts).filter((k) => k.startsWith('regression:'))
const missing = []
const aliases = []
for (const key of keys) {
  if (tokens.has(key) || EXEMPT.has(key)) continue
  // 别名：命令体完全一致（同一份脚本），已接线的那个键跑一次就覆盖同一段代码
  const cmd = String(scripts[key]).trim()
  const aliasOf = keys.find((other) => other !== key && tokens.has(other) && String(scripts[other]).trim() === cmd)
  if (aliasOf) aliases.push([key, aliasOf])
  else missing.push(key)
}
assert(
  '每个 regression:* 都接进了 ci.yml / visual.yml / reg_all.mjs（或白名单/别名）',
  missing.length === 0,
  '漏掉的键：' + missing.join(', '),
)

const dangling = [...tokens].filter((key) => !(key in scripts))
assert(
  '入口里引用的每个 regression:* 都存在于 package.json（防改名后只在 runner 上红）',
  dangling.length === 0,
  '入口引用但 package.json 里没有：' + dangling.join(', '),
)

assert(
  '白名单没有过期项（键已删除就要一起退休）',
  [...EXEMPT.keys()].every((key) => key in scripts),
  '白名单里已不存在的键：' + [...EXEMPT.keys()].filter((key) => !(key in scripts)).join(', '),
)

const wired = keys.filter((k) => tokens.has(k)).length
console.log(
  `\n接线：${wired} 个键被入口引用 / 白名单 ${EXEMPT.size} / 别名 ${aliases.length}` +
    (aliases.length ? '（' + aliases.map(([k, of]) => `${k}→${of}`).join(', ') + '）' : ''),
)
console.log(`\n==== ${passed} passed, ${failed} failed ====`)
process.exit(failed > 0 ? 1 : 0)
