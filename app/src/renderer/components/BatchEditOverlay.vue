<script setup lang="ts">
/**
 * 批量编辑浮层（G6）：多选模式下悬浮在封面墙底部。
 *  - 收藏切换、快捷分类「已通关」、快捷评分 8/9/10、批量移除
 *  - 操作走 store.batchUpdate/batchRemove（乐观更新 + 失败回滚）
 */
import { computed, onBeforeUnmount } from 'vue'
import { Heart, ListChecks, Star, Trash2, Wand2, X } from 'lucide-vue-next'
import { message } from 'ant-design-vue'
import { batchRemove, batchUpdate, batchScrape, cancelBatchScrape, enterSelectMode, library, resolvePending, startBatchScrape } from '../stores/library'
import { tokens } from '../design/tokens'

const emit = defineEmits<{ done: [] }>()

const starColor = computed(() => tokens.color.star)
const sel = computed(() => library.selection)
const count = computed(() => sel.value.length)

function gameOf(id: string) {
  return library.games.find((g) => g.id === id)
}

/** 切「已通关」：库里每款按自身当前态生成独立 patch（全含则移除，否则添加） */
async function toggleQuickCat(): Promise<void> {
  if (!count.value) return
  const patches = sel.value.map((id) => {
    const g = gameOf(id)
    if (!g) return null
    const has = g.categories.includes('已通关')
    return {
      id,
      patch: { categories: has ? g.categories.filter((c) => c !== '已通关') : [...g.categories, '已通关'] },
    }
  }).filter((p): p is { id: string; patch: { categories: string[] } } => !!p)
  const ok = await batchUpdate(patches)
  message[ok ? 'success' : 'error'](ok ? `已更新 ${patches.length} 款的「已通关」标记` : library.error || '批量更新失败')
  emit('done')
}

/** 切收藏：当前全已收藏 → 全部取消；否则全部收藏 */
async function toggleFav(): Promise<void> {
  if (!count.value) return
  const anyUnfav = sel.value.some((id) => !gameOf(id)?.favorite)
  const ok = await batchUpdate(sel.value.map((id) => ({ id, patch: { favorite: anyUnfav } })))
  message[ok ? 'success' : 'error'](ok ? (anyUnfav ? `已收藏 ${count.value} 款` : `已取消收藏 ${count.value} 款`) : library.error || '批量更新失败')
  emit('done')
}

async function setRating(r: number): Promise<void> {
  if (!count.value) return
  const ok = await batchUpdate(sel.value.map((id) => ({ id, patch: { rating: r } })))
  message[ok ? 'success' : 'error'](ok ? `已为 ${count.value} 款设置评分 ${r.toFixed(1)}` : library.error || '批量更新失败')
  emit('done')
}

async function removeSel(): Promise<void> {
  if (!count.value) return
  const ok = await batchRemove(sel.value)
  message[ok ? 'success' : 'error'](ok ? `已移除 ${count.value} 款` : library.error || '批量移除失败')
  emit('done')
}

/** 批量刮削：串行后台队列；冲突入 pending，不逐个弹窗（P1-1） */
async function runBulkScrape(): Promise<void> {
  if (!count.value || batchScrape.running) return
  const ids = [...sel.value]
  const r = await startBatchScrape(ids)
  if (r.cancelled) message.info(`已取消：完成 ${batchScrape.applied} 款，待确认 ${r.pending}`)
  else {
    const parts = [`已刮削 ${r.applied} 款`]
    if (r.pending) parts.push(`${r.pending} 款待确认`)
    if (r.failed) parts.push(`${r.failed} 款失败`)
    message[r.applied || r.pending ? 'success' : 'warning'](parts.join('，'))
  }
}

function cancelScrape(): void {
  cancelBatchScrape()
}

/** 待确认项：打开单刮对话框（apply 成功后 store 自动从 pending 摘除） */
function confirmPending(item: { id: string; title: string; query: string }): void {
  resolvePending(item)
}

