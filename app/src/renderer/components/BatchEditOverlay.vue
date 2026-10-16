<script setup lang="ts">
/**
 * 批量编辑浮层（G6）：多选模式下悬浮在封面墙底部。
 *  - 收藏切换、快捷分类「已通关」、快捷评分 8/9/10、批量移除
 *  - 操作走 store.batchUpdate/batchRemove（乐观更新 + 失败回滚）
 */
import { computed, onBeforeUnmount } from 'vue'
import { Heart, ListChecks, Star, Trash2, Wand2, X } from 'lucide-vue-next'
import { message, Modal } from 'ant-design-vue'
import {
  batchRemove,
  batchUpdate,
  batchScrape,
  cancelBatchScrape,
  enterSelectMode,
  library,
  resolvePending,
  startBatchScrape,
} from '../stores/library'
import { tokens } from '../design/tokens'
import { t, tf } from '../i18n'

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
  const patches = sel.value
    .map((id) => {
      const g = gameOf(id)
      if (!g) return null
      const has = g.categories.includes('已通关')
      return {
        id,
        patch: { categories: has ? g.categories.filter((c) => c !== '已通关') : [...g.categories, '已通关'] },
      }
    })
    .filter((p): p is { id: string; patch: { categories: string[] } } => !!p)
  const ok = await batchUpdate(patches)
  message[ok ? 'success' : 'error'](
    ok ? tf('batch_clear_updated', { n: patches.length }) : library.error || t('batch_update_fail'),
  )
  emit('done')
}

/** 切收藏：当前全已收藏 → 全部取消；否则全部收藏 */
async function toggleFav(): Promise<void> {
  if (!count.value) return
  const anyUnfav = sel.value.some((id) => !gameOf(id)?.favorite)
  const ok = await batchUpdate(sel.value.map((id) => ({ id, patch: { favorite: anyUnfav } })))
  message[ok ? 'success' : 'error'](
    ok
      ? anyUnfav
        ? tf('batch_faved', { n: count.value })
        : tf('batch_unfaved', { n: count.value })
      : library.error || t('batch_update_fail'),
  )
  emit('done')
}

async function setRating(r: number): Promise<void> {
  if (!count.value) return
  const ok = await batchUpdate(sel.value.map((id) => ({ id, patch: { rating: r } })))
  message[ok ? 'success' : 'error'](
    ok ? tf('batch_rated', { n: count.value, rating: r.toFixed(1) }) : library.error || t('batch_update_fail'),
  )
  emit('done')
}

async function removeSel(): Promise<void> {
  if (!count.value) return
  // 批量移除是破坏性操作（从库中删除 + 运行时状态一起走），确认一次再执行；
  // 收藏/评分可逆，这里不拦。
  const n = count.value
  Modal.confirm({
    title: tf('batch_remove_confirm_title', { n }),
    content: t('batch_remove_confirm_content'),
    okText: t('batch_remove_ok'),
    cancelText: t('common_cancel'),
    okButtonProps: { danger: true },
    onOk: async () => {
      const ok = await batchRemove(sel.value)
      message[ok ? 'success' : 'error'](
        ok ? tf('batch_removed', { n: count.value }) : library.error || t('batch_remove_fail'),
      )
      emit('done')
    },
  })
}

