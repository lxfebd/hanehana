/**
 * 分块算文件 sha1（纯 node，可单测）。
 *
 * 为什么不用 `readFileSync(p)` 一把梭：存档快照会碰到几百 MB 的资源包
 * （`.dat`/`.xp3` 之类），整读进内存等于拿主进程的堆去赌文件大小，OOM 时
 * 整个应用一起死。旧实现在这里退成了「超过 200MB 直接跳过不备份」——
 * 那是拿数据完整性换内存，而且界面上看不出来（备份报告成功、恢复时少文件）。
 *
 * 现在固定 1 MiB 分块喂给 hash，内存占用与文件大小无关；sha1 是流式的，
 * 分块结果与一次性读入完全等价（测试用同一份内容比对两种算法）。
 */
import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync } from 'node:fs'

/** 分块大小：1 MiB。够大减少系统调用，够小不撑堆。 */
const CHUNK_BYTES = 1 << 20

/**
 * 算文件的 sha1（小写 hex）。
 * 读失败（文件被占用/删除/权限）直接抛原始错误——调用方决定是跳过还是整批失败，
 * 函数本身不吞异常。
 */
export function sha1File(path: string, chunkBytes = CHUNK_BYTES): string {
  const hash = createHash('sha1')
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(chunkBytes)
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) break
      hash.update(buf.subarray(0, n))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}
