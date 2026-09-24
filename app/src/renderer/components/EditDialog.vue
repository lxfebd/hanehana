<script setup lang="ts">
/**
 * 手动编辑单游戏信息（G7）。
 *  - 覆盖 title/titleNative/description/releaseDate/rating/tags/categories
 *  - 保存时标记 manualEdit=true：刮削不再覆盖用户手填字段（scraper.ts 里读它）
 *  - 弹窗内用 antd Input/InputNumber/Select（tags 用 mode=tags）
 */
import { ref, watch } from 'vue'
import { Input, InputNumber, Modal, Select } from 'ant-design-vue'
import { library, saveManualEdit } from '../stores/library'
import type { Game } from '../../shared/types'

const open = defineModel<boolean>('open')

const title = ref('')
const titleNative = ref('')
const description = ref('')
const releaseDate = ref('')
const rating = ref<number | undefined>(undefined)
const tags = ref<string[]>([])
const categories = ref<string[]>([])

const target = ref<Game | null>(null)

watch(open, (v) => {
  if (!v) return
  target.value = library.games.find((g) => g.id === library.editTargetId) ?? null
  if (!target.value) return
  title.value = target.value.title
  titleNative.value = target.value.titleNative ?? ''
  description.value = target.value.description ?? ''
  releaseDate.value = target.value.releaseDate ?? ''
  rating.value = target.value.rating ?? undefined
  tags.value = [...target.value.tags]
  categories.value = [...target.value.categories]
})

async function save(): Promise<void> {
  const g = target.value
  if (!g) return
  const patch: Partial<Game> = {
    title: title.value.trim() || g.title,
    titleNative: titleNative.value.trim(),
    description: description.value.trim(),
    releaseDate: releaseDate.value.trim(),
    rating: rating.value ?? undefined,
    tags: tags.value.map((t) => t.trim()).filter(Boolean),
    categories: categories.value.map((c) => c.trim()).filter(Boolean),
  }
  const ok = await saveManualEdit(g.id, patch)
  if (ok) open.value = false
}
</script>

<template>
  <Modal v-model:open="open" :footer="null" width="560" :centered="true" title="编辑游戏信息">
    <div class="edit-body">
      <label class="field">
        <span class="label">标题</span>
        <Input v-model:value="title" placeholder="主标题" />
      </label>
      <label class="field">
        <span class="label">原文名</span>
        <Input v-model:value="titleNative" placeholder="日文原名（可选）" />
      </label>
      <label class="field">
        <span class="label">发行日期</span>
        <Input v-model:value="releaseDate" placeholder="yyyy-mm-dd（可选）" />
      </label>
      <label class="field">
        <span class="label">评分</span>
        <InputNumber v-model:value="rating" :min="0" :max="10" :step="0.1" :precision="1" style="width: 120px" />
      </label>
      <label class="field">
        <span class="label">标签</span>
        <Select v-model:value="tags" mode="tags" placeholder="回车添加标签" :open="false" />
      </label>
      <label class="field">
        <span class="label">分类</span>
        <Select v-model:value="categories" mode="tags" placeholder="回车添加分类" :open="false" />
      </label>
      <label class="field">
        <span class="label">简介</span>
        <Input.TextArea v-model:value="description" :rows="4" placeholder="游戏简介（可选）" />
      </label>
      <div class="actions">
        <button class="btn ghost" @click="open = false">取消</button>
        <button class="btn primary" @click="save">保存</button>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.edit-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-top: 4px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.label {
  font-size: 12.5px;
  color: var(--hh-color-text-dim-strong);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}
.btn {
  height: 34px;
  padding: 0 18px;
  border-radius: 9px;
  font-size: 13px;
  cursor: pointer;
  border: none;
}
.btn.primary {
  background-image: var(--hh-color-accent-grad);
  color: var(--hh-color-on-accent);
  font-weight: 600;
}
.btn.ghost {
  background: var(--hh-color-surface-soft);
  border: 1px solid var(--hh-color-border-ghost-soft);
  color: var(--hh-color-text-strong);
}
</style>
