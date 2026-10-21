<script setup lang="ts">
/**
 * KPI 条：首屏数据卡横排（总款数 / 总时长 / 今日 / 月度…）。
 *
 * 对标基准 home.png 首屏四卡 + statistics.png 六卡。标签小号灰、数字 26px
 * 粗 tabular（抖动的数字位数变化不会让卡片宽度跳）。卡片走 card 分层
 * （card + cardBorder），深色下层次靠边框不靠投影（投影在黑底上不可见）。
 *
 * 数字格式化在调用方完成（fmtDurMs/fmtSize 属于展示规则，组件不持有）；
 * 组件只负责「标签 + 大数 + 可选副行」的排版。
 */
import type { Component } from 'vue'
import { t, type I18nKey } from '../i18n'

export interface KpiItem {
  /** 标签（i18n 键） */
  key: I18nKey
  /** 已格式化的值（调用方过 fmtDurMs/fmtSize） */
  value: string
  /** 可选图标（lucide 组件） */
  icon?: Component
  /** 可选副行（已插值字符串） */
  sub?: string
}

defineProps<{ items: KpiItem[] }>()
</script>

<template>
  <section class="kpi-strip" aria-label="kpi">
    <article v-for="item in items" :key="item.key" class="kpi-card">
      <div class="kpi-label">
        <component :is="item.icon" v-if="item.icon" :size="15" class="kpi-icon" />
        <span>{{ t(item.key) }}</span>
      </div>
      <div class="kpi-value">{{ item.value }}</div>
      <div v-if="item.sub" class="kpi-sub">{{ item.sub }}</div>
    </article>
  </section>
</template>

<style scoped>
/* 自适应列轨：卡宽 ≥150px 优先单行排满，排不下自动换行——
   数字不允许被裁（"54h 21…" 这种截断在 1280 CSS 宽的窗口里真发生过：
   六列均分只剩 124px 盒子，装不下 130px 的 "62h 35min"）。
   150px 下限 + 8px 间距保证换行前每列盒子 ≥126px，时长串装得下。 */
.kpi-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--hh-space-x2);
  flex: none;
  align-items: stretch;
}

.kpi-card {
  background: var(--hh-color-card);
  border: 1px solid var(--hh-color-card-border);
  border-radius: var(--hh-radius-panel);
  padding: var(--hh-space-x2) var(--hh-space-x3);
  display: flex;
  flex-direction: column;
  gap: var(--hh-space-x1);
  min-width: 0;
}

.kpi-label {
  display: flex;
  align-items: center;
  gap: var(--hh-space-x2);
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-mid);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.kpi-icon {
  color: var(--hh-color-text-soft);
  flex: none;
}

/* 大数：kpi 26px + tabular。数字宽度恒定，切换主题/刷新时卡片不跳。 */
.kpi-value {
  font-size: var(--hh-font-kpi-size);
  line-height: var(--hh-font-kpi-lh);
  font-weight: 700;
  color: var(--hh-color-text-glow);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.kpi-sub {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 窄窗（≤900px 视口，此时 KPI 条约 660px）：退到两列大卡，
   数字宽裕，不触发换行孤儿卡 */
@media (max-width: 900px) {
  .kpi-strip {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
