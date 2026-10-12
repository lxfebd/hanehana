<script setup lang="ts">
/**
 * 下载页。
 *   - 删除 .dl-side 第二侧栏；单行工具栏：
 *     segmented 状态过滤（带 count）+ 搜索框 + 排序 Select + 总速度 + 按钮组
 *   - 任务行 Motrix 化（见 TaskRow.vue）：高 64、底部绝对进度条、自绘状态 chip
 */
import { computed } from 'vue'
import { message, Modal, Popconfirm, Select } from 'ant-design-vue'
import { RecycleScroller } from 'vue-virtual-scroller'
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css'
import { PauseCircle, PlayCircle, Plus, RotateCw, Search, Trash2, X } from 'lucide-vue-next'
import type { TaskRow } from '../../shared/types'
import { matchesFilter, matchesQuery, rowName, rowState, sortRows, SORT_OPTIONS } from '../status'
import {
  downloads,
  removeTask,
  reportRejection,
  taskAction,
  batchEventVisible,
  clearBatchEvent,
} from '../stores/downloads'
import { refreshGames } from '../stores/library'
import { library } from '../stores/library'
import { dirName, fmtSpeed } from '../../shared/format'
import { t, tf, type I18nKey } from '../i18n'
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
    downloads.rows.filter(
      (r) => matchesFilter(rowState(r) || undefined, downloads.taskFilter) && matchesQuery(r, downloads.taskQuery),
    ),
    downloads.taskSort,
  ),
)

const FILTERS: { key: string; labelKey: I18nKey }[] = [
  { key: 'all', labelKey: 'toolbar_all' },
  { key: 'downloading', labelKey: 'dl_filter_downloading' },
  { key: 'paused', labelKey: 'dl_filter_paused' },
  { key: 'done', labelKey: 'dl_filter_done' },
  { key: 'error', labelKey: 'dl_filter_failed' },
]

/** 排序下拉：SORT_OPTIONS 存 labelKey，渲染时转成当前语言 label。 */
const sortOptions = computed(() => SORT_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) })))

