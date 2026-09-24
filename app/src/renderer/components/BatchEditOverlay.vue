<script setup lang="ts">
/**
 * 批量编辑浮层（G6）：多选模式下悬浮在封面墙底部。
 *  - 收藏切换、快捷分类「已通关」、快捷评分 8/9/10、批量移除
 *  - 操作走 store.batchUpdate/batchRemove（乐观更新 + 失败回滚）
 */
import { computed } from 'vue'
import { Heart, ListChecks, Star, Trash2, X } from 'lucide-vue-next'
import { message } from 'ant-design-vue'
import { batchRemove, batchUpdate, enterSelectMode, library } from '../stores/library'
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
  await batchUpdate(patches)
  message.success(`已更新 ${patches.length} 款的「已通关」标记`)
  emit('done')
}

/** 切收藏：当前全已收藏 → 全部取消；否则全部收藏 */
async function toggleFav(): Promise<void> {
  if (!count.value) return
  const anyUnfav = sel.value.some((id) => !gameOf(id)?.favorite)
  await batchUpdate(sel.value.map((id) => ({ id, patch: { favorite: anyUnfav } })))
  message.success(anyUnfav ? `已收藏 ${count.value} 款` : `已取消收藏 ${count.value} 款`)
  emit('done')
}

async function setRating(r: number): Promise<void> {
  if (!count.value) return
  await batchUpdate(sel.value.map((id) => ({ id, patch: { rating: r } })))
  message.success(`已为 ${count.value} 款设置评分 ${r.toFixed(1)}`)
  emit('done')
}

async function removeSel(): Promise<void> {
  if (!count.value) return
  await batchRemove(sel.value)
  message.success(`已移除 ${count.value} 款`)
  emit('done')
}

function close(): void {
  enterSelectMode(false)
  emit('done')
}
</script>

<template>
  <div class="batch-overlay" v-if="count > 0">
    <div class="batch-panel glass">
      <span class="batch-count">{{ count }} 款已选</span>
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
  </div>
</template>

<style scoped>
.batch-overlay {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
}
.batch-panel {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 14px;
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
  border-radius: 8px;
  border: 1px solid var(--hh-color-border-ghost-soft);
  background: var(--hh-color-surface-soft);
  color: var(--hh-color-text-strong);
  font-size: 12.5px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 5px;
  transition: background 0.15s;
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
</style>
