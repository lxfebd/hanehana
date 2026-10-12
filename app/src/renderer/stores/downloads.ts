/**
 * 下载任务领域 store。
 *
 * 持有任务行 + 过滤/搜索/排序 + 新建对话框 + 设置 + 全速合计，
 * 以及推送订阅的接线与清理。组件不直接碰 window.hh。
 */
import { computed, reactive } from 'vue'
import { message } from 'ant-design-vue'
import type { ActionResult, AddResult, Settings, TaskProgressPush, TaskRow, TaskState } from '../../shared/types'
import type { SiteDownloadPush } from '../../shared/ipc'
import { rowState, type TaskSort } from '../status'
import { library } from './library'
import { ui, applyDarkFromSettings } from './ui'

export const downloads = reactive({
  rows: [] as TaskRow[],
  taskFilter: 'all',
  taskQuery: '',
  taskSort: 'added-desc' as TaskSort,
  addDialogOpen: false,
  settings: null as Settings | null,
  totalSpeed: 0,
  /**
   * 本次会话内「有任务刚结束」的计数：done 与 error/cancelled 分开记。
   * 汇总条据此出现（done>0 || error>0），点击计数可切对应筛选。
   */
  batchEvent: { done: 0, error: 0 },
})

/** 终态集合：进入这些状态的任务在汇总条里算「刚结束」。 */
const FINAL_STATES = new Set<TaskState>(['done', 'error', 'cancelled'])

/**
 * 每个任务上一观测到的状态：用于检测「非终态 → 终态」的转换（第一眼看到终态也算）。
 * 模块级而非 wireTaskPushes 局部：refreshTasks 清理它的残留条目时也要引用。
 */
const prevStates = new Map<string, TaskState>()

export function clearBatchEvent(): void {
  downloads.batchEvent = { done: 0, error: 0 }
}

/**
 * 汇总条显示条件：有任务刚结束（本会话内），或当前还有失败/取消任务常驻。
 * 常驻失败兜底：推送链路断掉时（比如引擎在轮询里才把终态带回来），
 * 只要列表里有失败任务汇总条就不消失，直到被清除/重试。
 */
export const batchEventVisible = computed(() => {
  const hasLiveError = downloads.rows.some((r) => {
    const st = rowState(r)
    return st === 'error' || st === 'cancelled'
  })
  return downloads.batchEvent.done > 0 || downloads.batchEvent.error > 0 || hasLiveError
})

/** 兜底轮询周期：引擎每 100ms 主动推一次，这个只是防推送链路断掉的保险。 */
const REFRESH_MS = 5000