async function onAction(r: TaskRow, action: string): Promise<void> {
  if (action === 'open') {
    try {
      const why = await window.hh.openDir(dirOf(r.def.dest))
      if (why) message.error(tf('dv_open_dir_fail', { why }))
    } catch (e) {
      reportRejection(e)
    }
    return
  }
  if (action === 'ingest') {
    // 下载完成 ≠ 入库：exe 产物在任务行一键进游戏库（主进程按存在性+去重校验）
    try {
      const res = await window.hh.addGameOne(r.def.dest)
      if (res.ok) {
        message.success(tf('dv_ingested', { title: res.game?.title ?? '' }).trim())
        void refreshGames()
      } else {
        message.error(res.error || t('dv_ingest_fail'))
      }
    } catch (e) {
      reportRejection(e)
    }
    return
  }
  if (action === 'openFile') {
    // 打开产物本身：exe 直接跑、压缩包交系统默认程序（下载完就能装/能解压）
    try {
      const res = await window.hh.openTaskFile(r.def.dest)
      if (res && !res.ok && res.error) message.error(res.error)
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

// 打开任务所在目录。与 shared/format.dirName 同源：任务在 Windows 上写盘但
// URL 解析是正斜杠，两种都得认；无分隔符时兜底返回路径本身（打开它）。
function dirOf(p: string): string {
  const d = dirName(p)
  return d || p
}

function removeWithConfirm(r: TaskRow): void {
  Modal.confirm({
    title: `${t('dl_remove_title')}「${rowName(r)}」？`,
    content: t('dl_remove_content'),
    okText: t('dl_remove_task'),
    cancelText: t('common_cancel'),
    onOk: () => removeTask(r.id, false),
  })
}

function onAll(action: string): void {
  try {
    window.hh.actionAll(action as 'start' | 'pause' | 'clear-finished' | 'retry-failed').then(
      (res) => {
        if (!res.ok) message.error(res.error)
      },
      (e: unknown) => {
        reportRejection(e)
      },
    )
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
            {{ t(f.labelKey) }}<span class="cnt">{{ counts[f.key as keyof typeof counts] }}</span>
          </button>
        </div>

        <div class="search-box">
          <Search :size="14" class="search-ic" />
          <input v-model="downloads.taskQuery" class="search-input" :placeholder="t('dl_search_placeholder')" />
        </div>

        <Select v-model:value="downloads.taskSort" :options="sortOptions" size="small" style="width: 120px" />

        <span v-if="downloads.totalSpeed > 0" class="total-speed">
          {{ fmtSpeed(downloads.totalSpeed) }}
        </span>
        <div class="dl-btns">
          <button class="dl-btn primary" :title="t('dl_new')" @click="downloads.addDialogOpen = true">
            <Plus :size="16" />
          </button>
          <button class="dl-btn" :title="t('dl_start_all')" @click="onAll('start')">
            <PlayCircle :size="16" />
          </button>
          <button class="dl-btn" :title="t('dl_pause_all')" @click="onAll('pause')">
            <PauseCircle :size="16" />
          </button>
          <button class="dl-btn" :title="t('dl_retry_failed')" @click="onAll('retry-failed')">
            <RotateCw :size="16" />
          </button>
          <Popconfirm
            :title="t('dl_clear_confirm')"
            :ok-text="t('dl_clear_ok')"
            :cancel-text="t('common_cancel')"
            @confirm="onAll('clear-finished')"
          >
            <button class="dl-btn" :title="t('dl_clear_finished')">
              <Trash2 :size="16" />
            </button>
          </Popconfirm>
        </div>
      </div>

      <!-- 批状态汇总条：有任务刚结束/失败常驻时出现，点击数字切筛选 -->
      <div v-if="batchEventVisible" class="dl-batch" :class="{ 'has-error': counts.error > 0 }">
        <span class="dl-batch-label">{{ t('dl_batch_click_hint') }}</span>
        <button
          v-if="counts.done > 0"
          class="dl-batch-chip"
          :class="{ active: downloads.taskFilter === 'done' }"
          @click="downloads.taskFilter = downloads.taskFilter === 'done' ? 'all' : 'done'"
        >
          {{ counts.done }}{{ t('dl_batch_done') }}
        </button>
        <button
          v-if="counts.error > 0"
          class="dl-batch-chip err"
          :class="{ active: downloads.taskFilter === 'error' }"
          @click="downloads.taskFilter = downloads.taskFilter === 'error' ? 'all' : 'error'"
        >
          {{ counts.error }}{{ t('dl_batch_error') }}
        </button>
        <button
          v-if="counts.paused > 0"
          class="dl-batch-chip"
          :class="{ active: downloads.taskFilter === 'paused' }"
          @click="downloads.taskFilter = downloads.taskFilter === 'paused' ? 'all' : 'paused'"
        >
          {{ counts.paused }}{{ t('dl_batch_paused') }}
        </button>
        <button class="dl-batch-dismiss" :title="t('dl_batch_clear')" @click="clearBatchEvent">
          <X :size="12" />
        </button>
      </div>

      <div class="dl-list">
        <RecycleScroller
          v-if="visibleRows.length > 0"
          class="dl-scroller"
          :items="visibleRows"
          :item-size="72"
          key-field="id"
          :page-mode="false"
          :buffer="200"
        >
          <template #default="{ item: r }">
            <TaskRowView
              :key="r.id"
              :def="r.def"
              :snap="r.snap"
              :selected="library.selectedId === r.id"
              @select="library.selectedId = r.id"
              @action="onAction(r, $event)"
            />
          </template>
        </RecycleScroller>
        <div v-if="visibleRows.length === 0" class="dl-empty">
          <div class="dl-empty-title">
            {{ downloads.rows.length === 0 ? t('dl_empty') : t('dl_no_match') }}
          </div>
          <div v-if="downloads.rows.length === 0" class="dl-empty-hint">
            {{ t('dl_empty_hint') }}
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
  padding: 8px 12px;
  flex-wrap: wrap;
  border-radius: var(--hh-radius-md);
  border: 1px solid var(--hh-color-card-border);
  background: var(--hh-color-surface-bright);
  backdrop-filter: blur(12px) saturate(1.3);
}
.seg-filter {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--hh-radius-pill);
  background: var(--hh-color-surface-bright);
  border: 1px solid var(--hh-color-card-border);
  flex-shrink: 0;
}
/* 窄视口兜底：按钮组与排序可换行，永不横向溢出窗口 */
.dl-toolbar > * {
  flex-shrink: 1;
}
.seg-chip {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 32px;
  padding: 0 12px;
  border: none;
  border-radius: var(--hh-radius-pill);
  background: transparent;
  color: var(--hh-color-text-mid);
  font-size: var(--hh-font-caption-size);
  cursor: pointer;
  transition:
    background var(--hh-motion-med) ease,
    color var(--hh-motion-med) ease;
}
.seg-chip:hover {
  background: var(--hh-color-surface-mid);
  color: var(--hh-color-text-glow);
}
.seg-chip.active {
  background: var(--hh-color-select-bg);
  color: var(--hh-color-select-text);
  font-weight: 600;
}
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
  border-radius: var(--hh-radius-md);
  padding: 0 12px 0 34px;
  border: 1px solid var(--hh-color-card-border);
  background: var(--hh-color-surface-bright);
  color: var(--hh-color-text-glow);
  font-size: var(--hh-font-body-size);
  outline: none;
  transition:
    border-color var(--hh-motion-slow),
    box-shadow var(--hh-motion-slow);
}
.search-input:focus {
  border-color: var(--hh-color-accent-focus-border);
  box-shadow: 0 0 0 3px var(--hh-color-accent-focus-ring);
}

/* ============ 批状态汇总条 ============ */
.dl-batch {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: var(--hh-radius-md);
  border: 1px solid var(--hh-color-card-border);
  background: var(--hh-color-surface-bright);
  font-size: var(--hh-font-caption-size);
}
.dl-batch.has-error {
  border-color: var(--hh-color-error);
  background: var(--hh-color-error-soft-bg);
}
.dl-batch-label {
  color: var(--hh-color-text-tertiary);
}
.dl-batch-chip {
  display: flex;
  align-items: center;
  height: 24px;
  padding: 0 10px;
  border: none;
  border-radius: var(--hh-radius-pill);
  background: var(--hh-color-surface-mid);
  color: var(--hh-color-text-glow);
  font-size: var(--hh-font-caption-size);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition: background var(--hh-motion-med) ease;
}
.dl-batch-chip:hover {
  background: var(--hh-color-select-bg);
  color: var(--hh-color-select-text);
}
.dl-batch-chip.active {
  background: var(--hh-color-select-bg);
  color: var(--hh-color-select-text);
  font-weight: 600;
}
.dl-batch-chip.err {
  color: var(--hh-color-error-text);
}
.dl-batch-chip.err:hover {
  background: var(--hh-color-error-soft-bg);
  color: var(--hh-color-error-text);
}
.dl-batch-dismiss {
  margin-left: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--hh-radius-sm);
  background: transparent;
  color: var(--hh-color-text-tertiary);
  cursor: pointer;
}
.dl-batch-dismiss:hover {
  background: var(--hh-color-surface-mid);
  color: var(--hh-color-text-glow);
}

/* ============ 单行工具栏：右端按钮组 ============ */
.total-speed {
  margin-left: auto;
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-accent-text);
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-variant-numeric: tabular-nums;
}
.dl-btns {
  display: flex;
  gap: 6px;
}
.dl-btn {
  width: 32px;
  height: 32px;
  border-radius: var(--hh-radius-sm);
  border: 1px solid var(--hh-color-card-border);
  background: var(--hh-color-surface-soft);
  color: var(--hh-color-text-bright);
  cursor: pointer;
  font-size: var(--hh-font-bodyLg-size);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--hh-motion-med);
}
.dl-btn:hover {
  background: var(--hh-color-surface-strong);
  color: var(--hh-color-text-glow);
}
.dl-btn.primary {
  border: none;
  background: var(--hh-color-accent);
  color: var(--hh-color-on-accent);
}
.dl-btn.primary:hover {
  background: var(--hh-color-accent-hover);
  color: var(--hh-color-on-accent);
}

/* ============ 列表 ============ */
.dl-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 2px;
}
.dl-scroller {
  height: 100%;
}
.dl-empty {
  text-align: center;
  padding: 60px 20px;
  color: var(--hh-color-text-soft);
}
.dl-empty-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 6px;
  color: var(--hh-color-text-mid);
}
.dl-empty-hint {
  font-size: var(--hh-font-body-size);
  color: var(--hh-color-text-mid);
}
</style>
