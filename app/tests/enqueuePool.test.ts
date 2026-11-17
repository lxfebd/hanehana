/**
 * M3 回归靶：批量入队池 + 进度聚合。
 *
 * 现场：120 分卷的分享解析出 120 条直链后，渲染层逐个 `await sitesAddTask`，
 * 120 次串行 IPC，且每入队一个刷一次「正在加入（i/120）」——几秒内进度文字
 * 跳 120 次，看起来像卡住刷屏。这里钉死四件事：
 *   1. 在飞数不超过 concurrency；
 *   2. 每项都处理、下标顺序不丢不重；
 *   3. 单个 worker 抛错不拖垮整批，failed/errors 计数正确；
 *   4. 进度降频后更新次数有上界，且最后一条一定是 total/total（不停在 37/120）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createThrottledProgress, runPool } from '../src/shared/enqueuePool.js'

/** 让出事件循环，模拟真实的异步 IPC 往返。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('并发峰值不超过 concurrency（4），且并发确实被用满', async () => {
  const items = Array.from({ length: 20 }, (_, i) => i)
  let active = 0
  let peak = 0
  let processed = 0
  const res = await runPool(
    items,
    async () => {
      active++
      peak = Math.max(peak, active)
      await sleep(2)
      active--
      processed++
    },
    4,
  )
  assert.equal(processed, 20)
  assert.equal(res.ok, 20)
  assert.equal(res.failed, 0)
  assert.ok(peak <= 4, `并发峰值应 ≤ 4，实际 ${peak}`)
  // 20 项、每项 2ms：池子应该把 4 条道同时跑起来，而不是退化成串行
  assert.equal(peak, 4)
})

test('全部处理完且顺序保持（完成顺序可以乱，调用顺序必须按原数组）', async () => {
  const items = Array.from({ length: 12 }, (_, i) => i)
  const order: number[] = []
  let done = 0
  const res = await runPool(
    items,
    async (_item, index) => {
      order.push(index)
      // 故意让前面的项慢、后面的项快：只按调用顺序记录，不受完成顺序影响
      await sleep(items.length - index)
      done++
    },
    4,
  )
  assert.equal(done, 12)
  assert.equal(res.ok, 12)
  assert.equal(res.failed, 0)
  assert.deepEqual(order, items, 'worker 调用顺序应与原数组一致')
})

test('单个 worker 抛错不影响其余项，failed 与 errors 正确（按原数组顺序）', async () => {
  const items = Array.from({ length: 10 }, (_, i) => i)
  const called: number[] = []
  const res = await runPool(
    items,
    async (_item, index) => {
      called.push(index)
      // 下标 3 的失败慢、7 的失败快：errors 仍要按原数组下标排，提示「第一条」才稳定
      if (index === 3) {
        await sleep(20)
        throw new Error('boom-3')
      }
      if (index === 7) {
        await sleep(1)
        throw new Error('boom-7')
      }
      await sleep(2)
    },
    4,
  )
  assert.deepEqual(
    called.slice().sort((a, b) => a - b),
    items,
    '所有项都应被处理',
  )
  assert.equal(res.ok, 8)
  assert.equal(res.failed, 2)
  assert.deepEqual(res.errors, ['boom-3', 'boom-7'], 'errors 按原数组下标排序，与完成顺序无关')
})

test('空数组直接返回零汇总，不调用 worker', async () => {
  let called = 0
  const res = await runPool([], async () => {
    called++
  })
  assert.deepEqual(res, { ok: 0, failed: 0, errors: [] })
  assert.equal(called, 0)
})

test('concurrency 非法（0/NaN）按 1 处理，不丢项也不并发', async () => {
  let active = 0
  let peak = 0
  let processed = 0
  const res = await runPool(
    [1, 2, 3],
    async () => {
      active++
      peak = Math.max(peak, active)
      await sleep(1)
      active--
      processed++
    },
    0,
  )
  assert.equal(processed, 3)
  assert.equal(res.ok, 3)
  assert.equal(peak, 1, '非法并发数应退化为串行而不是卡住')
})

test('进度聚合：120 项快速完成时更新 ≤ 25 次，最后一条是 120/120', async () => {
  const seen: Array<{ done: number; total: number }> = []
  const progress = createThrottledProgress(120, (done, total) => seen.push({ done, total }))
  // 120 个文件在几秒内全入队：update 之间没有真实时间间隔，只剩 10% 粒度在起作用
  for (let i = 1; i <= 120; i++) progress.update(i)
  progress.flush()
  assert.ok(progress.emitted <= 25, `进度更新次数应 ≤ 25，实际 ${progress.emitted}`)
  const last = seen[seen.length - 1]!
  assert.deepEqual(last, { done: 120, total: 120 }, '最后一条进度必须是 120/120')
  // 进度只许单调前进，不能因为并发完成顺序出现回跳
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i]!.done > seen[i - 1]!.done)
})

test('进度聚合：最后一步没到 total 时 flush 必须补一条 total/total', async () => {
  const seen: string[] = []
  const progress = createThrottledProgress(120, (done, total) => seen.push(`${done}/${total}`))
  progress.update(37)
  progress.flush()
  assert.equal(progress.lastDone, 120)
  assert.equal(seen[seen.length - 1], '120/120')
  // 收尾提示只出现一次：已经到过 total 再 flush 不应重复发
  const before = progress.emitted
  progress.flush()
  assert.equal(progress.emitted, before)
  assert.equal(seen[seen.length - 1], '120/120')
})

test('进度聚合：先到者生效——慢速时按 500ms 至少推一条（不等到 10%）', () => {
  let clock = 0
  const emitted: number[] = []
  const progress = createThrottledProgress(100, (done) => emitted.push(done), { now: () => clock })
  // 每个文件耗时 1s（< 10% 步进）：时间型门槛先到，5 件后也就该出一条
  clock = 1000
  progress.update(1)
  assert.deepEqual(emitted, [1], '1 秒已过 500ms 门槛，即使只走了 1% 也该发')
  // 时间未到、进度也未到 10%：丢弃
  clock = 1100
  progress.update(2)
  assert.deepEqual(emitted, [1])
  // 时间再到：发
  clock = 1500
  progress.update(3)
  assert.deepEqual(emitted, [1, 3])
})

test('进度聚合：total 为 0 时不出进度也不 flush 出 0/0', () => {
  const seen: string[] = []
  const progress = createThrottledProgress(0, (done, total) => seen.push(`${done}/${total}`))
  progress.update(0)
  progress.update(5)
  progress.flush()
  assert.deepEqual(seen, [])
})
