/**
 * 进程状态机派生契约（对标 KoiPage 的 launching 派生式）。
 *
 * KoiPage 的核心设计：`launching` 不是独立集合，而是
 * `gameProcesses` 的派生——`setGameProcess` 里
 * `status === 'starting' ? launching[id]=true : delete launching[id]`。
 * 我们把它收敛成两个纯函数，store 与组件共用。
 *
 * 这里钉住三条不变量：
 *   1. launching 只在 starting 时为真（running/exited 都 false）
 *   2. running 只在 running 时为真
 *   3. 派生是「只读」的：同一个 processes 表，派生结果恒定
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GAME_PROCESS_STATUSES, type GameProcessState } from '../src/shared/types.js'
import { isLaunching, isRunning } from '../src/shared/processState.js'

test('isLaunching: 只有 starting 为真', () => {
  assert.equal(isLaunching({ status: 'starting', pid: null }), true)
  assert.equal(isLaunching({ status: 'running', pid: 123 }), false)
  assert.equal(isLaunching({ status: 'exited', pid: null }), false)
  assert.equal(isLaunching(undefined), false)
})

test('isRunning: 只有 running 为真', () => {
  assert.equal(isRunning({ status: 'running', pid: 123 }), true)
  assert.equal(isRunning({ status: 'starting', pid: null }), false)
  assert.equal(isRunning({ status: 'exited', pid: null }), false)
  assert.equal(isRunning(undefined), false)
})

test('派生解耦：同一张表，launching 与 running 互不重叠', () => {
  // 状态机是单线推进，一个 id 同时只能处于一个状态
  for (const status of GAME_PROCESS_STATUSES) {
    const st = { status, pid: 42 }
    assert.equal(isLaunching(st) && isRunning(st), false, `${status} 不能同时是两个态`)
  }
})

test('exited 可以带 error（启动失败透出），不带时留空', () => {
  const failed = { status: 'exited' as const, pid: null, error: 'ENOENT' }
  assert.equal(isLaunching(failed), false)
  assert.match(failed.error ?? '', /ENOENT/)
})

test('launching 不收尾的回归防护：状态必须能离开 starting', () => {
  // 这正是旧实现（render 层手搓集合）最怕的：忘了 delete 就永远转圈。
  // 状态机写法下，只要主进程推了 running/exited，派生自动归假。
  const table: Record<string, GameProcessState> = {
    a: { status: 'starting', pid: null },
    b: { status: 'running', pid: 7 },
    c: { status: 'exited', pid: null },
  }
  const launchingIds = Object.keys(table).filter((id) => isLaunching(table[id]))
  const runningIds = Object.keys(table).filter((id) => isRunning(table[id]))
  assert.deepEqual(launchingIds, ['a'])
  assert.deepEqual(runningIds, ['b'])
})
