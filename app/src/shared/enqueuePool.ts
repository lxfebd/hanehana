/**
 * 批量入队的并发池 + 进度聚合（M3 抽出的纯逻辑，不依赖 Vue/DOM）。
 *
 * 现场：一个 120 分卷的分享解析出 120 条直链后，渲染层原来是
 * `for (…) await window.hh.sitesAddTask(…)`：120 次 IPC 排成一条队，每入队
 * 一个还刷一次「正在加入（i/120）」。几秒内进度文字跳 120 次，用户读到的
 * 不是「在干活」而是「卡住了在刷屏」。
 *
 * 这里把两件事抽成可单测的纯函数：
 *   - runPool：同时最多 N 个在飞，单个失败记下来继续跑，不中断整批；
 *   - createThrottledProgress：把逐件进度降频成「每 500ms 或每 10% 先到者」，
 *     并保证收尾时最后一条一定是 total/total（不会停在 37/120）。
 */

/** 一批入队结束后的汇总。 */
export interface PoolResult {
  /** worker 正常返回的项数。 */
  ok: number
  /** worker 抛出/被 reject 的项数。 */
  failed: number
  /** 失败原因，按原数组下标排序（不按并发完成顺序，提示里的「第一条」才稳定）。 */
  errors: string[]
}

/**
 * 并发跑完 items，返回成功/失败汇总。
 *
 * 为什么用「拉取式泵」而不是 Promise.race 手写调度：每个 pump 在循环顶部
 * 同步认领下标再 await，下标分配没有竞态；在飞数量天然被 pump 个数封顶，
 * 失败也只在 pump 内部记账，不会冒成未处理的 rejection 打断整批。
 * 下标是同步递增分配的，所以 worker 的调用顺序就是原数组顺序。
 *
 * @param items 待处理项（保持原数组顺序，不保证完成顺序）
 * @param worker 单个项的处理；抛错即计为失败，整批继续
 * @param concurrency 并发上限（默认 4；非数字/小于 1 时按 1 处理）
 */
export async function runPool<T>(
  items: T[],
  worker: (_item: T, _index: number) => Promise<void>,
  concurrency = 4,
): Promise<PoolResult> {
  const total = items.length
  const limit = Math.max(1, Math.floor(Number.isFinite(concurrency) ? concurrency : 1))
  let next = 0
  let ok = 0
  // 先按下标记，最后排序再摊平成消息：并发完成顺序是随机的，直接 push 会让
  // 同一批失败的提示文案每次不同（report 里只展示第一条）。
  const failures: Array<{ index: number; message: string }> = []

  async function pump(): Promise<void> {
    for (;;) {
      const index = next++
      if (index >= total) return
      try {
        await worker(items[index] as T, index)
        ok++
      } catch (e) {
        failures.push({ index, message: e instanceof Error ? e.message : String(e) })
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, total) }, () => pump()))
  failures.sort((a, b) => a.index - b.index)
  return { ok, failed: failures.length, errors: failures.map((f) => f.message) }
}

/** 进度出口：done 为已完成件数，total 为总数。 */
export type ProgressEmit = (_done: number, _total: number) => void

export interface ThrottleOptions {
  /** 两次「时间型」更新的最小间隔（毫秒）。默认 500 → 最多约 2 次/秒。 */
  minIntervalMs?: number
  /** 「进度型」更新的最小步进（百分比）。默认 10 → 每走 10% 至少推一条。 */
  percentStep?: number
  /** 时间源，单测注入假时钟；生产用 Date.now。 */
  now?: () => number
}

export interface ProgressSink {
  /** 报告「已完成 done 件」；没到节流门槛的调用就地丢弃。 */
  update(_done: number): void
  /** 收尾补发：把最后一条补成 total/total（已到过 total 就不重复发）。 */
  flush(): void
  /** 实际发出的更新次数（单测/调试用）。 */
  readonly emitted: number
  /** 最近一次发出的 done 值（一次没发过为 0）。 */
  readonly lastDone: number
}

/**
 * 建一个节流后的进度出口。
 *
 * 规则是「先到者生效」：距离上次发出已过 minIntervalMs，或比上次多走了
 * percentStep 的进度，任一满足就发。这样慢速时（单个文件就要几秒）进度仍
 * 每秒动两次，不会显得死掉；快速时（120 个小文件几秒内全完）按 10% 一跳，
 * 更新次数从 120 次压到 10 次左右。
 */
export function createThrottledProgress(
  total: number,
  emit: ProgressEmit,
  options: ThrottleOptions = {},
): ProgressSink {
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0
  const minInterval = Math.max(0, options.minIntervalMs ?? 500)
  const percent = Math.min(100, Math.max(1, options.percentStep ?? 10))
  const now = options.now ?? Date.now
  // 百分比门槛换算成「至少多少件」：120 × 10% = 12 件一跳；向上取整保证
  // 小批量（如 11 件）也不会被拆成近逐条（11 × 10% = 1.1 → 2 件）。
  const step = Math.max(1, Math.ceil((safeTotal * percent) / 100))
  let lastDone = 0
  let lastAt = now()
  let emitted = 0

  function update(done: number): void {
    // 进度只许前进：乱序/重复上报（并发完成顺序不定）一律忽略，避免数字往回跳
    const d = Math.min(safeTotal, Math.max(0, Math.floor(done)))
    if (d <= lastDone) return
    const at = now()
    if (d - lastDone < step && at - lastAt < minInterval) return
    lastDone = d
    lastAt = at
    emitted++
    emit(d, safeTotal)
  }

  function flush(): void {
    // 最后一条必须落在 total：否则用户看到「正在加入（117/120）」一闪就消失，
    // 会以为有文件没进去。已经到过 total 时不再重复发，收尾提示只出现一次。
    if (safeTotal <= 0 || lastDone >= safeTotal) return
    lastDone = safeTotal
    lastAt = now()
    emitted++
    emit(safeTotal, safeTotal)
  }

  return {
    update,
    flush,
    get emitted(): number {
      return emitted
    },
    get lastDone(): number {
      return lastDone
    },
  }
}
