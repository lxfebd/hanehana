// P2-1 一次性迁移：组件内 border-radius 裸 px → var(--hh-radius-*)
// 用法：node scripts/migrate_radius_tokens.mjs   （幂等；只改 border-radius: Npx）
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOT = join(process.cwd(), 'src', 'renderer')

/** tokens.radius：xs6 sm8 md10 lg12 panel16 modal16 pill999 */
function pick(px) {
  if (px >= 900) return 'pill'
  if (px <= 6) return 'xs'
  if (px <= 9) return 'sm'
  if (px <= 11) return 'md'
  if (px <= 13) return 'lg'
  return 'panel' // 14+
}

const re = /border-radius:\s*(\d+)px/g

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (['.vue', '.css'].includes(extname(p))) out.push(p)
  }
  return out
}

let files = 0
let repl = 0
for (const file of walk(ROOT)) {
  const src = readFileSync(file, 'utf8')
  let n = 0
  const next = src.replace(re, (m, d) => {
    n++
    return `border-radius: var(--hh-radius-${pick(Number(d))})`
  })
  if (n) {
    writeFileSync(file, next, 'utf8')
    files++
    repl += n
    console.log(`${file.replace(process.cwd(), '.')}  +${n}`)
  }
}
console.log(`done: ${repl} replacements in ${files} files`)
