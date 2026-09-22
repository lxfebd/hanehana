<script setup lang="ts">
/**
 * 下载页：左侧状态过滤 + 工具栏（新建/全动）+ 任务列表。
 *
 * 布局与游戏库页共用玻璃风格：侧栏负责状态桶，主区是任务行列表。
 */
import { computed } from 'vue'
import { message, Modal, Popconfirm, Select } from 'ant-design-vue'
import {
  PauseCircle,
  PlayCircle,
  Plus,
  RotateCw,
  Trash2,
} from 'lucide-vue-next'
import type { TaskRow } from '../../shared/types'
import { matchesFilter, matchesQuery, rowName, rowState, sortRows, SORT_OPTIONS } from '../status'
import { reportRejection, state, taskAction, removeTask } from '../store'
import { fmtSpeed } from '../../shared/format'
import TaskRowView from './TaskRow.vue'

const counts = computed(() => {
  const c = { all: state.rows.length, downloading: 0, paused: 0, done: 0, error: 0 }
  for (const r of state.rows) {
    const st = rowState(r)
    if (st === 'downloading' || st === 'preparing') c.downloading++
    else if (st === 'paused') c.paused++
    else if (st === 'done') c.done++
    else if (st === 'error' || st === 'cancelled') c.error++
  }
  return c
})

const visibleRows = computed(() =>
  sortRows(
    state.rows.filter((r) => matchesFilter(rowState(r) || undefined, state.taskFilter) && matchesQuery(r, state.taskQuery)),
    state.taskSort,
  ),
)

const FILTERS: { key: string; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'downloading', label: '下载中' },
  { key: 'paused', label: '已暂停' },
  { key: 'done', label: '已完成' },
  { key: 'error', label: '失败' },
]

async function onAction(r: TaskRow, action: string): Promise<void> {
  if (action === 'open') {
    // 打开任务所在文件夹：dest 是完整文件路径，取父目录交给系统资源管理器。
    try {
      const why = await window.hh.openDir(dirOf(r.def.dest))
      if (why) message.error(`打不开该文件夹：${why}`)
    } catch (e) {
      reportRejection(e)
    }
    return
  }
  if (action === 'remove') {
    removeWithConfirm(r)
    return
  }
  await taskAction(r.id, action as 'start' | 'pause' | 'resume' | 'retry')
}

function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i > 0 ? p.slice(0, i) : p
}

function removeWithConfirm(r: TaskRow): void {
  Modal.confirm({
    title: `移除「${rowName(r)}」？`,
    content: '任务将从列表移除。磁盘上的文件与断点默认保留（不勾选删除文件时）。',
    okText: '移除任务',
    cancelText: '取消',
    onOk: () => removeTask(r.id, false),
  })
}

function onAll(action: string): void {
  try {
    window.hh.actionAll(action as 'start' | 'pause' | 'clear-finished' | 'retry-failed').then((res) => {
      if (!res.ok) message.error(res.error)
    })
  } catch (e) {
    reportRejection(e)
  }
}

// 选中行跟随最新快照：推送把 snap 换新时列表行自动反映，无需额外代码。
</script>

