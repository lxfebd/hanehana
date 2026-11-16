/**
 * 退出判定契约（回归靶：崩溃被判成正常退出，还顺手触发了自动备份）。
 *
 * 现场：main/games.ts 原先写 `code !== 0 && code !== null`，注释声称
 * 「信号终止同样是非 0」。Node 的实际语义相反——被信号杀死时 `code === null`、
 * `signal` 才是 `'SIGSEGV'` 之类的值。于是 SIGSEGV/SIGKILL 全被判成正常退出，
 * 「可能异常退出」通知永不触发，正常退出分支还会拿崩溃现场去做自动存档备份。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAbnormalExit } from '../src/shared/exitCode.js'

test('退出码 0 = 正常退出', () => {
  assert.equal(isAbnormalExit(0, null), false)
})

test('非 0 退出码 = 异常', () => {
  assert.equal(isAbnormalExit(1, null), true)
  assert.equal(isAbnormalExit(127, null), true)
})

test('被信号杀死（code=null + signal 有值）= 异常（崩溃不能算正常退出）', () => {
  assert.equal(isAbnormalExit(null, 'SIGSEGV'), true)
  assert.equal(isAbnormalExit(null, 'SIGKILL'), true)
  assert.equal(isAbnormalExit(null, 'SIGTERM'), true)
  assert.equal(isAbnormalExit(null, 'SIGABRT'), true)
})

test('有退出码又有 signal 时以 signal 为准（Windows 被杀时可能两个都有）', () => {
  assert.equal(isAbnormalExit(0, 'SIGKILL'), true)
})

test('code / signal 都缺（平台没给信息）按正常处理，不误报崩溃', () => {
  assert.equal(isAbnormalExit(null, null), false)
  assert.equal(isAbnormalExit(null, ''), false)
})
