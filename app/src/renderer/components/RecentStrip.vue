<script setup lang="ts">
/**
 * 最近续读条（对标 gal-launcher aurora 的 queue-card 续读列表）：
 * hero 下方一条横向条，显示最近玩过的游戏（小封面 + 标题 + 上次时间），
 * 点击选中——打开应用不用滚就能看到「上次玩到哪」。纯展示+选中，不写状态。
 */
import { computed } from 'vue'
import type { Game } from '../../shared/types'
import { library, selectGame, thumbUrl } from '../stores/library'
import { t } from '../i18n'

/** 最近玩过的游戏（lastPlayed 倒序，最多 4 款） */
const recent = computed<Game[]>(() =>
  [...library.games]
    .filter((g) => g.lastPlayed && (g.thumbPath || g.coverPath))
    .sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))
    .slice(0, 4),
)

function fmtTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return t('recent_today')
  const diff = Math.floor((now.getTime() - d.getTime()) / 86400000)
  if (diff === 1) return t('recent_yesterday')
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function pick(g: Game): void {
  selectGame(g.id)
}
</script>

<template>
  <div v-if="recent.length" class="recent-strip">
    <span class="recent-label">{{ t('recent_continue') }}</span>
    <div class="recent-scroll">
      <button
        v-for="g in recent"
        :key="g.id"
        class="recent-item"
        :class="{ selected: library.selectedId === g.id }"
        :title="g.title"
        @click="pick(g)"
      >
        <span class="recent-thumb">
          <img v-if="thumbUrl(g)" :src="thumbUrl(g)" :alt="g.title" loading="lazy" />
        </span>
        <span class="recent-body">
          <span class="recent-title">{{ g.title }}</span>
          <span class="recent-time">{{ fmtTime(g.lastPlayed) }}</span>
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 续读条：窄横条，左标签 + 横向滚动项。高度 64px，不挤封面墙太多。 */
.recent-strip {
  display: flex;
  align-items: center;
  gap: 14px;
  flex: none;
  padding: 0 4px;
  min-height: 0;
}
.recent-label {
  font-size: var(--hh-font-caption-size);
  letter-spacing: 0.12em;
  color: var(--hh-color-text-dim-strong);
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
}
.recent-scroll {
  display: flex;
  gap: 10px;
  overflow-x: auto;
  scrollbar-width: none;
  min-width: 0;
  flex: 1;
}
.recent-scroll::-webkit-scrollbar {
  display: none;
}
.recent-item {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  max-width: 240px;
  padding: 5px 10px 5px 5px;
  border: 1px solid transparent;
  border-radius: var(--hh-radius-md);
  background: transparent;
  cursor: pointer;
  transition:
    background var(--hh-motion-med) ease,
    border-color var(--hh-motion-med) ease;
  text-align: left;
}
.recent-item:hover {
  background: var(--hh-color-surface-soft);
}
.recent-item.selected {
  background: var(--hh-color-accent-selected-bg);
  border-color: var(--hh-color-accent-ring);
}
.recent-thumb {
  width: 32px;
  height: 46px;
  border-radius: var(--hh-radius-xs);
  overflow: hidden;
  flex-shrink: 0;
  box-shadow: 0 3px 8px var(--hh-color-thumb-shadow-soft);
}
.recent-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.recent-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.recent-title {
  font-size: var(--hh-font-body-size);
  font-weight: 600;
  color: var(--hh-color-text-glow);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 150px;
}
.recent-time {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-muted);
}
@media (max-width: 720px) {
  .recent-label {
    display: none;
  }
}
</style>
