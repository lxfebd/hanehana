<script setup lang="ts">
import { computed } from 'vue'
import { Star } from 'lucide-vue-next'
import { t } from '../i18n'
import { tokens } from '../design/tokens'
import { type Game } from '../../shared/types'
import { fmtDate, lengthTextOf } from './detailShared'

/**
 * DetailMetaRow.vue —— 详情面板的元数据行（数据来源 / 开发商 / 发售日 / 加入时间 / 时长 / 评分）。
 * 自 DetailPanel.vue 拆出；开发商点选的筛选改为 emit filter，由父面板调 filterByMeta，
 * 与拆分前同一个 store 筛选口径一致。
 */

const props = defineProps<{ game: Game | null }>()
const emit = defineEmits<{ (_e: 'filter', _key: 'series' | 'developer', _value: string): void }>()

/** 选中游戏（父组件 v-else 保证非空；仍按可空处理）。 */
const g = computed(() => props.game)

/** 评分星星色（真值 tokens；reactive，切主题自动刷新） */
const starColor = computed(() => tokens.color.star)

/** 数据来源：sources 第一个 provider 名（vndb/bangumi/ymgal…），无则「—」 */
const sourceText = computed(() => g.value?.sources?.[0]?.provider ?? '')
const releaseText = computed(() => g.value?.releaseDate ?? '')
const addedText = computed(() => (g.value?.addedAt ? fmtDate(g.value.addedAt) : ''))
const ratingText = computed(() => (g.value?.rating ? g.value.rating.toFixed(1) : ''))

/** 平均通关时长：与父面板、简介页共用同一份 lengthTextOf。 */
const lengthText = computed(() => lengthTextOf(g.value))
</script>

<template>
<!-- 元数据行：数据来源 / 开发商 / 发售日 / 加入时间 / 预计时长 / 评分（基准一行摊开） -->
<div v-if="g" class="dp-meta" :aria-label="t('dp_source')">
  <div class="dp-meta-cell">
    <span class="dp-meta-key">{{ t('dp_source') }}</span>
    <span class="dp-meta-val" :title="sourceText || '—'">{{ sourceText || '—' }}</span>
  </div>
  <div class="dp-meta-cell">
    <span class="dp-meta-key">{{ t('dp_developer') }}</span>
    <a
      v-if="g.developer"
      class="dp-meta-val link"
      :title="t('dp_same_dev')"
      @click="emit('filter', 'developer', g.developer)"
      >{{ g.developer }}</a
    >
    <span v-else class="dp-meta-val">—</span>
  </div>
  <div class="dp-meta-cell">
    <span class="dp-meta-key">{{ t('dp_release') }}</span>
    <span class="dp-meta-val" :title="releaseText || '—'">{{ releaseText || '—' }}</span>
  </div>
  <div class="dp-meta-cell">
    <span class="dp-meta-key">{{ t('dp_added') }}</span>
    <span class="dp-meta-val" :title="addedText || '—'">{{ addedText || '—' }}</span>
  </div>
  <div class="dp-meta-cell">
    <span class="dp-meta-key">{{ t('dp_length') }}</span>
    <span class="dp-meta-val" :title="lengthText || '—'">{{ lengthText || '—' }}</span>
  </div>
  <div class="dp-meta-cell">
    <span class="dp-meta-key">{{ t('dp_rating') }}</span>
    <span class="dp-meta-val dp-meta-num" :title="ratingText || '—'">
      <Star v-if="ratingText" :size="11" :fill="starColor" :stroke-width="0" class="dp-meta-star" />
      {{ ratingText || '—' }}
    </span>
  </div>
</div>
</template>

<style scoped>
/* ============ 元数据行（数据来源/开发商/发售日/加入时间/时长/评分） ============ */
.dp-meta {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--hh-space-x2) var(--hh-space-x3);
  padding: var(--hh-space-x2) var(--hh-space-x3);
  background: var(--hh-color-card);
  border: 1px solid var(--hh-color-card-border);
  border-radius: var(--hh-radius-panel);
}
.dp-meta-cell {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.dp-meta-key {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim-strong);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dp-meta-val {
  font-size: var(--hh-font-body-size);
  color: var(--hh-color-text-strong);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 数字要醒目（评分/时长）上一档字号，仍走 token 不硬写 */
.dp-meta-num {
  font-size: var(--hh-font-bodyLg-size);
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--hh-color-text-glow);
}
.dp-meta-star {
  color: var(--hh-color-star);
  flex: none;
}
.link {
  color: var(--hh-color-link);
  cursor: pointer;
  text-decoration: none;
}
.link:hover {
  text-decoration: underline;
}</style>
