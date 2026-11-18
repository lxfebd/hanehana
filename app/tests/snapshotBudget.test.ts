/**
 * 快照预算分配顺序契约（G1 / A1）。
 *
 * 背景：单次快照总量预算 2GiB 是「先到先得」，而遍历顺序里 `data\*.dat`
 * 排在 `save\*.sav` 前面——资源包会把预算吃满，真存档全部 reason:'budget'，
 * 界面却显示备份成功。排序规则抽成 shared/snapshotBudget.ts 的纯函数，这里钉住：
 *   1. 小文件优先：预算不足时先保证存档本体进快照；
 *   2. 同尺寸按 rel 字典序：同一份目录每次都裁掉同样的文件，skipped 可解释；
 *   3. 空数组/单元素不炸；纯函数不改入参。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
// ESM 之谜：node 只认带 .js 的 specifier，TS 会把它映射回 .ts——两头都通。
import { orderForBudget } from '../src/shared/snapshotBudget.js'

const MB = 1024 * 1024

/** 造一条与 saves.ts 相同的预算裁剪：按顺序累加，超预算就跳过（只统计保留项）。 */
function simulateBudget(entries: { rel: string; size: number }[], budget: number): string[] {
  const kept: string[] = []
  let used = 0
  for (const e of entries) {
    if (used + e.size > budget) continue
    used += e.size
    kept.push(e.rel)
  }
  return kept
}

test('预算顺序：资源包（大 .dat）让位，小存档全部排在前面', () => {
  // 12 × 180MB = 2160MB > 2GiB 预算：按字典序 data/ 先来会把预算吃光，
  // 30 个 4KB 存档就全被裁掉——这正是要修的静默缺件。
  const bigs = Array.from({ length: 12 }, (_, i) => ({
    rel: `data/big${String(i).padStart(2, '0')}.dat`,
    size: 180 * MB,
  }))
  const saves = Array.from({ length: 30 }, (_, i) => ({
    rel: `save/slot${String(i).padStart(2, '0')}.sav`,
    size: 4096,
  }))
  // 故意把资源包放在数组前面（模拟字典序遍历）
  const ordered = orderForBudget([...bigs, ...saves])

  // 小存档必须全部排在资源包之前：预算不够时先保存档本体
  const firstBig = ordered.findIndex((e) => e.rel.startsWith('data/'))
  assert.equal(firstBig, 30, '30 个小存档必须排在最前面')
  assert.equal(
    ordered.slice(0, 30).every((e) => e.rel.startsWith('save/')),
    true,
    '前 30 个必须都是存档',
  )

  // 按真实预算模拟：30 个存档一个都不能被裁
  const kept = simulateBudget(ordered, 2 * 1024 * MB)
  assert.equal(kept.filter((r) => r.startsWith('save/')).length, 30, '预算不足时存档本体必须全保住')
  assert.ok(kept.filter((r) => r.startsWith('data/')).length < 12, '资源包应有一部分让位')
})

test('同尺寸按 rel 字典序（确定性：两次排序结果相同）', () => {
  const entries = [
    { rel: 'save/b.sav', size: 10 },
    { rel: 'data/z.dat', size: 10 },
    { rel: 'save/c.sav', size: 10 },
    { rel: 'save/a.sav', size: 10 },
  ]
  const ordered = orderForBudget(entries)
  assert.deepEqual(
    ordered.map((e) => e.rel),
    ['data/z.dat', 'save/a.sav', 'save/b.sav', 'save/c.sav'],
    '同尺寸按 rel 升序',
  )
  // 可复现：同一份输入再排一次得到同一个顺序（readdir 顺序变了也不影响）
  const shuffled = [entries[2], entries[0], entries[3], entries[1]]
  assert.deepEqual(
    orderForBudget(shuffled).map((e) => e.rel),
    ordered.map((e) => e.rel),
    '输入顺序不影响结果',
  )
})

test('空数组/单元素不炸，且纯函数不改入参', () => {
  assert.deepEqual(orderForBudget([]), [])

  const one = [{ rel: 'save/only.sav', size: 4096 }]
  const ordered = orderForBudget(one)
  assert.deepEqual(ordered, one, '单元素原样返回')
  assert.notEqual(ordered, one, '返回的是新数组（纯函数，不改入参）')

  const input = [
    { rel: 'save/b.sav', size: 20 },
    { rel: 'save/a.sav', size: 10 },
  ]
  orderForBudget(input)
  assert.deepEqual(
    input.map((e) => e.rel),
    ['save/b.sav', 'save/a.sav'],
    '入参顺序不能被原地排序改掉',
  )
})
