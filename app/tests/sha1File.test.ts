/**
 * 分块 sha1 契约（回归靶：为了不 OOM 而把大文件排除在备份之外）。
 *
 * 现场：saves.ts 旧实现 `readFileSync` 整读 + `st.size > 200MB → continue`，
 * 结果是几百 MB 的存档资源包既不备份也不告知，界面显示备份成功。
 * 新实现分块喂 hash，内存与文件大小无关；这里钉死「分块结果 == 一次性读入」
 * 与两个边界：空文件、单块/多块跨越。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha1File } from '../src/shared/sha1File.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'hanehana-sha1-'))
}

/** 一次性读入算的 sha1（对照组：分块实现必须与它逐字节一致）。 */
function sha1Of(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex')
}

test('分块 hash 与一次性 hash 结果一致（2MB，跨越多块）', () => {
  const dir = tempDir()
  try {
    const buf = Buffer.alloc(2 * 1024 * 1024 + 37)
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 31) % 251
    const p = join(dir, 'big.bin')
    writeFileSync(p, buf)
    assert.equal(sha1File(p), sha1Of(buf))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('分块大小变化不影响结果（64KB 与 1MB 两种块）', () => {
  const dir = tempDir()
  try {
    const buf = Buffer.from('HaneHana 存档快照：分块哈希与块大小无关'.repeat(4096), 'utf8')
    const p = join(dir, 'mid.bin')
    writeFileSync(p, buf)
    assert.equal(sha1File(p, 64 * 1024), sha1Of(buf))
    assert.equal(sha1File(p), sha1Of(buf))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('空文件 = 空内容的 sha1（不因 0 字节提前返回）', () => {
  const dir = tempDir()
  try {
    const p = join(dir, 'empty.bin')
    writeFileSync(p, Buffer.alloc(0))
    assert.equal(sha1File(p), 'da39a3ee5e6b4b0d3255bfef95601890afd80709')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('文件不存在要抛原始错误（不吞成空串，让调用方决定跳过还是失败）', () => {
  const dir = tempDir()
  try {
    assert.throws(() => sha1File(join(dir, 'nope.bin')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
