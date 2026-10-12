/**
 * 通用 JSON 持久化器（jsonStore.ts）。
 *
 * 项目里原本有三套各自实现的「原子写 + 合并写」：
 *   - gameStore：400ms 尾触发合并写 games.json（persistCoalesced）
 *   - Store.saveTasks：每次引擎进度回调都同步全量写 tasks.json（每 100ms 一次）
 *   - Store.appendPlaySessions：读全量 + 过滤 + 重写
 * 三套的合并窗口、flush 语义、错误处理各不相同，改一处忘另一处。
 * 这里收敛成唯一的实现，三个调用方共享同一套规则：
 *   - 原子写：先写 .tmp 再 rename，进程被杀不留半截文件；
 *   - 尾触发合并：连续 save 只落盘一次（默认 400ms 窗口），
 *     高写入频率（进度回调、回填循环）不会把磁盘打成全量写风暴；
 *   - flush()：进程退出前把待写内容同步落盘，不丢最后一批。
 * 与旧实现的行为差异只有一个：tasks.json 从「每 100ms 同步写」变成
 * 「400ms 合并写」——重启最坏丢 400ms 的进度偏移，引擎侧每 100ms 自己
 * 落一次 sidecar，损失窗口与引擎一致，可接受。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

export interface JsonStoreOpts {
  /** 合并窗口（毫秒）。连续 save 在此窗口内只落盘一次。默认 400。 */
  delayMs?: number
}

export interface JsonStore<T> {
  /** 读回。文件缺失/损坏返回 null（调用方决定回落策略）。 */
  load(): T | null
  /** 保存。尾触发合并：窗口内多次调用只写一次最终快照。 */
  save(_value: T): void
  /** 立即把待写内容落盘（进程退出前调用）。返回是否真的写了。 */
  flush(): boolean
}

/**
 * 创建一个合并持久化器。
 * @param file  目标文件路径（目录不存在会自动建）
 * @param serialize  序列化函数；缺省用 JSON.stringify(value, null, 2)
 */
export function createJsonStore<T>(file: string, serialize?: (_v: T) => string, opts?: JsonStoreOpts): JsonStore<T> {
  const toJson = serialize ?? ((v: T) => JSON.stringify(v, null, 2))
  let timer: ReturnType<typeof setTimeout> | null = null
  let dirty = false
  let pending: T | undefined

  const writeNow = (value: T): void => {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, toJson(value), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, file)
  }

  return {
    load(): T | null {
      if (!existsSync(file)) return null
      try {
        return JSON.parse(readFileSync(file, 'utf8')) as T
      } catch {
        return null
      }
    },
    save(value: T): void {
      pending = value
      dirty = true
      if (timer) return
      const delay = opts?.delayMs ?? 400
      timer = setTimeout(() => {
        timer = null
        if (!dirty) return
        dirty = false
        const v = pending
        pending = undefined
        if (v !== undefined) writeNow(v)
      }, delay)
    },
    flush(): boolean {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (!dirty) return false
      dirty = false
      const v = pending
      pending = undefined
      if (v !== undefined) writeNow(v)
      return true
    },
  }
}
