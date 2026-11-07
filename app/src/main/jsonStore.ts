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
 *   - 上一份好内容永远在 `<file>.bak`：每次写前把主文件 rename 成 .bak
 *     （O(1) 元数据操作，不是拷贝），主文件损坏/缺失时 load() 从 .bak 恢复，
 *     损坏的主文件改名留证（`.corrupt-<ts>`）——tasks.json 损坏不再等于
 *     「下载列表静默清空、.part 断点续不上」；
 *   - fsync：tmp 写完后 fsync 文件、rename 后 fsync 目录，掉电后文件名与内容一致；
 *   - 尾触发合并：连续 save 只落盘一次（默认 400ms 窗口），
 *     高写入频率（进度回调、回填循环）不会把磁盘打成全量写风暴；
 *   - flush()：进程退出前把待写内容同步落盘，不丢最后一批。
 * 与旧实现的行为差异只有一个：tasks.json 从「每 100ms 同步写」变成
 * 「400ms 合并写」——重启最坏丢 400ms 的进度偏移，引擎侧每 100ms 自己
 * 落一次 sidecar，损失窗口与引擎一致，可接受。
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
} from 'node:fs'
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
    // 先把当前主文件挪成 .bak 再写新的：rename 是 O(1) 元数据操作（不是拷贝），
    // 于是每一次成功写之后，上一份好内容永远在 `<file>.bak` 里。进程若在
    // 「挪走主文件」与「新文件 rename 就位」之间被杀，主文件缺失、.bak 是上一版，
    // 启动时 load() 会从 .bak 恢复——比「主文件写花一半」强得多。
    try {
      if (existsSync(file)) renameSync(file, `${file}.bak`)
    } catch {
      /* 主文件被占用挪不走：不阻塞本次写，.bak 停留在上一版 */
    }
    const tmp = `${file}.tmp`
    // 先写再 fsync 再 rename：不 fsync 的话，掉电后新名字可能配着空/旧内容
    // （数据还在页缓存里，rename 的目录项也一样）——文件名是新的、内容是坏的。
    const fd = openSync(tmp, 'w', 0o600)
    try {
      writeSync(fd, Buffer.from(toJson(value), 'utf8'))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, file)
    // 目录项也要 fsync：rename 落盘的是 inode，新名字在目录里的条目要等目录
    // fsync 才扛得住掉电。少数平台/文件系统不允许 fsync 目录，失败不致命。
    try {
      const dfd = openSync(dirname(file), 'r')
      try {
        fsyncSync(dfd)
      } finally {
        closeSync(dfd)
      }
    } catch {
      /* 目录 fsync 不支持就算了：文件内容已经 fsync 过 */
    }
  }

  return {
    load(): T | null {
      if (existsSync(file)) {
        try {
          return JSON.parse(readFileSync(file, 'utf8')) as T
        } catch {
          // 主文件损坏：改名留证（半截写入/磁盘坏道），别让下一次 load 再踩同一个坑
          try {
            renameSync(file, `${file}.corrupt-${Date.now()}`)
          } catch {
            /* 证也留不住（占用中）不致命：.bak 优先 */
          }
        }
      }
      // 主文件缺失（含刚被留证的）→ 从上一份好的 .bak 恢复。
      // 缺失本身可能是「写了一半进程死了」：挪成 .bak 之后新文件没就位。
      const bak = `${file}.bak`
      if (existsSync(bak)) {
        try {
          const value = JSON.parse(readFileSync(bak, 'utf8')) as T
          try {
            copyFileSync(bak, file)
          } catch {
            /* 恢复不了主文件也不致命：调用方拿到值就能跑，下次 save 会重写 */
          }
          return value
        } catch {
          /* .bak 也坏了： genuinely 没东西可读 */
        }
      }
      return null
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
