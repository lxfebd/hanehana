/**
 * 下载任务领域 store（REDESIGN-SPEC §3.2）。
 *
 * 持有任务行 + 过滤/搜索/排序 + 新建对话框 + 设置 + 全速合计，
 * 以及推送订阅的接线与清理。组件不直接碰 window.hh。
 */
import { reactive } from 'vue'
import { message } from 'ant-design-vue'
import type { ActionResult, AddResult, Settings, TaskRow } from '../../shared/types'
import type { TaskSort } from '../status'
import { library } from './library'
import { ui } from './ui'

export const downloads = reactive({
  rows: [] as TaskRow[],
  taskFilter: 'all',
  taskQuery: '',
  taskSort: 'added-desc' as TaskSort,
  addDialogOpen: false,
  settings: null as Settings | null,
  totalSpeed: 0,
})

/** 兜底轮询周期：引擎每 100ms 主动推一次，这个只是防推送链路断掉的保险。 */
const REFRESH_MS = 5000

async function refreshTasks(): Promise<void> {
  if (!window.hh?.listTasks) return
  try {
    downloads.rows = await window.hh.listTasks()
    downloads.totalSpeed = downloads.rows.reduce(
      (sum, r) => sum + (r.snap?.state === 'downloading' ? r.snap.speed : 0),
      0,
    )
  } catch {
    // 主进程未就绪时忽略，下次轮询重试
  }
}

/** 写操作的统一回执：失败必须让用户看见。 */
export function report(result: ActionResult | AddResult, okText?: string): boolean {
  if (!result.ok) {
    message.error(result.error)
    return false
  }
  if (okText) {
    if ('duplicate' in result && result.duplicate) message.info('该链接已经在下载列表里')
    else message.success(okText)
  }
  return true
}

/** IPC 通道本身被拒（主进程崩溃、频道未注册）也要有声音。 */
export function reportRejection(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e ?? '')
  message.error(`操作失败：${msg.trim() || '未知错误（主进程未响应）'}`)
}

export async function addTask(input: {
  url: string
  dest: string
  threads: number
  note?: string
  checksum?: string
}): Promise<boolean> {
  try {
    const r = await window.hh.addTask(input)
    return report(r, '已添加到下载队列')
  } catch (e) {
    reportRejection(e)
    return false
  }
}

export async function taskAction(id: string, action: 'start' | 'pause' | 'resume' | 'retry'): Promise<void> {
  const r = await window.hh.action(id, action)
  if (!r.ok) message.error(r.error)
}

export async function removeTask(id: string, deleteFiles: boolean): Promise<void> {
  const r = await window.hh.removeTask(id, deleteFiles)
  if (!r.ok) message.error(r.error)
  else message.success(deleteFiles ? '任务与文件已删除' : '任务已移除（文件保留）')
}

export async function openSettings(): Promise<void> {
  downloads.settings = await window.hh.getSettings()
  ui.settingsOpen = true
}

/**
 * 进度推送：已有 id 直接合并快照（每 100ms 一条，不能重拉全量）；
 * 列表里没有的 id = 外边冒出来的任务（设置/托盘/通知路径），冷却后重拉一次。
 * 返回 unsubscribe 集合，App onUnmounted 时调用清理（原实现的泄漏点）。
 */
export function wireTaskPushes(): Array<() => void> {
  const unsubs: Array<() => void> = []
  let refetching = false
  let lastRefetch = 0
  unsubs.push(
    window.hh.onTaskProgress((p) => {
      const row = downloads.rows.find((r) => r.id === p.taskId)
      if (row) {
        row.snap = p.snapshot
        if (p.snapshot.state === 'downloading') {
          downloads.totalSpeed = downloads.rows.reduce(
            (sum, r) => sum + (r.snap?.state === 'downloading' ? r.snap.speed : 0),
            0,
          )
        }
        return
      }
      if (refetching || Date.now() - lastRefetch < 1000) return
      refetching = true
      lastRefetch = Date.now()
      void refreshTasks().finally(() => {
        refetching = false
      })
    }),
  )
  // 点了系统通知 → 把那条任务摆到眼前：清掉搜索词并回到「全部」桶，
  // 否则失败任务可能正被过滤条件挡着，列表里看不到任何变化。
  unsubs.push(
    window.hh.onTaskFocus((taskId) => {
      downloads.taskQuery = ''
      downloads.taskFilter = 'all'
      downloads.rows = [] // 触发一次全量重拉，让选中行带着最新快照出现
      void refreshTasks()
      library.selectedId = taskId
    }),
  )
  return unsubs
}

export async function initTasks(): Promise<Array<() => void>> {
  if (!window.hh?.listTasks) return []
  downloads.settings = await window.hh.getSettings()
  await refreshTasks()
  const unsubs = wireTaskPushes()
  const timer = setInterval(refreshTasks, REFRESH_MS)
  unsubs.push(() => clearInterval(timer))
  return unsubs
}
