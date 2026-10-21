<script setup lang="ts">
/**
 * 页头（面包屑 + 页面大标题 + 右侧操作槽）。
 *
 * 基准 ReinaManager 每一页都有这一行（面包屑 + 28px 大标题 + 右上带文字的
 * 主操作）。羽花此前工具栏直接顶到标题栏下，页面「没有名字」——工具区承担
 * 了导航语义，用户要靠猜才知道自己在哪一页。
 *
 * 面包屑只支持文本键（不做可点导航）：当前侧栏一处切换，面包屑是位置标识，
 * 再点一次等于重复侧栏动作；做成死链交互反而误导。点第一段回游戏库是唯一
 * 例外，语义明确且零歧义。
 */
import { computed } from 'vue'
import { ChevronRight } from 'lucide-vue-next'
import { t, type I18nKey } from '../i18n'
import { ui } from '../stores/ui'

const props = defineProps<{
  /** 面包屑（i18n 键，从高到低；末段即当前页，会被标为当前项） */
  crumbs: I18nKey[]
  /** 页面大标题（i18n 键） */
  title: I18nKey
  /** 副标题：已插值好的字符串（如「共 107 款」），不放 keys 是因为文案带计数 */
  subtitle?: string
}>()

/** 最后一段是当前页：不可点、无 hover 态（点了没意义）。 */
const crumbItems = computed(() =>
  props.crumbs.map((key, i) => ({ key, label: t(key), current: i === props.crumbs.length - 1 })),
)

/** 第一段回首页（游戏库）。面包屑第一段固定是 nav_home。 */
function goHome(): void {
  ui.page = 'library'
}
</script>

<template>
  <header class="page-header">
    <nav class="ph-crumb" :aria-label="t('nav_home')">
      <template v-for="(item, i) in crumbItems" :key="item.key">
        <span v-if="i > 0" class="ph-sep" aria-hidden="true"><ChevronRight :size="13" /></span>
        <button v-if="i === 0" class="ph-link" type="button" @click="goHome">{{ item.label }}</button>
        <span v-else-if="item.current" class="ph-current" aria-current="page">{{ item.label }}</span>
        <span v-else class="ph-link">{{ item.label }}</span>
      </template>
    </nav>
    <div class="ph-main">
      <h1 class="ph-title">{{ t(title) }}</h1>
      <p v-if="subtitle" class="ph-sub">{{ subtitle }}</p>
    </div>
    <div v-if="$slots.actions" class="ph-actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: flex-end;
  gap: var(--hh-space-x4);
  flex: none;
  padding: 2px 2px 0;
}

.ph-crumb {
  display: flex;
  align-items: center;
  gap: var(--hh-space-x1);
  align-self: flex-start;
  padding-top: 8px;
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-mid);
}

.ph-sep {
  display: flex;
  align-items: center;
  opacity: 0.6;
}

/* 第一段（首页）可点：唯一有明确返回语义的 crumbs。 */
.ph-link {
  border: none;
  background: transparent;
  padding: 0;
  font: inherit;
  color: var(--hh-color-text-soft);
  cursor: pointer;
  transition: color var(--hh-motion-med);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ph-link:hover {
  color: var(--hh-color-select-text);
}
/* 默认段（非按钮的 .ph-link）不是链接，不给 pointer */
span.ph-link {
  cursor: default;
}

.ph-current {
  color: var(--hh-color-text-bright);
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ph-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

/* 大标题：pageHead 28px。中文长游戏名不会进这里，但中文页名同样要立得住。 */
.ph-title {
  margin: 0;
  font-size: var(--hh-font-pageHead-size);
  line-height: var(--hh-font-pageHead-lh);
  font-weight: 700;
  color: var(--hh-color-text-glow);
  letter-spacing: 0.2px;
  max-width: 460px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ph-sub {
  margin: 0;
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-mid);
}

/* 右侧操作槽：主操作一律图标 + 文字（基准 §0-8），挤不下时允许换行不裁切。 */
.ph-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--hh-space-x2);
  flex-wrap: wrap;
  justify-content: flex-end;
}
</style>
