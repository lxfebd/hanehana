/**
 * 进程状态派生（对标 KoiPage 的 launching 派生式）。
 *
 * KoiPage 把 launching 设计成 gameProcesses 的派生：
 * `setGameProcess` 里 status==='starting' 才置 launching，其余一律 delete。
 * 好处是**不存在"忘了收尾"这种失败模式**——只要状态推下去，派生自动归假。
 *
 * 这里把同一语义收敛成两个纯函数，渲染层（CoverGrid/DetailPanel/LibraryHero）
 * 与 store 共用；types.ts 里的 isLaunching 保留给只关心启动中的调用方。
 */
// ESM 之谜：node 只认带 .js 的 specifier，TS 会把它映射回 .ts——两头都通。
import { isLaunching, type GameProcessState } from './types.js'

export { isLaunching }

/** 运行中：只有 running 为真。 */
export function isRunning(state: GameProcessState | undefined): boolean {
  return state?.status === 'running'
}

/** 是否已结束（正常退出或启动失败）。 */
export function isExited(state: GameProcessState | undefined): boolean {
  return state?.status === 'exited'
}

export type { GameProcessState }
