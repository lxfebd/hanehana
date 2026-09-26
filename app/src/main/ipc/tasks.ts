/**
 * 下载引擎 IPC：任务列表/增删/动作/线程/校验和。通道名来自 Ipc，一字不改。
 */
import { ipcMain } from 'electron'
import { resolve, sep } from 'node:path'
import { Ipc } from '../../shared/ipc'
import { normalizeChecksum } from '../../shared/types'
import { isId, err, DOWNLOAD_URL_RE, TASK_ACTIONS, ALL_ACTIONS, type IpcCtx } from './shared'

/** dest 是否落在允许的目录树里（默认下载目录 + 本次会话用户手选的目录）。 */
export function isDestAllowed(dest: string, roots: string[]): boolean {
  const p = resolve(dest).toLowerCase()
  for (const r of roots.filter((x) => typeof x === 'string' && !!x)) {
    const root = resolve(r).toLowerCase()
    if (p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)) return true
  }
  return false
}

export function registerTasksHandlers(ctx: IpcCtx): void {
  const m = () => ctx.manager()
  const s = () => ctx.store()

  ipcMain.handle(Ipc.TasksList, () => m().rows())

  ipcMain.handle(Ipc.TasksAdd, (_e, input) => {
    const raw = (input ?? {}) as Record<string, unknown>
    const url = typeof raw.url === 'string' ? raw.url.trim() : ''
    if (!DOWNLOAD_URL_RE.test(url)) return err('下载地址无效：需要 http(s):// 或 ftp:// 开头')
    const dest = typeof raw.dest === 'string' ? raw.dest.trim() : ''
    if (dest.length > 4000) return err('保存路径过长')
    if (dest && !isDestAllowed(dest, [s().loadSettings().download_dir, ...ctx.approvedDirs()])) {
      return err('保存路径不在允许的目录内：请用「浏览」选目录，或在设置里改默认保存目录')
    }
    const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 500) : ''
    const checksum = normalizeChecksum(typeof raw.checksum === 'string' ? raw.checksum : '')
    if (checksum === null) {
      return err('校验和看不懂：需要 32 位（MD5）/ 40 位（SHA-1）/ 64 位（SHA-256）十六进制，或写成 sha256:… 的形式')
    }
    const requested = Number.isFinite(raw.threads) ? Math.floor(Number(raw.threads)) : s().loadSettings().threads
    const threads = Math.min(32, Math.max(1, Number.isFinite(requested) ? requested : 8))
    return { ok: true as const, ...m().add({ url, dest, threads, note, checksum }) }
  })

  ipcMain.handle(Ipc.TasksRemove, async (_e, id: unknown, deleteFiles: unknown) => {
    if (!isId(id) || !m().has(id)) return err('任务不存在，可能已经被移除')
    const failures = await m().remove(id, deleteFiles === true)
    if (failures.length) return err(`任务已移除，但文件没删掉：${failures.join('；')}`)
    return { ok: true as const }
  })

  ipcMain.handle(Ipc.TasksClearFinished, async () => {
    await m().clearFinished()
    return { ok: true as const }
  })

  ipcMain.handle(Ipc.TaskAction, (_e, id: unknown, action: unknown) => {
    if (!isId(id) || !m().has(id)) return err('任务不存在，可能已经被移除')
    if (typeof action !== 'string' || !TASK_ACTIONS.has(action)) {
      return err(`不支持的操作：${String(action)}`)
    }
    m().action(id, action)
    return { ok: true as const }
  })

  ipcMain.handle(Ipc.TaskSetThreads, (_e, id: unknown, n: unknown) => {
    if (!isId(id) || !m().has(id)) return err('任务不存在，可能已经被移除')
    if (!Number.isFinite(n)) return err('线程数无效')
    m().setThreads(id, Number(n))
    return { ok: true as const }
  })

  ipcMain.handle(Ipc.TaskSetChecksum, (_e, id: unknown, cs: unknown) => {
    if (!isId(id) || !m().has(id)) return err('任务不存在，可能已经被移除')
    const checksum = normalizeChecksum(typeof cs === 'string' ? cs : '')
    if (checksum === null) {
      return err('校验和看不懂：需要 32 位（MD5）/ 40 位（SHA-1）/ 64 位（SHA-256）十六进制，或写成 sha256:… 的形式')
    }
    m().setChecksum(id, checksum)
    return { ok: true as const }
  })

  ipcMain.handle(Ipc.ActionAll, async (_e, action: unknown) => {
    if (typeof action !== 'string' || !ALL_ACTIONS.has(action)) {
      return err(`不支持的操作：${String(action)}`)
    }
    await m().actionAll(action)
    return { ok: true as const }
  })
}
