<script setup lang="ts">
import { computed } from 'vue'
import { library, thumbUrl } from '../stores/library'
import { t } from '../i18n'
import { type Game } from '../../shared/types'

/**
 * DetailSimilar.vue —— 详情面板右栏的相似游戏区。
 * 自 DetailPanel.vue 拆出：similarGames / playWeight / hideImg 及本区域的点击换游戏。
 */

const props = defineProps<{ game: Game | null }>()

/** 选中游戏（父组件 v-else 保证非空；仍按可空处理）。 */
const g = computed(() => props.game)

/**
 * 相似推荐：共享标签 ×2 + 同开发商 ×3 + 同系列 ×2 + 时长权重，按分排序取前 8。
 *
 * 为什么是这几项：库内数据只有标签/开发商/系列能表达「为什么像」——
 * 时长排序会让推荐退化成「大家玩得多的」（本来就见过），
 * 而 galgame 的用户决策链是「同一系列 → 同一会社 → 同类标签」。
 * 时长权重（playWeight）是调味：真玩过的同类更能代表口味，但封顶 3 分。
 * 纯内存计算（library.games 已在内存里），不做主进程查询。
 */
const similarGames = computed<Game[]>(() => {
  const game = g.value
  if (!game) return []
  const tags = new Set(game.tags)
  const series = new Set(game.series ?? [])
  const dev = game.developer ?? ''
  const scored: { game: Game; score: number }[] = []
  for (const other of library.games) {
    if (other.id === game.id) continue
    let score = 0
    for (const tg of other.tags) if (tags.has(tg)) score += 2
    if (dev && other.developer === dev) score += 3
    for (const s of other.series ?? []) if (series.has(s)) score += 2
    if (score > 0) scored.push({ game: other, score: score + playWeight(other.playMs ?? 0) })
  }
  // 同分时按游玩时长降序：同分里先给用户可能更熟的那部
  scored.sort((a, b) => b.score - a.score || (b.game.playMs ?? 0) - (a.game.playMs ?? 0))
  return scored.slice(0, 8).map((s) => s.game)
})

/** 游玩时长权重：log10(1+小时) 封顶 3 分——1h 约 0.9、10h 约 2、100h 约 3。
 *  对数压缩让「打了几百小时的神作」只比「玩了十小时」多 1 分，不会霸榜；
 *  它只是给「真玩过」的同类作品一点点优先，主排序仍是标签/会社/系列。 */
function playWeight(ms: number): number {
  if (!ms || ms <= 0) return 0
  return Math.min(3, Math.log10(1 + ms / 3600000))
}

/** 相似项封面加载失败：隐掉 img，露出底下首字兜底（不卸载，避免布局跳动） */
function hideImg(e: Event): void {
  const el = e.target as HTMLImageElement
  el.style.opacity = '0'
}
</script>

<template>
<!-- 相似游戏：标签/开发商/系列三项加权，点一下就在本面板里换游戏
     （不跳页、不关面板——详情最常用的动作就是「顺着看下一部」） -->
<section class="dp-similar" :aria-label="t('dp_similar')">
  <div class="dp-similar-head">
    <span class="dp-similar-title">{{ t('dp_similar') }}</span>
    <span class="dp-similar-count">{{ similarGames.length }}</span>
  </div>
  <div v-if="similarGames.length" class="dp-similar-grid">
    <button
      v-for="sg in similarGames"
      :key="sg.id"
      class="dp-sim-item"
      type="button"
      :title="sg.title"
      @click="library.selectedId = sg.id"
    >
      <span class="dp-sim-cover">
        <img
          v-if="thumbUrl(sg)"
          :src="thumbUrl(sg)"
          :alt="sg.title"
          class="dp-sim-img"
          loading="lazy"
          @error="hideImg"
        />
        <span class="dp-sim-letter">{{ sg.title.slice(0, 1) }}</span>
      </span>
      <span class="dp-sim-name">{{ sg.title }}</span>
    </button>
  </div>
  <p v-else class="dp-similar-empty">{{ t('dp_similar_empty') }}</p>
</section>
</template>

<style scoped>
/* ============ 相似游戏 ============ */
.dp-similar {
  display: flex;
  flex-direction: column;
  gap: var(--hh-space-x2);
}
.dp-similar-head {
  display: flex;
  align-items: baseline;
  gap: var(--hh-space-x2);
}
.dp-similar-title {
  font-size: var(--hh-font-caption-size);
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--hh-color-text-bright);
}
.dp-similar-count {
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim);
}
.dp-similar-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--hh-space-x2);
}
.dp-sim-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0;
  border: none;
  background: none;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.dp-sim-cover {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: var(--hh-layout-cover-ratio);
  border-radius: var(--hh-radius-sm);
  overflow: hidden;
  background: var(--hh-color-surface-soft);
  transition:
    transform var(--hh-motion-slow) var(--hh-motion-ease-out),
    box-shadow var(--hh-motion-slow) var(--hh-motion-ease-out);
}
.dp-sim-item:hover .dp-sim-cover {
  transform: translateY(-2px) scale(1.02);
}
.dp-sim-item:active .dp-sim-cover {
  transform: scale(0.985);
  transition-duration: var(--hh-motion-fast);
}
.dp-sim-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: opacity var(--hh-motion-fast) var(--hh-motion-ease-fade);
}
.dp-sim-letter {
  font-size: 18px;
  font-weight: 600;
  color: var(--hh-color-text-dim);
}
.dp-sim-name {
  font-size: 11px;
  line-height: 14px;
  color: var(--hh-color-text-mid);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.dp-sim-item:hover .dp-sim-name {
  color: var(--hh-color-text-glow);
}
.dp-similar-empty {
  margin: 0;
  font-size: var(--hh-font-caption-size);
  color: var(--hh-color-text-dim);
}</style>
