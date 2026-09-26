// R7 批次验收：P2-1 设计 token 全量替换 + 零依赖禁裸值闸
// 用法：node scripts/accept_batch21.mjs   （纯静态 grep，无需 build 产物/端口）
//  - 组件内（src/renderer/**/*.vue）裸 hex = 0（hex 只准 tokens.ts）
//  - 组件内 border-radius: Npx = 0（只准 var(--hh-radius-*)）
//  - 允许：tokens.ts / FS_COLORS 真值文件；#hh 变量引用；rgba() 半透明由 tokens 派生写在组件 var() 上
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname, relative } from 'node:path'

const ROOT = join(process.cwd(), 'src', 'renderer')
const HEX = /#[0-9a-fA-F]{3,8}\b/
const BARE_RADIUS = /border-radius:\s*\d+px\b/

let passed = 0
let failed = 0
function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log('PASS ' + name) }
  else { failed++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (extname(p) === '.vue') out.push(p)
  }
  return out
}

const files = walk(ROOT)
assert('扫到组件 .vue', files.length >= 10, String(files.length))

const hexHits = []
const radiusHits = []
for (const file of files) {
  const rel = relative(process.cwd(), file).replace(/\\/g, '/')
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, i) => {
    // 行内允许出现 var(--hh-...) 引用；真正禁止的是 hex 字面量
    if (HEX.test(line)) hexHits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`)
    if (BARE_RADIUS.test(line)) radiusHits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`)
  })
}

assert('组件内裸 hex = 0', hexHits.length === 0, hexHits.slice(0, 8).join(' | '))
assert('组件内裸 border-radius px = 0', radiusHits.length === 0, radiusHits.slice(0, 8).join(' | '))

// tokens 真值文件必须仍持有 hex（唯一允许处）
const tokens = readFileSync(join(ROOT, 'design', 'tokens.ts'), 'utf8')
assert('tokens.ts 仍是颜色唯一真值', HEX.test(tokens) && /FS_COLORS/.test(tokens))

// 抽查：radius 变量已接线
const sample = readFileSync(join(ROOT, 'components', 'CoverGrid.vue'), 'utf8')
assert('CoverGrid 使用 radius token', sample.includes('var(--hh-radius-'), '')
assert('CoverGrid 无裸圆角', !BARE_RADIUS.test(sample))

const sample2 = readFileSync(join(ROOT, 'App.vue'), 'utf8')
assert('App.vue 使用 radius token', sample2.includes('var(--hh-radius-'), '')
assert('App.vue 无裸圆角', !BARE_RADIUS.test(sample2))

console.log(`\n==== ${passed} passed, ${failed} failed ====`)
process.exit(failed > 0 ? 1 : 0)
