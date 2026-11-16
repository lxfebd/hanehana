/**
 * 子进程退出判定（纯函数，可单测）。
 *
 * 为什么单独成文件：这条判定此前散在 `main/games.ts` 里，写成
 * `code !== 0 && code !== null`，旁边的注释还写着「信号终止同样是非 0」——
 * 但 Node 里被信号杀死的进程 `code === null`、`signal` 才有值（`'SIGSEGV'` /
 * `'SIGKILL'`…）。于是崩溃被判成「正常退出」，反倒在崩溃现场触发了自动存档
 * 备份，而「可能异常退出」的通知永远不响。
 *
 * 现在判定只此一处，以 `signal` 为准；调用方（recordExit / 自动备份）共用。
 */

/**
 * 是否属于异常退出。
 *
 * - `signal !== null`：被信号终止（崩溃、被系统/任务管理器杀掉）→ 异常。
 * - `code !== 0`：进程自己以非 0 退出 → 异常。
 * - `code === 0`：正常关闭（用户关窗口）→ 正常。
 * - 两者都为 null：平台没给任何信息，按正常处理（宁可不误报，也不谎报崩溃）。
 */
export function isAbnormalExit(code: number | null, signal: string | null): boolean {
  if (signal !== null && signal !== '') return true
  return code !== null && code !== 0
}
