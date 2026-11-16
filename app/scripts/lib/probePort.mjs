/**
 * CDP 探针脚本的公共部分：空闲端口 + 进程树清理。
 *
 * 为什么要有它：30 个 verify_* / ui_* 脚本各自 spawn 一个 Electron，用写死的
 * 93xx 端口 + `proc.kill()`。两个后果：
 *   - Windows 上 `proc.kill()` 只杀主进程，渲染 / GPU 子进程还活着并继续占用
 *     调试端口；下一个脚本连上去的就是**上一个实例**，断言读到别人的数据，
 *     表现为随机的「下载页 0 行 / 元素找不到」——这种假红比不跑还糟。
 *   - 写死的端口还让并行跑（CI 分 job、本地同时开两个）互相撞车。
 * 这里统一成：端口向系统要（bind 0），清理用 taskkill /T 杀整棵树。
 */
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'

/** 向系统要一个当前空闲的本地端口（bind 0 → 读回实际端口 → 关闭）。 */
export function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

/**
 * 杀掉整个进程树。
 * @param {import('node:child_process').ChildProcess | null | undefined} proc
 */
export function killTree(proc) {
  if (!proc || !proc.pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
      return
    } catch {
      /* fallthrough：退回单进程 kill */
    }
  }
  try {
    proc.kill()
  } catch {
    /* 已经退出 */
  }
}