/** 批量刮削：串行后台队列；冲突入 pending，不逐个弹窗（P1-1） */
async function runBulkScrape(): Promise<void> {
  if (!count.value || batchScrape.running) return
  const ids = [...sel.value]
  const r = await startBatchScrape(ids)
  if (r.cancelled) message.info(tf('batch_cancelled', { done: batchScrape.applied, pending: r.pending }))
  else {
    const parts = [tf('batch_scraped', { n: r.applied })]
    if (r.pending) parts.push(tf('batch_pending', { n: r.pending }))
    // 「没找到」与「失败」分开报：前者多半是目录名太野/库里没收录，
    // 说成失败用户只会觉得「功能坏了」，实际该去改标题或手动搜。
    if (r.notfound) parts.push(tf('batch_notfound', { n: r.notfound }))
    if (r.failed) parts.push(tf('batch_failed', { n: r.failed }))
    message[r.applied || r.pending ? 'success' : r.notfound && !r.failed ? 'info' : 'warning'](parts.join('，'))
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
  // 无论刮削是否在跑，退出多选都要清掉 pending「待确认」残留——否则 overlay
  // 的 v-if（含 pending.length）仍为真，陈旧面板滞留到下次操作。
  cancelBatchScrape()
  enterSelectMode(false)
  emit('done')
}

onBeforeUnmount(() => {
  cancelBatchScrape()
})
</script>

<template>
  <div class="batch-overlay" v-if="count > 0 || batchScrape.running || batchScrape.pending.length > 0">
    <div class="batch-panel glass">
      <span class="batch-count" v-if="count > 0">{{ tf('batch_selected', { n: count }) }}</span>
      <template v-if="batchScrape.running">
        <span class="b-scrape-status" data-testid="batch-scrape-status">
          {{ tf('batch_scraping', { done: batchScrape.done, total: batchScrape.total }) }}
          <span v-if="batchScrape.current" class="b-scrape-title">{{ batchScrape.current }}</span>
        </span>
        <button
          class="b-btn danger"
          :title="t('batch_cancel_scrape')"
          data-testid="batch-scrape-cancel"
          @click="cancelScrape"
        >
          {{ t('common_cancel') }}
        </button>
        <span class="b-sep"></span>
      </template>
      <template v-else>
        <button
          class="b-btn"
          :title="t('batch_scrape_title')"
          data-testid="batch-scrape"
          :disabled="batchScrape.running"
          @click="runBulkScrape"
        >
          <Wand2 :size="14" /> {{ t('batch_scrape') }}
        </button>
        <span class="b-sep"></span>
      </template>
      <button class="b-btn" :title="t('batch_toggle_fav')" @click="toggleFav">
        <Heart :size="14" /> {{ t('detail_fav') }}
      </button>
      <button class="b-btn" :title="t('batch_toggle_clear')" @click="toggleQuickCat">
        <ListChecks :size="14" /> {{ t('batch_cleared') }}
      </button>
      <span class="b-sep"></span>
      <button
        class="b-btn"
        v-for="r in [8, 9, 10]"
        :key="r"
        :title="tf('batch_rate', { r: r.toFixed(1) })"
        @click="setRating(r)"
      >
        <Star :size="12" :fill="starColor" :stroke-width="0" /> {{ r }}
      </button>
      <span class="b-sep"></span>
      <button class="b-btn danger" :title="t('batch_remove_title')" @click="removeSel">
        <Trash2 :size="14" /> {{ t('batch_remove') }}
      </button>
      <button class="b-btn" :title="t('batch_exit_multi')" @click="close">
        <X :size="14" /> {{ t('batch_exit') }}
      </button>
    </div>
    <div
      v-if="!batchScrape.running && batchScrape.pending.length"
      class="batch-panel glass pending-panel"
      data-testid="batch-scrape-pending"
    >
      <span class="pending-label">{{ tf('batch_pending', { n: batchScrape.pending.length }) }}</span>
      <button
        v-for="p in batchScrape.pending"
        :key="p.id"
        class="b-btn pending-item"
        :title="tf('batch_pick_title', { title: p.title })"
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
  /* 溢出根因：主面板此前没有这两条。窗口一窄，一排 9 个按钮被 flex 硬压，
     按钮缩到比文字窄 → 文字竖排 + 溢出面板外（实测截图：批量刮削四字竖着出框）。
     max-width 与 overlay 的对齐方式配合（overlay 用 translateX(-50%) 居中），
     flex-wrap 让按钮在窄窗口自动换行成两行，而不是互相挤压。 */
  flex-wrap: wrap;
  max-width: min(720px, 92vw);
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
  /* 按钮不许被 flex 压窄、文字不许拆行：一压就竖排出框（实测长相）。
     窄窗口的解法是整只按钮换行（父级 flex-wrap），不是把按钮挤扁。 */
  flex: none;
  white-space: nowrap;
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