<template>
  <div class="dl-layout">
    <aside class="dl-side">
      <div class="dl-side-title">下载任务</div>
      <div
        v-for="f in FILTERS"
        :key="f.key"
        class="dl-filter"
        :class="{ active: state.taskFilter === f.key }"
        @click="state.taskFilter = f.key"
      >
        <span>{{ f.label }}</span>
        <span class="cnt">{{ counts[f.key as keyof typeof counts] }}</span>
      </div>
      <div class="dl-spacer"></div>
      <div class="dl-total" v-if="state.totalSpeed > 0">{{ fmtSpeed(state.totalSpeed) }}</div>
    </aside>

    <main class="dl-main">
      <div class="dl-toolbar">
        <input
          v-model="state.taskQuery"
          class="search-input"
          placeholder="搜索文件名 / 链接…"
        />
        <Select
          v-model:value="state.taskSort"
          :options="SORT_OPTIONS"
          size="small"
          style="width: 130px"
        />
        <button class="glass-btn" title="新建下载" @click="state.addDialogOpen = true">
          <Plus :size="16" />
        </button>
        <button class="glass-btn" title="全部开始" @click="onAll('start')">
          <PlayCircle :size="16" />
        </button>
        <button class="glass-btn" title="全部暂停" @click="onAll('pause')">
          <PauseCircle :size="16" />
        </button>
        <button class="glass-btn" title="重试全部失败" @click="onAll('retry-failed')">
          <RotateCw :size="16" />
        </button>
        <Popconfirm title="清空所有已完成任务？" ok-text="清空" cancel-text="取消" @confirm="onAll('clear-finished')">
          <button class="glass-btn" title="清空已完成">
            <Trash2 :size="16" />
          </button>
        </Popconfirm>
      </div>

      <div class="dl-list">
        <TaskRowView
          v-for="r in visibleRows"
          :key="r.id"
          :def="r.def"
          :snap="r.snap"
          :selected="state.selectedId === r.id"
          @select="state.selectedId = r.id"
          @action="onAction(r, $event)"
        />
        <div v-if="visibleRows.length === 0" class="dl-empty">
          {{ state.rows.length === 0 ? '还没有下载任务。点右上角「＋」新建，或从游戏站捕获直链。' : '没有符合条件的任务。' }}
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.dl-layout {
  display: flex;
  gap: 12px;
  flex: 1;
  min-height: 0;
}

.dl-side {
  width: 168px;
  display: flex;
  flex-direction: column;
  padding: 12px;
  overflow-y: auto;
  position: relative;
  background: rgba(255, 255, 255, 0.055);
  backdrop-filter: blur(16px) saturate(1.5);
  -webkit-backdrop-filter: blur(16px) saturate(1.5);
  border: 1px solid rgba(255, 255, 255, 0.11);
  border-radius: 16px;
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.3),
    inset 0 1px 0 rgba(255, 255, 255, 0.16);
}
.dl-side-title {
  font-size: 13px;
  font-weight: 600;
  padding: 4px 10px 10px;
  color: rgba(255, 255, 255, 0.88);
}
.dl-filter {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 10px;
  border-radius: 8px;
  margin-bottom: 2px;
  cursor: pointer;
  color: rgba(255, 255, 255, 0.65);
  font-size: 13px;
  transition: background 0.15s, color 0.15s;
}
.dl-filter:hover { background: rgba(255, 255, 255, 0.08); color: rgba(255, 255, 255, 0.88); }
.dl-filter.active { background: rgba(77, 163, 255, 0.18); color: #7ec3ff; }
.dl-filter .cnt {
  font-size: 11px;
  background: rgba(255, 255, 255, 0.1);
  padding: 1px 7px;
  border-radius: 10px;
}
.dl-spacer { flex: 1; }
.dl-total {
  font-size: 12px;
  color: #7ec3ff;
  text-align: center;
  padding: 8px 0;
  font-family: ui-monospace, Consolas, monospace;
}

.dl-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.dl-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}
.search-input {
  flex: 1;
  height: 32px;
  border-radius: 10px;
  padding: 0 14px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.07);
  color: rgba(255, 255, 255, 0.88);
  font-size: 13px;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.search-input:focus {
  border-color: rgba(77, 163, 255, 0.6);
  box-shadow: 0 0 0 3px rgba(77, 163, 255, 0.15);
}
.glass-btn {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.07);
  color: rgba(255, 255, 255, 0.65);
  cursor: pointer;
  font-size: 14px;
  transition: all 0.15s;
}
.glass-btn:hover { background: rgba(255, 255, 255, 0.14); color: #fff; }
.glass-btn.active { background: rgba(77, 163, 255, 0.2); color: #7ec3ff; }

.dl-list {
  flex: 1;
  overflow-y: auto;
  padding: 2px;
}
.dl-empty {
  text-align: center;
  padding: 80px 20px;
  color: rgba(255, 255, 255, 0.35);
  font-size: 13px;
}
</style>