export async function refreshTasks(): Promise<void> {
  if (!window.hh?.listTasks) return
  try {
    const rows = await window.hh.listTasks()
    downloads.totalSpeed = 0
    for (const r of rows) {
      downloads.totalSpeed += r.snap?.state === 'downloading' ? r.snap.speed : 0
    }
    downloads.rows = rows
    // 任务被删除/不再推送后，prevStates 里的终态条目就没有意义了——
    // 它是「上一观测状态」缓存，只对仍在列表里的任务有用。逐轮清理
    // 防止长时间运行后 Map 无限膨胀（每删一个任务就漏一条）。
    if (prevStates.size > rows.length) {
      const live = new Set(rows.map((r) => r.id))
      for (const k of prevStates.keys()) {
        if (!live.has(k)) prevStates.delete(k)
      }
    }
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
  try {
    const r = await window.hh.action(id, action)
    if (!r.ok) message.error(r.error)
  } catch (e) {
    reportRejection(e)
  }
}

export async function removeTask(id: string, deleteFiles: boolean): Promise<void> {
  const r = await window.hh.removeTask(id, deleteFiles)
  if (!r.ok) message.error(r.error)
  else message.success(deleteFiles ? '任务与文件已删除' : '任务已移除（文件保留）')
}

export async function openSettings(): Promise<void> {
  downloads.settings = await window.hh.getSettings()
  applyDarkFromSettings(downloads.settings.dark, downloads.settings.theme_preset)
  ui.settingsOpen = true
}

/**
 * 进度推送：已有 id 直接合并快照（每 100ms 一条，不能重拉全量）；
 * 列表里没有的 id = 外边冒出来的任务（设置/托盘/通知路径），冷却后重拉一次。
 * 返回 unsubscribe 集合，App onUnmounted 时调用清理（原实现的泄漏点）。
 */
/**
 * 进度推送：已有 id 直接合并快照（每 100ms 一条，不能重拉全量）；
 * 列表里没有的 id = 外边冒出来的任务（设置/托盘/通知路径），冷却后重拉一次。
 * 返回 unsubscribe 集合，App onUnmounted 时调用清理（原实现的泄漏点）。
 *
 * snap 更新走 rAF 合并：主进程每 100ms 推一条，renderer 若每条都立即替换
 * row.snap，Vue 会对 visibleRows/counts 全部重算——百任务列表每 100ms 全量
 * 排序一次。攒到下一帧一次性应用，60fps 帧内至多一次重算；进度条仍是每帧
 * 平滑推进（60Hz > 10Hz 推送频率），总计算量降一个数量级。
 */
export function wireTaskPushes(): Array<() => void> {
  const unsubs: Array<() => void> = []
  let refetching = false
  let lastRefetch = 0
  // 攒批队列：同 id 后到的覆盖先到的（进度单调），每帧每个任务只应用最新快照
  const pending = new Map<string, TaskProgressPush>()
  let raf = 0
  const flush = (): void => {
    raf = 0
    if (!pending.size) return
    for (const p of pending.values()) applyPush(p)
    pending.clear()
  }
  const schedule = (p: TaskProgressPush): void => {
    pending.set(p.taskId, p)
    if (!raf) raf = requestAnimationFrame(flush)
  }
  /** 真正应用一条推送（rAF 帧内批量执行）。 */
  const applyPush = (p: TaskProgressPush): void => {
    const row = downloads.rows.find((r) => r.id === p.taskId)
    if (row) {
      const prev = row.snap?.state === 'downloading' ? row.snap.speed : 0
      const prevState = prevStates.get(p.taskId)
      const nextState = p.snapshot.state
      // 刚结束：终态达成（之前不是终态；第一次看到终态也计入，因为任务是本会话内结束的）
      if (FINAL_STATES.has(nextState) && !(prevState && FINAL_STATES.has(prevState))) {
        if (nextState === 'done') downloads.batchEvent.done++
        else downloads.batchEvent.error++
      }
      prevStates.set(p.taskId, nextState)
      row.snap = p.snapshot
      // 进出 downloading 都要校正：只加不减会让暂停/完成的任务把速度留在合计里
      const next = p.snapshot.state === 'downloading' ? p.snapshot.speed : 0
      if (prev !== next) downloads.totalSpeed += next - prev
      return
    }
    if (refetching || Date.now() - lastRefetch < 1000) return
    refetching = true
    lastRefetch = Date.now()
    void refreshTasks().finally(() => {
      refetching = false
    })
  }
  unsubs.push(window.hh.onTaskProgress((p) => schedule(p)))
  // 点了系统通知 → 把那条任务摆到眼前：清掉搜索词并回到「全部」桶，
  // 否则失败任务可能正被过滤条件挡着，列表里看不到任何变化。
  unsubs.push(
    window.hh.onTaskFocus((taskId) => {
      downloads.taskQuery = ''
      downloads.taskFilter = 'all'
      // 不置空 rows：列表/计数/速度合计会闪成空再恢复（渲染 1 帧的空列表）。
      // 直接拉最新快照，选中行带着最新数据出现即可。
      void refreshTasks()
      library.selectedId = taskId
    }),
  )
  return unsubs
}

export async function initTasks(): Promise<Array<() => void>> {
  if (!window.hh?.listTasks) return []
  downloads.settings = await window.hh.getSettings()
  applyDarkFromSettings(downloads.settings.dark, downloads.settings.theme_preset)
  await refreshTasks()
  const unsubs = wireTaskPushes()
  // 游戏站下载推送挂在这里而不是 GameSites 组件里：浏览器下载的「完成」
  // 提示可能在用户切回下载页签之后才到，挂在组件上就等于把这条消息丢掉。
  unsubs.push(window.hh.onSiteDownload((p) => void handleSiteDownload(p)))
  const timer = setInterval(refreshTasks, REFRESH_MS)
  unsubs.push(() => clearInterval(timer))
  return unsubs
}

/**
 * 游戏站下载的三条去向，独立播报：
 *   captured —— 公开直链，已交给邮箱引擎（建任务进下载列表）
 *   browser  —— 需要浏览器会话，Chromium 正在用当前 Cookie 下载（引擎帮不上忙）
 *   done     —— 上面第二条的收尾，告诉用户文件落在哪、成没成
 */
async function handleSiteDownload(p: SiteDownloadPush): Promise<void> {
  if (p.kind === 'browser') {
    message.info(`${p.filename} 需要浏览器会话，已用浏览器下载到 ${p.dest}`)
    return
  }
  if (p.kind === 'done') {
    if (p.ok) message.success(`${p.filename} 下载完成`)
    else message.error(`${p.filename}：${p.error ?? '浏览器下载失败'}`)
    return
  }
  try {
    const r = await window.hh.sitesAddTask({ url: p.url, filename: p.filename })
    report(r, `已添加到下载列表：${p.filename ?? ''}`)
  } catch (e) {
    reportRejection(e)
  }
}
