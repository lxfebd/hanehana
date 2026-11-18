/**
 * 快照预算分配顺序（G1）。
 *
 * 背景：单次快照的总量预算是 2GiB，创建快照时按顺序逐文件累加，超出的进
 * meta.json 的 skipped[]（reason='budget'）。谁被裁掉完全由遍历顺序决定。
 *
 * 为什么是「小文件优先」而不是按用途（扩展名/目录）列黑名单：
 * - collectSaveFiles 已经用 bigBodyRe 过滤过一遍本体文件，但 `.dat` 这个扩展名
 *   两头都占：它既是常见存档后缀，也常被资源包/语音包占用（实测一个
 *   180MB 的 `data/big.dat` 就能把预算吃光）。要按用途区分，就得再维护一张
 *   「哪些 .dat 是资源包」的新名单——名单永远不全，还会把真存档误杀，等于把
 *   这次要修的静默缺件换一种形式复现。
 * - 体积是唯一不需要名单的判据：存档本体普遍是 KB~MB，资源包才是大块头。
 *   预算不够时让大块头让位，真存档就能全部进快照；同时小文件先拷贝也让
 *   「最可能重要的文件」优先落盘。
 * - 排序必须确定（同尺寸按 rel 字典序），否则同一份目录两次快照裁掉的文件
 *   可能不同，skipped 清单就没法解释——readdir 在 NTFS 上恰好近字典序，
 *   但那不是契约。
 *
 * 这个函数是纯函数（不改入参、不读盘），排序规则由 tests/snapshotBudget.test.ts
 * 钉住；创建快照时由 saves.ts 调用，单文件闸门与拷贝逻辑仍留在那里。
 */

/** 参与预算排序的最小形状：只要相对路径与字节数，不绑定具体文件类型。 */
export interface BudgetEntry {
  /** 相对游戏目录的路径（同时是确定性的第二排序键）。 */
  rel: string
  /** 文件字节数（第一排序键：小的先分预算）。 */
  size: number
}

/**
 * 按「小文件优先、同尺寸按 rel 字典序」排出一份**新的**预算分配顺序。
 *
 * 为什么返回新数组而不是原地 sort：调用方（saves.ts）手里那份清单还要用来
 * 对账/排查，纯函数契约也让测试能断言「入参没被改」。
 */
export function orderForBudget<T extends BudgetEntry>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => {
    if (a.size !== b.size) return a.size - b.size
    // 同尺寸按 rel 升序：路径唯一，排序结果因此完全确定（可复现）。
    return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0
  })
}
