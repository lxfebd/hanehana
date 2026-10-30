<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Search, X } from 'lucide-vue-next'
import { t } from '../i18n'
import { type Game } from '../../shared/types'

/**
 * DetailTags.vue —— 详情面板的标签区（标题 / 计数 / 搜索 / 展开合成一行 + chip 一行）。
 * 自 DetailPanel.vue 拆出：tagQuery / tagsExpanded 及其切游戏复位都在本组件内。
 */

const props = defineProps<{ game: Game | null }>()

/** 选中游戏（父组件 v-else 保证非空；仍按可空处理）。 */
const g = computed(() => props.game)

const tagQuery = ref('')
const tagsExpanded = ref(false)
/** 折叠阈值：1 行多一点（360–400px 栏宽中文标签每行 5–7 个）。
 *  旧值 8 = 两行：把曲线推到视口外——右栏的「游玩数据」tab 必须默认
 *  能看到图，标签是次级浏览内容，多一行靠展开按钮要回来。 */
const TAG_COLLAPSED = 6

const filteredTags = computed(() => {
  const all = g.value?.tags ?? []
  const q = tagQuery.value.trim().toLowerCase()
  return q ? all.filter((tag) => tag.toLowerCase().includes(q)) : all
})

const visibleTags = computed(() =>
  tagsExpanded.value ? filteredTags.value : filteredTags.value.slice(0, TAG_COLLAPSED),
)

/** 搜索结果为空时给一句「没有匹配的标签」，而不是一块空白 */
const tagsEmpty = computed(() => filteredTags.value.length === 0)
/** 过滤后仍超出折叠阈值才给展开按钮 */
const tagsOverflow = computed(() => filteredTags.value.length > TAG_COLLAPSED)

/** 切游戏复位：搜索词清空、收起（拆分前写在父组件的 watch(g) 里）。 */
watch(() => props.game, () => {
  tagQuery.value = ''
  tagsExpanded.value = false
})
</script>

<template>
<!-- 标签区：标题/计数/搜索/展开合成一行 + chip 一行。
     旧版是三行（head、search、chips）+ 独立 toggle 行：右栏每一行
     都是从曲线头上扣的预算，合并后标签区 ~150px → ~74px。 -->
<div v-if="g" class="dp-tags">
  <div class="dp-tags-head">
    <span class="dp-tags-title">{{ t('dp_tags') }}</span>
    <span class="dp-tags-count">{{ filteredTags.length }} / {{ g.tags.length }}</span>
    <div class="dp-tags-search">
      <Search :size="13" class="dp-tags-search-icon" />
      <input
        v-model="tagQuery"
        class="dp-tags-input"
        type="text"
        :placeholder="t('dp_tags_search_ph')"
        :aria-label="t('dp_tags_search_ph')"
      />
      <button
        v-if="tagQuery"
        class="dp-tags-clear"
        type="button"
        :title="t('dp_tags_clear')"
        :aria-label="t('dp_tags_clear')"
        @click="tagQuery = ''"
      >
        <X :size="12" />
      </button>
    </div>
    <button v-if="tagsOverflow" class="dp-tags-toggle" type="button" @click="tagsExpanded = !tagsExpanded">
      {{ tagsExpanded ? t('dp_tags_collapse') : t('dp_tags_expand') }}
    </button>
  </div>
  <div class="dp-tags-chips">
    <span v-for="tag in visibleTags" :key="tag" class="tag-chip" :title="tag">{{ tag }}</span>
    <span v-if="tagsEmpty" class="dp-tags-none">{{ t('dp_tags_none') }}</span>
  </div>
</div>
</template>

<style scoped>
/* ============ 标签区（全集 + 搜索 + 展开） ============ */
.dp-tags {
  display: flex;
  flex-direction: column;
  gap: var(--hh-space-x2);
}
/* head 一行装下：标题 + 计数 + 搜索框（flex 吃掉剩余） + 展开按钮 */
.dp-tags-head {
  display: flex;
  align-items: center;
  gap: var(--hh-space-x2);
}
.dp-tags-title {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim-strong);
}
.dp-tags-count {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim);
  font-variant-numeric: tabular-nums;
}
/* 行内嵌搜索框：并入 head 行，flex 吃掉标题/计数/展开之外的剩余宽度 */
.dp-tags-search {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--hh-space-x2);
  height: 28px;
  padding: 0 var(--hh-space-x2);
  border: 1px solid var(--hh-color-border-ghost-soft);
  border-radius: var(--hh-radius-sm);
  background: var(--hh-color-surface-soft);
  color: var(--hh-color-text-mid);
}
.dp-tags-search:focus-within {
  border-color: var(--hh-color-accent-selected-border);
  background: var(--hh-color-surface-hover-soft);
}
.dp-tags-search-icon {
  flex: none;
}
.dp-tags-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--hh-color-text-glow);
  font-size: var(--hh-font-caption-size);
  font-family: inherit;
}
.dp-tags-input::placeholder {
  color: var(--hh-color-text-dim);
}
.dp-tags-clear {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: var(--hh-radius-xs);
  background: var(--hh-color-surface-hover);
  color: var(--hh-color-text-mid);
  cursor: pointer;
  padding: 0;
}
.dp-tags-clear:hover {
  background: var(--hh-color-surface-strong);
  color: var(--hh-color-text-glow);
}
.dp-tags-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tag-chip {
  font-size: 11px;
  padding: 3px 9px;
  border-radius: var(--hh-radius-xs);
  background: var(--hh-color-accent-bg);
  color: var(--hh-color-accent-text);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dp-tags-none {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim);
}
.dp-tags-toggle {
  flex: none;
  border: none;
  background: none;
  color: var(--hh-color-accent);
  font-size: var(--hh-font-caption-size);
  cursor: pointer;
  padding: 0;
  white-space: nowrap;
}
.dp-tags-toggle:hover {
  color: var(--hh-color-accent-hover);
}
</style>
