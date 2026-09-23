<script setup lang="ts">
/**
 * 下载页（REDESIGN-SPEC §5.5）。
 *   - 删除 .dl-side 第二侧栏；单行工具栏：
 *     segmented 状态过滤（带 count）+ 搜索框 + 排序 Select + 总速度 + 按钮组
 *   - 任务行 Motrix 化（见 TaskRow.vue）：高 64、底部绝对进度条、自绘状态 chip
 */
import { computed } from 'vue'
import { message, Modal, Popconfirm, Select } from 'ant-design-vue'
import {
  PauseCircle,
  PlayCircle,
  Plus,
  RotateCw,
  Search,
  Trash2,
} from 'lucide-vue-next'
import type { TaskRow } from '../../shared/types'
import { matchesFilter, matchesQuery, rowName, rowState, sortRows, SORT_OPTIONS } from '../status'
import { downloads, removeTask, reportRejection, taskAction } from '../stores/downloads'
import { library } from '../stores/library'
import { fmtSpeed } from '../../shared/format'
import TaskRowView from './TaskRow.vue'

const counts = computed(() => {
  const c = { all: downloads.rows.length, downloading: 0, paused: 0, done: 0, error: 0 }
  for (const r of downloads.rows) {
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
    downloads.rows.filter((r) => matchesFilter(rowState(r) || undefined, downloads.taskFilter) && matchesQuery(r, downloads.taskQuery)),
    downloads.taskSort,
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
</script>

<template>
  <div class="dl-layout">
    <main class="dl-main">
      <!-- 单行工具栏：segmented 过滤 + 搜索 + 排序 + 总速度 + 按钮组 -->
      <div class="dl-toolbar">
        <div class="seg-filter">
          <button
            v-for="f in FILTERS"
            :key="f.key"
            class="seg-chip"
            :class="{ active: downloads.taskFilter === f.key }"
            @click="downloads.taskFilter = f.key"
          >
            {{ f.label }}<span class="cnt">{{ counts[f.key as keyof typeof counts] }}</span>
          </button>
        </div>

        <div class="search-box">
          <Search :size="14" class="search-ic" />
          <input
            v-model="downloads.taskQuery"
            class="search-input"
            placeholder="搜索文件名 / 链接…"
          />
        </div>

        <Select
          v-model:value="downloads.taskSort"
          :options="SORT_OPTIONS"
          size="small"
          style="width: 120px"
        />

        <span v-if="downloads.totalSpeed > 0" class="total-speed">
          {{ fmtSpeed(downloads.totalSpeed) }}
        </span>
        <div class="dl-btns">
          <button class="dl-btn primary" title="新建下载" @click="downloads.addDialogOpen = true">
            <Plus :size="16" />
          </button>
          <button class="dl-btn" title="全部开始" @click="onAll('start')">
            <PlayCircle :size="16" />
          </button>
          <button class="dl-btn" title="全部暂停" @click="onAll('pause')">
            <PauseCircle :size="16" />
          </button>
          <button class="dl-btn" title="重试全部失败" @click="onAll('retry-failed')">
            <RotateCw :size="16" />
          </button>
          <Popconfirm title="清空所有已完成任务？" ok-text="清空" cancel-text="取消" @confirm="onAll('clear-finished')">
            <button class="dl-btn" title="清空已完成">
              <Trash2 :size="16" />
            </button>
          </Popconfirm>
        </div>
      </div>

      <div class="dl-list">
        <TaskRowView
          v-for="r in visibleRows"
          :key="r.id"
          :def="r.def"
          :snap="r.snap"
          :selected="library.selectedId === r.id"
          @select="library.selectedId = r.id"
          @action="onAction(r, $event)"
        />
        <div v-if="visibleRows.length === 0" class="dl-empty">
          <div class="dl-empty-title">
            {{ downloads.rows.length === 0 ? '还没有下载任务' : '没有符合条件的任务' }}
          </div>
          <div v-if="downloads.rows.length === 0" class="dl-empty-hint">
            点右上角「＋」新建，或从游戏站捕获直链
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.dl-layout {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.dl-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

/* ============ 单行工具栏 ============ */
.dl-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 0;
}
.seg-filter {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 999px;
  background: var(--hh-color-surface-bright);
  border: 1px solid var(--hh-color-card-border);
  flex-shrink: 0;
}
.seg-chip {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 12px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--hh-color-text-mid);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.seg-chip:hover { background: var(--hh-color-surface-mid); color: var(--hh-color-text-glow); }
.seg-chip.active { background: var(--hh-color-accent-chip-bg); color: var(--hh-color-accent-text); }
.seg-chip .cnt {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
}

.search-box {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 160px;
  max-width: 340px;
}
.search-ic {
  position: absolute;
  left: 12px;
  color: var(--hh-color-text-dim);
  pointer-events: none;
}
.search-input {
  width: 100%;
  height: 32px;
  border-radius: 10px;
  padding: 0 12px 0 34px;
  border: 1px solid var(--hh-color-card-border);
  background: var(--hh-color-surface-bright);
  color: var(--hh-color-text-glow);
  font-size: 13px;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.search-input:focus {
  border-color: var(--hh-color-accent-focus-border);
  box-shadow: 0 0 0 3px var(--hh-color-accent-focus-ring);
}

/* ============ 单行工具栏：右端按钮组 ============ */
.total-speed {
  margin-left: auto;
  font-size: 12px;
  color: var(--hh-color-accent-text);
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-variant-numeric: tabular-nums;
}
.dl-btns {
  display: flex;
  gap: 6px;
}
.dl-btn {
  width: 32px; height: 32px;
  border-radius: 9px;
  border: 1px solid var(--hh-color-float-border);
  background: var(--hh-color-panel-glass);
  color: var(--hh-color-text-bright);
  cursor: pointer;
  font-size: 14px;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.15s;
}
.dl-btn:hover { background: var(--hh-color-surface-strong); color: var(--hh-color-on-accent); }
.dl-btn.primary {
  border: none;
  background: var(--hh-color-accent);
  color: var(--hh-color-on-accent);
  box-shadow: 0 4px 14px var(--hh-color-accent-btn-shadow);
}
.dl-btn.primary:hover { background: var(--hh-color-accent-hover); color: var(--hh-color-on-accent); }

/* ============ 列表 ============ */
.dl-list {
  flex: 1;
  overflow-y: auto;
  padding: 2px;
}
.dl-empty {
  text-align: center;
  padding: 60px 20px;
  color: var(--hh-color-text-soft-dim);
}
.dl-empty-title { font-size: 15px; font-weight: 600; margin-bottom: 6px; }
.dl-empty-hint { font-size: 13px; color: var(--hh-color-text-dim); }
</style>