function close(): void {
  if (batchScrape.running) cancelBatchScrape()
  enterSelectMode(false)
  emit('done')
}

onBeforeUnmount(() => {
  if (batchScrape.running) cancelBatchScrape()
})
</script>

<template>
  <div class="batch-overlay" v-if="count > 0">
    <div class="batch-panel glass">
      <span class="batch-count">{{ count }} 款已选</span>
      <template v-if="batchScrape.running">
        <span class="b-scrape-status" data-testid="batch-scrape-status">
          刮削中 {{ batchScrape.done }}/{{ batchScrape.total }}
          <span v-if="batchScrape.current" class="b-scrape-title">{{ batchScrape.current }}</span>
        </span>
        <button class="b-btn danger" title="取消批量刮削" data-testid="batch-scrape-cancel" @click="cancelScrape">取消</button>
        <span class="b-sep"></span>
      </template>
      <template v-else>
        <button
          class="b-btn"
          title="批量刮削：高置信自动应用，冲突待确认"
          data-testid="batch-scrape"
          :disabled="batchScrape.running"
          @click="runBulkScrape"
        >
          <Wand2 :size="14" /> 批量刮削
        </button>
        <span class="b-sep"></span>
      </template>
      <button class="b-btn" title="切换收藏" @click="toggleFav"><Heart :size="14" /> 收藏</button>
      <button class="b-btn" title="加/移除「已通关」" @click="toggleQuickCat"><ListChecks :size="14" /> 已通关</button>
      <span class="b-sep"></span>
      <button class="b-btn" v-for="r in [8, 9, 10]" :key="r" :title="'评分 ' + r.toFixed(1)" @click="setRating(r)">
        <Star :size="12" :fill="starColor" :stroke-width="0" /> {{ r }}
      </button>
      <span class="b-sep"></span>
      <button class="b-btn danger" title="从库移除（不删文件）" @click="removeSel"><Trash2 :size="14" /> 移除</button>
      <button class="b-btn" title="退出多选" @click="close"><X :size="14" /> 退出</button>
    </div>
    <div v-if="!batchScrape.running && batchScrape.pending.length" class="batch-panel glass pending-panel" data-testid="batch-scrape-pending">
      <span class="pending-label">{{ batchScrape.pending.length }} 款待确认</span>
      <button
        v-for="p in batchScrape.pending"
        :key="p.id"
        class="b-btn pending-item"
        :title="'为「' + p.title + '」手动选择刮削结果'"
        @click="confirmPending(p)"
      >
        <Wand2 :size="12" /> {{ p.title }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.batch-overlay {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.batch-panel {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: var(--hh-radius-panel);
}
.batch-count {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--hh-color-text-glow);
  margin-right: 4px;
}
.b-sep {
  width: 1px;
  height: 18px;
  background: var(--hh-color-border-faint);
}
.b-btn {
  height: 30px;
  padding: 0 12px;
  border-radius: var(--hh-radius-sm);
  border: 1px solid var(--hh-color-border-ghost-soft);
  background: var(--hh-color-surface-soft);
  color: var(--hh-color-text-strong);
  font-size: 12.5px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 5px;
  transition: background var(--hh-motion-med);
}
.b-btn:hover {
  background: var(--hh-color-surface-mid);
}
.b-btn.danger {
  color: var(--hh-color-error-text);
  border-color: var(--hh-color-error-soft-bg);
}
.b-btn.danger:hover {
  background: var(--hh-color-error-soft-bg);
}
.b-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.b-scrape-status {
  font-size: 12.5px;
  color: var(--hh-color-text-strong);
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 260px;
  overflow: hidden;
}
.b-scrape-title {
  color: var(--hh-color-text-glow);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.85;
}
.pending-panel {
  margin-top: 8px;
  flex-wrap: wrap;
  max-width: min(720px, 90vw);
}
.pending-label {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--hh-color-text-strong);
}
.pending-item {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
