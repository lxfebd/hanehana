/**
 * jsonStore 持久化器行为契约（统一持久化层）。
 * 三套旧实现（gameStore 400ms 合并 / tasks 每 100ms 同步写 / playSessions
 * 截断重写）收敛成这一个模块，这里固定它的语义：
 *   - 原子写：先 .tmp 再 rename，不留半截文件；
 *   - 尾触发合并：窗口内多次 save 只落盘一次、落的是最新快照；
 *   - flush：退出前把待写内容立即落盘；
 *   - 目录缺失自动创建；文件损坏读回 null。
 * 改行为先改测试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// ESM 之谜：node 只认带 .js 的 specifier，TS 会把它映射回 .ts——两头都通。
import { createJsonStore } from '../src/main/jsonStore.js'

/** 每次测试用独立临时目录，测完清掉。 */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'hanehana-jsonstore-'))
}

test('save: 立即创建文件、不留 .tmp、可读回', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'a', 'b', 'data.json') // 嵌套目录不存在
    const s = createJsonStore<{ n: number }>(file)
    s.save({ n: 1 })
    s.flush()
    assert.ok(existsSync(file), 'flush 后文件必须存在')
    assert.equal(existsSync(`${file}.tmp`), false, '原子写不该留 .tmp')
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { n: 1 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('save: 文件权限 0o600（便携模式防其他用户读到凭据）', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 's.json')
    const s = createJsonStore<{ secret: string }>(file)
    s.save({ secret: 'webdav-pass' })
    s.flush()
    if (process.platform !== 'win32') {
      // POSIX 上直接校验权限位；Windows 由 Node 尽力映射 ACL，不在此断言
      assert.equal(statSync(file).mode & 0o777, 0o600)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('合并窗口: 连续 save 只落盘一次（同一文件 mtime 不变）', async () => {
  const dir = tempDir()
  try {
    const file = join(dir, 't.json')
    const s = createJsonStore<{ n: number }>(file, undefined, { delayMs: 60 })
    s.save({ n: 1 })
    s.save({ n: 2 })
    s.save({ n: 3 })
    // 窗口内尚未落盘
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(existsSync(file), false, '窗口内不该落盘')
    // 窗口过后落盘一次，且是最后一次的快照
    await new Promise((r) => setTimeout(r, 120))
    assert.ok(existsSync(file))
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { n: 3 }, '合并写落的是最新快照')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('flush: 窗口内立即落盘、返回 true；无待写时返回 false', async () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'f.json')
    const s = createJsonStore<{ n: number }>(file, undefined, { delayMs: 80 })
    s.save({ n: 9 })
    assert.equal(s.flush(), true, '有待写内容时 flush 返回 true')
    assert.ok(existsSync(file))
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { n: 9 })
    assert.equal(s.flush(), false, '没有待写内容时 flush 返回 false')
    // flush 后定时器已清：等超过窗口也不重复写
    await new Promise((r) => setTimeout(r, 150))
    const files = readdirSync(dir)
    assert.equal(files.filter((f) => f.endsWith('.tmp')).length, 0, 'flush 后不该再有 .tmp')
    assert.equal(files.filter((f) => f.endsWith('.json')).length, 1, 'flush 后只有一个数据文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('load: 缺失返回 null', () => {
  const dir = tempDir()
  try {
    const s = createJsonStore<{ n: number }>(join(dir, 'none.json'))
    assert.equal(s.load(), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('load: 损坏 JSON 返回 null（不炸）', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'bad.json')
    const s = createJsonStore<{ n: number }>(file)
    s.save({ n: 1 })
    s.flush()
    // 模拟半截写入（旧版本进程被杀）
    writeFileSync(file, '{"n":')
    assert.equal(s.load(), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('自定义序列化函数生效', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'c.json')
    const s = createJsonStore<{ n: number }>(file, (v) => JSON.stringify({ wrapped: v.n }))
    s.save({ n: 7 })
    s.flush()
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { wrapped: 7 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
