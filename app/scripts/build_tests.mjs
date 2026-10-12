/**
 * esbuild 批处理转译：node --test 前把 src/{shared,main}/**\/*.ts 与 tests/**\/*.ts
 * 转成 ESM 到 .test/.tsbuild 缓存目录，再让 node --test 跑。
 *
 * 为什么不用 vitest：Node 24 原生 node:test + --experimental-strip-types 本可直跑，
 * 但 strip-types 不转 enum/namespace 等需要实例化的语法——为长远把 esbuild 当统一
 * 转译器（vite 自带 esbuild，零新依赖）。输出到 node_modules/.tmp/tsbuild 避免
 * 污染源码树；测试运行器只认磁盘上的 JS。
 */
import { build } from 'esbuild'
import { mkdirSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const SRC = join(ROOT, 'src')
const TESTS = join(ROOT, 'tests')
// 不能放 node_modules 下：node --test 的 glob 规则显式排除 node_modules。
const OUT = join(ROOT, '.test-build')

function collect(dir) {
  const out = []
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) out.push(...collect(p))
    else if (f.endsWith('.ts')) out.push(p)
  }
  return out
}

mkdirSync(OUT, { recursive: true })
// 上次的产物可能有陈旧文件：整目录重建，避免「删了测试还跑旧 JS」。
for (const sub of ['src', 'tests']) {
  const p = join(OUT, sub)
  try {
    rmSync(p, { recursive: true, force: true })
  } catch {
    /* 已是空目录或不存在 */
  }
}

const entries = [...collect(SRC), ...collect(TESTS)]

await build({
  entryPoints: entries,
  outdir: OUT,
  bundle: false,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  sourcemap: false,
  logLevel: 'warning',
})

// 非 .ts 资源（若有）不需要；只保证测试入口能被 node --test 找到
console.log(`esbuild: ${entries.length} 个 TS 文件转译到 ${relative(ROOT, OUT)}`)
