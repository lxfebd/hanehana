// P2-1 一次性迁移：组件内裸 font-size Npx / transition 裸秒 → token
// 字号只对能落到 type 尺度的精确值替换（12/13/14/16/20/28），
// 非标字号（9/11/15/17/22/24/40/48…）留给视觉回归批次，不强改。
// 时长：0.12/0.15/0.167/0.18 → med；0.2/0.25 → slow；0.35 → page。
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOT = join(process.cwd(), 'src', 'renderer')

const FONT = new Map([
  [12, 'caption'],
  [13, 'body'],
  [14, 'bodyLg'],
  [16, 'subtitle'],
  [20, 'title'],
  [28, 'display'],
])

// 只替换纯 font-size: Npx（不碰 line-height: 18px 这类，也不碰带 calc 的）
const fontRe = /font-size:\s*(\d+)px/g

// transition 里的裸时长（秒）。保留 timing function 词（ease/linear/cubic-bezier…）。
function mapDur(sec) {
  const ms = Math.round(parseFloat(sec) * 1000)
  if (ms <= 100) return 'fast'
  if (ms <= 180) return 'med'
  if (ms <= 280) return 'slow'
  if (ms <= 400) return 'page'
  return null
}

function transformTransitions(src) {
  // transition: <props> <dur> <timing>, ...
  return src.replace(/transition:\s*([^;]+);/g, (full, body) => {
    const parts = body.split(',').map((s) => s.trim())
    const outParts = parts.map((clause) => {
      const tokens = clause.split(/\s+/)
      // 至少 duration 一位
      if (tokens.length < 2) return clause
      const durIdx = tokens.findIndex((t) => /^\d+(\.\d+)?s$/.test(t))
      if (durIdx < 0) return clause
      const name = mapDur(tokens[durIdx])
      if (!name) return clause
      tokens[durIdx] = `var(--hh-motion-${name})`
      return tokens.join(' ')
    })
    return `transition: ${outParts.join(', ')};`
  })
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (extname(p) === '.vue') out.push(p)
  }
  return out
}

let files = 0
let fontN = 0
let trN = 0
for (const file of walk(ROOT)) {
  const src = readFileSync(file, 'utf8')
  let nFont = 0
  let next = src.replace(fontRe, (m, d) => {
    const k = FONT.get(Number(d))
    if (!k) return m
    nFont++
    return `font-size: var(--hh-font-${k}-size)`
  })
  const beforeTr = next
  next = transformTransitions(next)
  const nTr = next === beforeTr ? 0 : (beforeTr.match(/transition:/g) || []).length
  // 更精确：数替换掉的裸秒
  const bareSec = (beforeTr.match(/transition:[^;]*\d+(\.\d+)?s/g) || []).length
  if (nFont || next !== src) {
    // re-count actual duration replacements
    const replaced = [...beforeTr.matchAll(/transition:\s*([^;]+);/g)].length
    writeFileSync(file, next, 'utf8')
    files++
    fontN += nFont
    if (next !== beforeTr) {
      trN += bareSec
      console.log(`${file.replace(process.cwd(), '.')}  font+${nFont} transition~${bareSec}`)
    } else if (nFont) {
      console.log(`${file.replace(process.cwd(), '.')}  font+${nFont}`)
    }
    void replaced
  }
}
console.log(`done: font-size ${fontN}, transition ~${trN}, files ${files}`)
